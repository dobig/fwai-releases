import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as FwaiGatewayAuth from "./FwaiGatewayAuth.ts";

const SECRET = "fwai-gateway-routing-token";

const storeToken = (expiresAtEpochMs: number | null) =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* secrets.set(
      SECRET,
      new TextEncoder().encode(
        JSON.stringify({
          gatewayUrl: "https://api.fwai.space",
          accessToken: "old-access",
          refreshToken: "single-use-refresh",
          expiresAtEpochMs,
          username: "zr",
        }),
      ),
    );
  });

const harness = (respond: (refreshToken: string) => Response) => {
  const refreshTokens: string[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      assert.equal(request.url, "https://api.fwai.space/oauth/token");
      if (request.body._tag !== "Uint8Array") throw new Error("Missing refresh body");
      const body = JSON.parse(new TextDecoder().decode(request.body.body));
      refreshTokens.push(body.refresh_token);
      return HttpClientResponse.fromWeb(request, respond(body.refresh_token));
    }),
  );
  const layer = FwaiGatewayAuth.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(
      Layer.mock(Settings.ServerSettingsService)({
        updateSettings: () => Effect.die("unused"),
      }),
    ),
  );
  return { refreshTokens, layer };
};

const provideStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      ServerSecretStore.layer.pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "fwai-gateway-auth-test-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

it.effect("refreshes a token close to expiry and keeps the rotated refresh token", () =>
  provideStore(
    Effect.gen(function* () {
      yield* storeToken(60_000);
      const h = harness(() =>
        Response.json({
          token_type: "Bearer",
          access_token: "new-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        }),
      );
      const auth = yield* Effect.service(FwaiGatewayAuth.FwaiGatewayAuth).pipe(
        Effect.provide(h.layer),
      );
      assert.equal(yield* auth.accessToken, "new-access");
      // A second read uses the stored token instead of spending the refresh token again.
      assert.equal(yield* auth.accessToken, "new-access");
      assert.deepEqual(h.refreshTokens, ["single-use-refresh"]);
    }),
  ),
);

it.effect("connects as the fwai_environment client, not the account client", () =>
  provideStore(
    Effect.gen(function* () {
      const clientIds: Array<[string, unknown]> = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          const body =
            request.body._tag === "Uint8Array"
              ? JSON.parse(new TextDecoder().decode(request.body.body))
              : {};
          clientIds.push([path, body.client_id]);
          const reply =
            path === "/oauth/device/code"
              ? Response.json({
                  device_code: "device-1",
                  user_code: "ABCD-EFGH",
                  verification_uri: "https://api.fwai.space/device",
                  expires_in: 600,
                  interval: 1,
                })
              : path === "/oauth/token"
                ? Response.json({
                    token_type: "Bearer",
                    access_token: "env-access",
                    refresh_token: "env-refresh",
                    expires_in: 3600,
                  })
                : new Response(null, { status: 500 });
          return HttpClientResponse.fromWeb(request, reply);
        }),
      );
      const layer = FwaiGatewayAuth.layer.pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
        Layer.provide(
          Layer.mock(Settings.ServerSettingsService)({
            updateSettings: () => Effect.die("unused"),
          }),
        ),
      );
      // The pending sign-in lives in the layer's scope, so the whole flow runs inside it.
      yield* Effect.gen(function* () {
        const auth = yield* FwaiGatewayAuth.FwaiGatewayAuth;
        assert.deepEqual(yield* auth.connect, { userCode: "ABCD-EFGH" });
        yield* TestClock.adjust("1 second");
        yield* auth.state.pipe(
          Stream.filter((state) => state.status === "connected"),
          Stream.take(1),
          Stream.runDrain,
        );
        assert.equal(yield* auth.accessToken, "env-access");
      }).pipe(Effect.provide(layer));
      assert.deepEqual(
        clientIds.filter(([path]) => path.startsWith("/oauth/")),
        [
          ["/oauth/device/code", "fwai_environment"],
          ["/oauth/token", "fwai_environment"],
        ],
      );
    }),
  ),
);

it.effect("ends the session when the gateway revokes the refresh token", () =>
  provideStore(
    Effect.gen(function* () {
      yield* storeToken(0);
      const h = harness(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
      const auth = yield* Effect.service(FwaiGatewayAuth.FwaiGatewayAuth).pipe(
        Effect.provide(h.layer),
      );
      const failure = yield* Effect.flip(auth.accessToken);
      assert.equal(failure.reason, "refresh-failed");
      const state = yield* auth.state.pipe(Stream.take(1), Stream.runHead);
      assert.deepEqual(state._tag === "Some" ? state.value.status : undefined, "error");
      const again = yield* Effect.flip(auth.accessToken);
      assert.equal(again.reason, "signed-out");
    }),
  ),
);
