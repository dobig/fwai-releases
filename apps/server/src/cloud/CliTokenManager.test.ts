import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  makeFakeFwaiGateway,
  type FakeFwaiGatewayReply,
  type FakeFwaiGatewayRequest,
} from "@t3tools/shared/testing/fwaiGatewayFake";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CliTokenManager from "./CliTokenManager.ts";

const GATEWAY_URL = "https://gateway.example.test";
const TOKEN_SECRET = "cloud-cli-oauth-token";

type Reply = FakeFwaiGatewayReply | "transport-error";

const oauthError = (error: string, status = 400): Reply => ({ status, body: { error } });
const tokenReply = (suffix: string, expiresIn = 3600): Reply => ({
  status: 200,
  body: {
    token_type: "Bearer",
    access_token: `access-${suffix}`,
    refresh_token: `refresh-${suffix}`,
    expires_in: expiresIn,
  },
});

const deviceCode = (overrides: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: {
    device_code: "device-code-1",
    user_code: "BCDF-GHJK",
    verification_uri: `${GATEWAY_URL}/device`,
    verification_uri_complete: `${GATEWAY_URL}/device?user_code=BCDF-GHJK`,
    expires_in: 600,
    interval: 5,
    ...overrides,
  },
});

const isDevicePoll = (request: FakeFwaiGatewayRequest) =>
  request.path === "/oauth/token" &&
  (request.body as { readonly grant_type?: string } | undefined)?.grant_type !== "refresh_token";

function makeGateway(input: {
  readonly deviceCode?: Reply;
  readonly polls?: ReadonlyArray<Reply>;
  readonly refreshes?: ReadonlyArray<Reply>;
  readonly introspect?: Reply;
}) {
  const polls = [...(input.polls ?? [])];
  const refreshes = [...(input.refreshes ?? [])];
  const next = (queue: Array<Reply>) =>
    (queue.length > 1 ? queue.shift() : queue[0]) ?? oauthError("unexpected_request");
  return makeFakeFwaiGateway((request) => {
    if (request.path === "/oauth/device/code") return input.deviceCode ?? deviceCode();
    if (request.path === "/v1/auth/introspect") return input.introspect ?? { status: 404 };
    if (request.path === "/oauth/token")
      return isDevicePoll(request) ? next(polls) : next(refreshes);
    return { status: 404 };
  });
}

function makeSecrets(initial?: unknown) {
  const values = new Map<string, Uint8Array>();
  if (initial !== undefined) {
    values.set(TOKEN_SECRET, new TextEncoder().encode(JSON.stringify(initial)));
  }
  const layer = Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  });
  const stored = () => {
    const value = values.get(TOKEN_SECRET);
    return value === undefined ? undefined : JSON.parse(new TextDecoder().decode(value));
  };
  return { layer, stored };
}

function captureConsole() {
  const lines: Array<{ readonly method: "log" | "warn"; readonly text: string }> = [];
  const console: Console.Console = {
    ...globalThis.console,
    log: (...args) => void lines.push({ method: "log", text: args.join(" ") }),
    warn: (...args) => void lines.push({ method: "warn", text: args.join(" ") }),
  };
  return { lines, console };
}

const provideManager =
  (
    gateway: Layer.Layer<HttpClient.HttpClient>,
    secrets: Layer.Layer<ServerSecretStore.ServerSecretStore>,
    console = captureConsole().console,
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(
        CliTokenManager.layer.pipe(
          Layer.provide(Layer.mergeAll(gateway, secrets)),
          Layer.provideMerge(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { T3CODE_FWAI_GATEWAY_URL: GATEWAY_URL, T3CODE_FWAI_CLIENT_ID: "fwai" },
              }),
            ),
          ),
        ),
      ),
      Effect.provideService(HostProcess.Hostname, "devbox"),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(Console.Console, console),
    );

const startLogin = Effect.gen(function* () {
  const manager = yield* CliTokenManager.CloudCliTokenManager;
  return yield* manager.get.pipe(Effect.forkChild);
});

const startFailingLogin = Effect.gen(function* () {
  const manager = yield* CliTokenManager.CloudCliTokenManager;
  return yield* manager.get.pipe(Effect.flip, Effect.forkChild);
});

it.effect("signs in with the device flow, honoring pending and slow_down intervals", () => {
  const gateway = makeGateway({
    polls: [
      oauthError("authorization_pending"),
      oauthError("slow_down"),
      oauthError("authorization_pending"),
      tokenReply("1"),
    ],
  });
  const secrets = makeSecrets();
  const output = captureConsole();
  const pollCount = () => gateway.requests.filter(isDevicePoll).length;
  return Effect.gen(function* () {
    const fiber = yield* startLogin;
    yield* TestClock.adjust(Duration.seconds(5));
    assert.equal(pollCount(), 1);
    yield* TestClock.adjust(Duration.seconds(5));
    assert.equal(pollCount(), 2, "pending keeps the 5s interval");
    yield* TestClock.adjust(Duration.seconds(5));
    assert.equal(pollCount(), 2, "slow_down raises the interval to 10s");
    yield* TestClock.adjust(Duration.seconds(5));
    assert.equal(pollCount(), 3);
    yield* TestClock.adjust(Duration.seconds(10));
    const token = yield* Fiber.join(fiber);

    assert.deepEqual(gateway.requests[0], {
      method: "POST",
      path: "/oauth/device/code",
      authorization: undefined,
      body: {
        client_id: "fwai",
        device_name: "devbox",
        platform: "linux",
        app_version: packageJson.version,
      },
    });
    for (const poll of gateway.requests.filter(isDevicePoll)) {
      assert.deepEqual(poll.body, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: "device-code-1",
        client_id: "fwai",
      });
    }
    const expected = {
      gatewayUrl: GATEWAY_URL,
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAtEpochMs: 30_000 + 3_600_000,
    };
    assert.deepEqual(token, expected);
    assert.deepEqual(secrets.stored(), expected);

    const prompt = output.lines.find((line) => line.method === "log")?.text ?? "";
    assert.include(prompt, `${GATEWAY_URL}/device?user_code=BCDF-GHJK`);
    assert.include(prompt, "BCDF-GHJK");
    assert.include(prompt, "expires in 10 min");
    assert.isFalse(
      output.lines.some((line) => line.method === "warn"),
      "an unavailable introspection endpoint does not warn",
    );

    const manager = yield* CliTokenManager.CloudCliTokenManager;
    const requestsBefore = gateway.requests.length;
    assert.deepEqual(yield* manager.get, expected);
    assert.equal(gateway.requests.length, requestsBefore, "a stored token is reused");
  }).pipe(provideManager(gateway.layer, secrets.layer, output.console));
});

it.effect("warns after sign-in when the account has no fwai access", () => {
  const gateway = makeGateway({
    polls: [tokenReply("1")],
    introspect: {
      status: 200,
      body: { active: true, sub: "user-1", fwai_access: { allowed: false } },
    },
  });
  const output = captureConsole();
  return Effect.gen(function* () {
    const fiber = yield* startLogin;
    yield* TestClock.adjust(Duration.seconds(5));
    yield* Fiber.join(fiber);
    const introspection = gateway.requests.find(
      (request) => request.path === "/v1/auth/introspect",
    );
    assert.equal(introspection?.authorization, "Bearer access-1");
    assert.isTrue(
      output.lines.some((line) => line.method === "warn" && line.text.includes("fwai access")),
    );
  }).pipe(provideManager(gateway.layer, makeSecrets().layer, output.console));
});

it.effect("stores a non-expiring device token without an expiry", () => {
  const gateway = makeGateway({ polls: [tokenReply("1", 0)] });
  const secrets = makeSecrets();
  return Effect.gen(function* () {
    const fiber = yield* startLogin;
    yield* TestClock.adjust(Duration.seconds(5));
    const token = yield* Fiber.join(fiber);
    assert.isNull(token.expiresAtEpochMs);
    assert.isNull(secrets.stored().expiresAtEpochMs);
  }).pipe(provideManager(gateway.layer, secrets.layer));
});

it.effect("defaults to a 5s interval and fails with a denied error on access_denied", () => {
  const gateway = makeGateway({
    deviceCode: deviceCode({ interval: undefined }),
    polls: [oauthError("access_denied")],
  });
  const secrets = makeSecrets();
  return Effect.gen(function* () {
    const fiber = yield* startFailingLogin;
    yield* TestClock.adjust(Duration.seconds(4));
    assert.lengthOf(gateway.requests.filter(isDevicePoll), 0);
    yield* TestClock.adjust(Duration.seconds(1));
    const error = yield* Fiber.join(fiber);
    assert.instanceOf(error, CliTokenManager.CloudCliAuthorizationDeniedError);
    assert.lengthOf(gateway.requests.filter(isDevicePoll), 1);
    assert.isUndefined(secrets.stored());
  }).pipe(provideManager(gateway.layer, secrets.layer));
});

it.effect.each([
  { reply: oauthError("expired_token"), tag: "CloudCliAuthorizationTimeoutError" },
  { reply: oauthError("invalid_client", 401), tag: "CloudCliAuthorizationError" },
])("maps a terminal device poll failure to $tag", ({ reply, tag }) => {
  const gateway = makeGateway({ polls: [reply] });
  return Effect.gen(function* () {
    const fiber = yield* startFailingLogin;
    yield* TestClock.adjust(Duration.seconds(5));
    assert.equal((yield* Fiber.join(fiber))._tag, tag);
  }).pipe(provideManager(gateway.layer, makeSecrets().layer));
});

it.effect("keeps polling through outages, backing off each time", () => {
  const gateway = makeGateway({
    polls: ["transport-error", oauthError("server_error", 503), tokenReply("1")],
  });
  const pollCount = () => gateway.requests.filter(isDevicePoll).length;
  return Effect.gen(function* () {
    const fiber = yield* startLogin;
    yield* TestClock.adjust(Duration.seconds(5));
    assert.equal(pollCount(), 1);
    yield* TestClock.adjust(Duration.seconds(9));
    assert.equal(pollCount(), 1, "an unreachable gateway raises the interval to 10s");
    yield* TestClock.adjust(Duration.seconds(1));
    assert.equal(pollCount(), 2);
    yield* TestClock.adjust(Duration.seconds(15));
    assert.equal((yield* Fiber.join(fiber)).accessToken, "access-1");
  }).pipe(provideManager(gateway.layer, makeSecrets().layer));
});

it.effect("gives up when the device code expires", () => {
  const gateway = makeGateway({
    deviceCode: deviceCode({ expires_in: 12 }),
    polls: [oauthError("authorization_pending")],
  });
  return Effect.gen(function* () {
    const fiber = yield* startFailingLogin;
    yield* TestClock.adjust(Duration.seconds(12));
    const error = yield* Fiber.join(fiber);
    assert.instanceOf(error, CliTokenManager.CloudCliAuthorizationTimeoutError);
    assert.lengthOf(gateway.requests.filter(isDevicePoll), 2);
  }).pipe(provideManager(gateway.layer, makeSecrets().layer));
});

const storedToken = (overrides: Record<string, unknown> = {}) => ({
  gatewayUrl: GATEWAY_URL,
  accessToken: "access-0",
  refreshToken: "refresh-0",
  expiresAtEpochMs: 0,
  ...overrides,
});

it.effect("refreshes once for concurrent callers and uses the rotated refresh token next", () => {
  const gateway = makeGateway({ refreshes: [tokenReply("1"), tokenReply("2")] });
  const secrets = makeSecrets(storedToken());
  const refreshTokensSent = () =>
    gateway.requests
      .filter((request) => !isDevicePoll(request))
      .map((request) => (request.body as { readonly refresh_token: string }).refresh_token);
  return Effect.gen(function* () {
    const manager = yield* CliTokenManager.CloudCliTokenManager;
    const [first, second] = yield* Effect.all([manager.getExisting, manager.getExisting], {
      concurrency: "unbounded",
    });
    assert.equal(Option.getOrThrow(first).accessToken, "access-1");
    assert.equal(Option.getOrThrow(second).accessToken, "access-1");
    assert.deepEqual(refreshTokensSent(), ["refresh-0"]);
    assert.equal(secrets.stored().refreshToken, "refresh-1");
    assert.deepEqual(gateway.requests[0]?.body, {
      grant_type: "refresh_token",
      refresh_token: "refresh-0",
    });

    yield* TestClock.adjust(Duration.minutes(56));
    assert.equal(Option.getOrThrow(yield* manager.getExisting).accessToken, "access-2");
    assert.deepEqual(refreshTokensSent(), ["refresh-0", "refresh-1"]);
    assert.equal(secrets.stored().refreshToken, "refresh-2");
  }).pipe(provideManager(gateway.layer, secrets.layer));
});

it.effect("never refreshes a non-expiring token", () => {
  const gateway = makeGateway({});
  return Effect.gen(function* () {
    const manager = yield* CliTokenManager.CloudCliTokenManager;
    yield* TestClock.adjust(Duration.days(365));
    const token = yield* manager.getExisting;
    assert.equal(Option.getOrThrow(token).accessToken, "access-0");
    assert.lengthOf(gateway.requests, 0);
  }).pipe(
    provideManager(gateway.layer, makeSecrets(storedToken({ expiresAtEpochMs: null })).layer),
  );
});

it.effect.each([
  {
    name: "a rejected refresh token",
    reply: oauthError("invalid_grant", 401),
    requiresLogin: true,
  },
  { name: "a gateway outage", reply: oauthError("server_error", 503), requiresLogin: false },
  { name: "rate limiting", reply: oauthError("too_many_requests", 429), requiresLogin: false },
  { name: "an unreachable gateway", reply: "transport-error" as const, requiresLogin: false },
])("refresh failure from $name sets requiresLogin=$requiresLogin", ({ reply, requiresLogin }) => {
  const gateway = makeGateway({ refreshes: [reply] });
  return Effect.gen(function* () {
    const manager = yield* CliTokenManager.CloudCliTokenManager;
    const error = yield* manager.getExisting.pipe(Effect.flip);
    assert.instanceOf(error, CliTokenManager.CloudCliCredentialRefreshError);
    assert.equal(error.requiresLogin, requiresLogin);
    assert.equal(error.message.includes("fwai connect login"), requiresLogin);
    assert.isTrue(yield* manager.hasCredential);
  }).pipe(provideManager(gateway.layer, makeSecrets(storedToken()).layer));
});

it.effect.each([
  {
    name: "a pre-fwai credential",
    stored: { accessToken: "a", refreshToken: "r", expiresAtEpochMs: 0 },
  },
  {
    name: "another gateway's credential",
    stored: storedToken({ gatewayUrl: "https://other.test" }),
  },
])("treats $name as signed out", ({ stored }) => {
  const gateway = makeGateway({});
  return Effect.gen(function* () {
    const manager = yield* CliTokenManager.CloudCliTokenManager;
    assert.isFalse(yield* manager.hasCredential);
    assert.isTrue(Option.isNone(yield* manager.getExisting));
    assert.lengthOf(gateway.requests, 0);
  }).pipe(provideManager(gateway.layer, makeSecrets(stored).layer));
});

it.effect(
  "persists rotated credentials under the lock despite shutdown, while queued callers can cancel",
  () =>
    Effect.gen(function* () {
      const requestStarted = yield* Deferred.make<void>();
      const releaseRequest = yield* Deferred.make<void>();
      const persistStarted = yield* Deferred.make<void>();
      const releasePersist = yield* Deferred.make<void>();
      let stored = new TextEncoder().encode(JSON.stringify(storedToken()));
      let reads = 0;
      const httpClient = HttpClient.make((request) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(requestStarted, undefined);
          yield* Deferred.await(releaseRequest);
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              token_type: "Bearer",
              access_token: "rotated-access",
              refresh_token: "rotated-refresh",
              expires_in: 3600,
            }),
          );
        }),
      );
      const secrets = Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: () =>
          Effect.sync(() => {
            reads++;
            return Option.some(stored);
          }),
        set: (_name, value) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(persistStarted, undefined);
            yield* Deferred.await(releasePersist);
            stored = new Uint8Array(value);
          }),
      });

      yield* Effect.gen(function* () {
        const manager = yield* CliTokenManager.CloudCliTokenManager;
        const refresh = yield* manager.getExisting.pipe(Effect.forkChild);
        assert.isTrue(
          yield* Effect.raceFirst(
            Deferred.await(requestStarted).pipe(Effect.as(true)),
            Fiber.await(refresh).pipe(Effect.as(false)),
          ),
          "refresh failed before reaching the gateway",
        );
        const waiter = yield* manager.getExisting.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Fiber.interrupt(waiter);
        assert.equal(reads, 1, "queued caller must not read credentials during refresh");
        const interruption = yield* Fiber.interrupt(refresh).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(releaseRequest, undefined);
        const reachedPersist = yield* Effect.raceFirst(
          Deferred.await(persistStarted).pipe(Effect.as(true)),
          Fiber.await(refresh).pipe(Effect.as(false)),
        );
        assert.isTrue(reachedPersist, "shutdown discarded the rotated credential");
        const reader = yield* manager.getExisting.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        assert.equal(reads, 1, "credential lock must cover persistence");
        yield* Deferred.succeed(releasePersist, undefined);
        yield* Fiber.join(interruption);
        const token = Option.getOrThrow(yield* Fiber.join(reader));
        assert.equal(token.refreshToken, "rotated-refresh");
        assert.equal(token.accessToken, "rotated-access");
      }).pipe(
        Effect.ensuring(Deferred.succeed(releaseRequest, undefined)),
        Effect.ensuring(Deferred.succeed(releasePersist, undefined)),
        provideManager(Layer.succeed(HttpClient.HttpClient, httpClient), secrets),
      );
    }),
);
