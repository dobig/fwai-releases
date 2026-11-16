import * as FwaiGateway from "@t3tools/shared/fwaiGateway";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { fwaiGatewayConfig } from "./publicConfig.ts";

const CLOUD_CLI_OAUTH_TOKEN_SECRET = "cloud-cli-oauth-token";
const CLOUD_CLI_OAUTH_REFRESH_EARLY_MS = Duration.toMillis(Duration.minutes(5));
// RFC 8628 default, used only when the gateway omits the field.
const DEVICE_AUTHORIZATION_DEFAULT_INTERVAL = Duration.seconds(5);
// RFC 8628 §3.5: a slow_down response means "add 5 seconds to the interval".
const DEVICE_AUTHORIZATION_SLOW_DOWN_INCREMENT = Duration.seconds(5);

// `gatewayUrl` scopes a credential to the gateway that issued it; credentials
// without it (from before fwai accounts) fail to decode and read as signed out.
const PersistedToken = Schema.Struct({
  gatewayUrl: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  /** Null when the access token does not expire. */
  expiresAtEpochMs: Schema.NullOr(Schema.Number),
});
export type PersistedToken = typeof PersistedToken.Type;

const PersistedTokenJson = Schema.fromJsonString(PersistedToken);
const decodePersistedToken = Schema.decodeUnknownOption(PersistedTokenJson);
const encodePersistedToken = Schema.encodeEffect(PersistedTokenJson);

export class CloudCliCredentialRemovalError extends Schema.TaggedError<CloudCliCredentialRemovalError>()(
  "CloudCliCredentialRemovalError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not remove the stored fwai Connect CLI credential.";
  }
}

export class CloudCliCredentialRefreshError extends Schema.TaggedError<CloudCliCredentialRefreshError>()(
  "CloudCliCredentialRefreshError",
  {
    cause: Schema.Defect(),
    permanent: Schema.optional(Schema.Boolean),
  },
) {
  get requiresLogin(): boolean {
    return this.permanent === true;
  }

  override get message(): string {
    return this.requiresLogin
      ? "The fwai Connect CLI credential is no longer valid. Run `fwai connect login` to authorize again."
      : "Could not refresh the fwai Connect CLI credential.";
  }
}

export const isCloudCliCredentialRefreshError = Schema.is(CloudCliCredentialRefreshError);

export class CloudCliCredentialReadError extends Schema.TaggedError<CloudCliCredentialReadError>()(
  "CloudCliCredentialReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the stored fwai Connect CLI credential.";
  }
}

export class CloudCliAuthorizationError extends Schema.TaggedError<CloudCliAuthorizationError>()(
  "CloudCliAuthorizationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not authorize the fwai Connect CLI.";
  }
}

export class CloudCliAuthorizationTimeoutError extends Schema.TaggedError<CloudCliAuthorizationTimeoutError>()(
  "CloudCliAuthorizationTimeoutError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Timed out waiting for fwai Connect authorization.";
  }
}

export class CloudCliAuthorizationDeniedError extends Schema.TaggedError<CloudCliAuthorizationDeniedError>()(
  "CloudCliAuthorizationDeniedError",
  {},
) {
  override get message(): string {
    return "fwai Connect authorization was denied in the browser.";
  }
}

export const CloudCliTokenManagerError = Schema.Union([
  CloudCliCredentialRemovalError,
  CloudCliCredentialRefreshError,
  CloudCliCredentialReadError,
  CloudCliAuthorizationError,
  CloudCliAuthorizationTimeoutError,
  CloudCliAuthorizationDeniedError,
]);
export type CloudCliTokenManagerError = typeof CloudCliTokenManagerError.Type;
const isCloudCliTokenManagerError = Schema.is(CloudCliTokenManagerError);

export class CloudCliTokenManager extends Context.Service<
  CloudCliTokenManager,
  {
    /** The stored credential, refreshed when needed, or a new one from the device flow. */
    readonly get: Effect.Effect<PersistedToken, CloudCliTokenManagerError>;
    readonly getExisting: Effect.Effect<Option.Option<PersistedToken>, CloudCliTokenManagerError>;
    readonly hasCredential: Effect.Effect<boolean, CloudCliTokenManagerError>;
    readonly clear: Effect.Effect<void, CloudCliTokenManagerError>;
  }
>()("t3/cloud/CliTokenManager/CloudCliTokenManager") {}

const toPersistedToken = Effect.fn("cloud.cli_token.to_persisted_token")(function* (
  config: FwaiGateway.FwaiGatewayConfig,
  token: FwaiGateway.FwaiGatewayTokenResponse,
) {
  const now = yield* Clock.currentTimeMillis;
  return {
    gatewayUrl: config.gatewayUrl,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAtEpochMs: token.expires_in > 0 ? now + token.expires_in * 1_000 : null,
  } satisfies PersistedToken;
});

function formatDeviceAuthorizationPrompt(authorization: FwaiGateway.FwaiGatewayDeviceCode) {
  const minutes = Math.max(1, Math.round(authorization.expires_in / 60));
  return [
    "Sign in to fwai on a device with a browser:",
    `  ${authorization.verification_uri_complete ?? authorization.verification_uri}`,
    "",
    `Confirm this code when asked: ${authorization.user_code}`,
    "",
    `Waiting for approval (expires in ${minutes} min). Press Ctrl+C to cancel.`,
  ].join("\n");
}

const isRetryablePollFailure = (error: FwaiGateway.FwaiGatewayError) =>
  error.status === undefined || error.status >= 500;

const pollDeviceToken = Effect.fn("cloud.cli_token.poll_device_token")(function* (
  config: FwaiGateway.FwaiGatewayConfig,
  deviceCode: string,
  initialInterval: Duration.Duration,
) {
  let interval = initialInterval;
  while (true) {
    yield* Effect.sleep(interval);
    const poll = yield* FwaiGateway.pollDeviceToken(config, deviceCode).pipe(Effect.result);
    if (poll._tag === "Success") {
      if (poll.success._tag === "Token") return poll.success.token;
      if (poll.success._tag === "SlowDown") {
        interval = Duration.sum(interval, DEVICE_AUTHORIZATION_SLOW_DOWN_INCREMENT);
      }
      continue;
    }
    const failure = poll.failure;
    // Keep polling through outages while the code is valid, backing off per RFC 8628 §3.5.
    if (isRetryablePollFailure(failure)) {
      interval = Duration.sum(interval, DEVICE_AUTHORIZATION_SLOW_DOWN_INCREMENT);
      continue;
    }
    switch (failure.code) {
      case "access_denied":
        return yield* new CloudCliAuthorizationDeniedError();
      case "expired_token":
        return yield* new CloudCliAuthorizationTimeoutError({ cause: failure });
      default:
        return yield* new CloudCliAuthorizationError({ cause: failure });
    }
  }
});

const deviceAuthorizationLogin = Effect.fn("cloud.cli_token.device_authorization_login")(function* (
  config: FwaiGateway.FwaiGatewayConfig,
) {
  const device: FwaiGateway.FwaiDeviceInfo = {
    deviceName: yield* HostProcess.Hostname,
    platform: yield* HostProcess.Platform,
    appVersion: packageJson.version,
  };
  const authorization = yield* FwaiGateway.requestDeviceCode(config, device);
  yield* Console.log(formatDeviceAuthorizationPrompt(authorization));
  const interval =
    authorization.interval === undefined
      ? DEVICE_AUTHORIZATION_DEFAULT_INTERVAL
      : Duration.seconds(authorization.interval);
  const expiresIn = Duration.seconds(authorization.expires_in);
  const token = yield* pollDeviceToken(config, authorization.device_code, interval).pipe(
    Effect.timeoutOrElse({
      duration: expiresIn,
      orElse: () =>
        Effect.fail(new CloudCliAuthorizationTimeoutError({ cause: "device code expired" })),
    }),
  );
  return yield* toPersistedToken(config, token);
});

// The device token response names no user, so introspection is only used to warn
// early when the account cannot use fwai; the relay enforces the same check.
const reportFwaiAccess = Effect.fn("cloud.cli_token.report_fwai_access")(function* (
  config: FwaiGateway.FwaiGatewayConfig,
  accessToken: string,
) {
  const introspection = yield* FwaiGateway.introspect(config, accessToken).pipe(
    Effect.tapError((cause) =>
      Effect.logDebug("Could not verify fwai access after sign-in.", { cause }),
    ),
    Effect.option,
  );
  if (Option.isSome(introspection) && !FwaiGateway.introspectionAllowsFwai(introspection.value)) {
    yield* Console.warn(
      "This account does not have fwai access yet. The relay will refuse remote access until it is granted.",
    );
  }
});

/** @public */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const semaphore = yield* Semaphore.make(1);

  const persist = Effect.fn("cloud.cli_token.persist")(function* (token: PersistedToken) {
    const encoded = yield* encodePersistedToken(token);
    yield* secrets.set(CLOUD_CLI_OAUTH_TOKEN_SECRET, new TextEncoder().encode(encoded));
    return token;
  });

  const clear = secrets
    .remove(CLOUD_CLI_OAUTH_TOKEN_SECRET)
    .pipe(Effect.mapError((cause) => new CloudCliCredentialRemovalError({ cause })));

  const read = Effect.fn("cloud.cli_token.read")(function* (config: FwaiGateway.FwaiGatewayConfig) {
    const encoded = yield* secrets.get(CLOUD_CLI_OAUTH_TOKEN_SECRET);
    return Option.flatMap(encoded, (value) =>
      decodePersistedToken(new TextDecoder().decode(value)),
    ).pipe(Option.filter((token) => token.gatewayUrl === config.gatewayUrl));
  });

  const refresh = Effect.fn("cloud.cli_token.refresh")(function* (
    config: FwaiGateway.FwaiGatewayConfig,
    token: PersistedToken,
  ) {
    const refreshed = yield* FwaiGateway.refresh(config, token.refreshToken).pipe(
      Effect.mapError(
        (cause) =>
          new CloudCliCredentialRefreshError({
            cause,
            permanent: FwaiGateway.isPermanentFwaiRefreshFailure(cause),
          }),
      ),
    );
    return yield* toPersistedToken(config, refreshed);
  });

  const getExistingNoLock = Effect.fn("cloud.cli_token.get_existing_no_lock")(function* (
    config: FwaiGateway.FwaiGatewayConfig,
  ) {
    const token = yield* read(config);
    if (Option.isNone(token) || token.value.expiresAtEpochMs === null) return token;
    const now = yield* Clock.currentTimeMillis;
    if (token.value.expiresAtEpochMs - CLOUD_CLI_OAUTH_REFRESH_EARLY_MS > now) {
      return token;
    }
    return Option.some(
      // The refresh token rotates on use, so the new one must be stored even if
      // shutdown interrupts us. The gateway request times out on its own.
      yield* refresh(config, token.value).pipe(Effect.flatMap(persist), Effect.uninterruptible),
    );
  });

  const getExisting = semaphore.withPermits(1)(
    Effect.gen(function* () {
      return yield* getExistingNoLock(yield* fwaiGatewayConfig);
    }).pipe(
      Effect.mapError((cause) =>
        isCloudCliCredentialRefreshError(cause)
          ? cause
          : new CloudCliCredentialRefreshError({ cause }),
      ),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ),
  );

  const hasCredential = semaphore.withPermits(1)(
    Effect.gen(function* () {
      return Option.isSome(yield* read(yield* fwaiGatewayConfig));
    }).pipe(Effect.mapError((cause) => new CloudCliCredentialReadError({ cause }))),
  );

  const get = semaphore.withPermits(1)(
    Effect.gen(function* () {
      const config = yield* fwaiGatewayConfig;
      const existing = yield* getExistingNoLock(config).pipe(
        Effect.catch(() =>
          Console.log(
            "The stored fwai Connect credential could not be refreshed; signing in again.",
          ).pipe(Effect.as(Option.none<PersistedToken>())),
        ),
      );
      if (Option.isSome(existing)) return existing.value;
      const token = yield* persist(yield* deviceAuthorizationLogin(config));
      yield* reportFwaiAccess(config, token.accessToken);
      return token;
    }).pipe(
      Effect.mapError((cause) =>
        isCloudCliTokenManagerError(cause) ? cause : new CloudCliAuthorizationError({ cause }),
      ),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ),
  );

  return CloudCliTokenManager.of({ get, getExisting, hasCredential, clear });
});

export const layer = Layer.effect(CloudCliTokenManager, make);
