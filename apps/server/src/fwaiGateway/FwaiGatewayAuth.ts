import {
  type FwaiGatewayConnectResult,
  type FwaiGatewayConnectionState,
  FwaiGatewayRpcError,
} from "@t3tools/contracts";
import * as FwaiGateway from "@t3tools/shared/fwaiGateway";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import packageJson from "../../package.json" with { type: "json" };
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { fwaiGatewayConfig } from "../cloud/publicConfig.ts";
import * as Settings from "../serverSettings.ts";

// Separate from the fwai Connect CLI credential: signing out of one must not end the other.
const TOKEN_SECRET = "fwai-gateway-routing-token";
const REFRESH_EARLY_MS = Duration.toMillis(Duration.minutes(5));
const DEFAULT_POLL_INTERVAL = Duration.seconds(5);
const SLOW_DOWN_INCREMENT = Duration.seconds(5);

const PersistedToken = Schema.Struct({
  gatewayUrl: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAtEpochMs: Schema.NullOr(Schema.Number),
  username: Schema.NullOr(Schema.String),
});
type PersistedToken = typeof PersistedToken.Type;
const encodeToken = Schema.encodeSync(Schema.fromJsonString(PersistedToken));
const decodeToken = Schema.decodeUnknownOption(Schema.fromJsonString(PersistedToken));

export class FwaiGatewayTokenUnavailableError extends Schema.TaggedError<FwaiGatewayTokenUnavailableError>()(
  "FwaiGatewayTokenUnavailableError",
  {
    reason: Schema.Literals(["signed-out", "refresh-failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.reason === "signed-out"
      ? "fwai Gateway is not connected on this environment."
      : "The fwai Gateway session could not be refreshed.";
  }
}

export class FwaiGatewayAuth extends Context.Service<
  FwaiGatewayAuth,
  {
    /** The current state, then every change. */
    readonly state: Stream.Stream<FwaiGatewayConnectionState>;
    /**
     * Starts a device sign-in and returns its code. The client that asked approves it with its own
     * signed-in account, so the user never signs in twice; the state stream reports the outcome.
     */
    readonly connect: Effect.Effect<FwaiGatewayConnectResult, FwaiGatewayRpcError>;
    /** Revokes the session and turns routing off, so no CLI keeps asking for a token. */
    readonly disconnect: Effect.Effect<void, FwaiGatewayRpcError>;
    /** A valid access token for the CLIs, refreshed when close to expiry. */
    readonly accessToken: Effect.Effect<string, FwaiGatewayTokenUnavailableError>;
  }
>()("t3/fwaiGateway/FwaiGatewayAuth") {}

const isGatewayError = Schema.is(FwaiGateway.FwaiGatewayError);
const isTokenUnavailable = Schema.is(FwaiGatewayTokenUnavailableError);
const describe = (cause: unknown) =>
  isGatewayError(cause)
    ? FwaiGateway.describeFwaiSignInError(cause)
    : "Could not reach fwai Gateway. Try again.";

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* Settings.ServerSettingsService;
  const lock = yield* Semaphore.make(1);
  const pending = yield* FiberHandle.make<void, never>();

  const withHttp = Effect.provideService(HttpClient.HttpClient, httpClient);

  const read = Effect.fn("FwaiGatewayAuth.read")(function* () {
    const config = yield* fwaiGatewayConfig;
    const bytes = yield* secrets.get(TOKEN_SECRET).pipe(Effect.orElseSucceed(() => Option.none()));
    return Option.flatMap(bytes, (value) => decodeToken(new TextDecoder().decode(value))).pipe(
      Option.filter((token) => token.gatewayUrl === config.gatewayUrl),
    );
  });

  const persist = (token: PersistedToken) =>
    secrets.set(TOKEN_SECRET, new TextEncoder().encode(encodeToken(token)));

  const toPersisted = Effect.fn("FwaiGatewayAuth.toPersisted")(function* (
    gatewayUrl: string,
    response: FwaiGateway.FwaiGatewayTokenResponse,
    username: string | null,
  ) {
    const now = yield* Clock.currentTimeMillis;
    return {
      gatewayUrl,
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAtEpochMs: response.expires_in > 0 ? now + response.expires_in * 1_000 : null,
      username,
    } satisfies PersistedToken;
  });

  const initial = yield* read().pipe(Effect.orElseSucceed(() => Option.none<PersistedToken>()));
  const state = yield* SubscriptionRef.make<FwaiGatewayConnectionState>(
    Option.match(initial, {
      onNone: () => ({ status: "signed-out" }),
      onSome: (token) => ({ status: "connected", username: token.username }),
    }),
  );

  const awaitApproval = Effect.fn("FwaiGatewayAuth.awaitApproval")(function* (
    config: FwaiGateway.FwaiGatewayConfig,
    device: FwaiGateway.FwaiGatewayDeviceCode,
  ) {
    let interval =
      device.interval === undefined ? DEFAULT_POLL_INTERVAL : Duration.seconds(device.interval);
    const poll = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(interval);
        const result = yield* FwaiGateway.pollDeviceToken(config, device.device_code).pipe(
          Effect.result,
        );
        if (result._tag === "Success") {
          if (result.success._tag === "Token") return result.success.token;
          if (result.success._tag === "SlowDown")
            interval = Duration.sum(interval, SLOW_DOWN_INCREMENT);
          continue;
        }
        // Keep polling through outages while the code is still valid (RFC 8628 §3.5).
        if (result.failure.status === undefined || result.failure.status >= 500) {
          interval = Duration.sum(interval, SLOW_DOWN_INCREMENT);
          continue;
        }
        return yield* result.failure;
      }
    });
    const response = yield* poll.pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(device.expires_in),
        orElse: () =>
          Effect.fail(
            new FwaiGateway.FwaiGatewayError({ operation: "deviceToken", code: "expired_token" }),
          ),
      }),
    );
    const introspection = yield* FwaiGateway.introspect(config, response.access_token).pipe(
      Effect.option,
    );
    const username = Option.getOrNull(
      Option.flatMapNullishOr(introspection, (value) => value.username),
    );
    const token = yield* toPersisted(config.gatewayUrl, response, username);
    yield* lock.withPermits(1)(persist(token));
    yield* SubscriptionRef.set(state, { status: "connected", username });
  });

  const connect = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    if (current.status === "pending") return { userCode: current.userCode };
    const config = yield* fwaiGatewayConfig;
    const device = yield* FwaiGateway.requestDeviceCode(config, {
      deviceName: yield* HostProcess.Hostname,
      platform: yield* HostProcess.Platform,
      appVersion: packageJson.version,
    });
    const now = yield* DateTime.now;
    yield* SubscriptionRef.set(state, {
      status: "pending",
      userCode: device.user_code,
      verificationUrl: device.verification_uri_complete ?? device.verification_uri,
      expiresAt: DateTime.formatIso(DateTime.add(now, { seconds: device.expires_in })),
    });
    yield* FiberHandle.run(
      pending,
      awaitApproval(config, device).pipe(
        withHttp,
        Effect.catch((cause) =>
          SubscriptionRef.set(state, { status: "error", message: describe(cause) }),
        ),
      ),
    );
    return { userCode: device.user_code };
  }).pipe(
    withHttp,
    Effect.mapError((cause) => new FwaiGatewayRpcError({ message: describe(cause) })),
    Effect.withSpan("FwaiGatewayAuth.connect"),
  );

  const disconnect = Effect.gen(function* () {
    yield* FiberHandle.clear(pending);
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const config = yield* fwaiGatewayConfig;
        const token = yield* read();
        if (Option.isSome(token)) {
          yield* FwaiGateway.logout(config, token.value.accessToken).pipe(withHttp, Effect.ignore);
        }
        yield* secrets.remove(TOKEN_SECRET);
      }),
    );
    yield* settings.updateSettings({ fwaiGatewayEnabled: false });
    yield* SubscriptionRef.set(state, { status: "signed-out" });
  }).pipe(
    Effect.mapError(
      () => new FwaiGatewayRpcError({ message: "Could not disconnect fwai Gateway." }),
    ),
    Effect.withSpan("FwaiGatewayAuth.disconnect"),
  );

  const accessToken = lock
    .withPermits(1)(
      Effect.gen(function* () {
        const config = yield* fwaiGatewayConfig;
        const stored = yield* read();
        if (Option.isNone(stored)) {
          return yield* new FwaiGatewayTokenUnavailableError({ reason: "signed-out" });
        }
        const token = stored.value;
        const now = yield* Clock.currentTimeMillis;
        if (token.expiresAtEpochMs === null || token.expiresAtEpochMs - REFRESH_EARLY_MS > now) {
          return token.accessToken;
        }
        const refreshed = yield* FwaiGateway.refresh(config, token.refreshToken).pipe(
          withHttp,
          Effect.tapError((cause) =>
            FwaiGateway.isPermanentFwaiRefreshFailure(cause)
              ? secrets.remove(TOKEN_SECRET).pipe(
                  Effect.ignore,
                  Effect.andThen(
                    SubscriptionRef.set(state, {
                      status: "error",
                      message: "The fwai Gateway session ended. Connect again.",
                    }),
                  ),
                )
              : Effect.void,
          ),
        );
        const next = yield* toPersisted(config.gatewayUrl, refreshed, token.username);
        // The refresh token rotates on use; keep the new one even if we are interrupted.
        yield* persist(next).pipe(Effect.uninterruptible);
        return next.accessToken;
      }),
    )
    .pipe(
      Effect.mapError((cause) =>
        isTokenUnavailable(cause)
          ? cause
          : new FwaiGatewayTokenUnavailableError({ reason: "refresh-failed", cause }),
      ),
      Effect.withSpan("FwaiGatewayAuth.accessToken"),
    );

  return FwaiGatewayAuth.of({
    state: SubscriptionRef.changes(state),
    connect,
    disconnect,
    accessToken,
  });
});

export const layer = Layer.effect(FwaiGatewayAuth, make);
