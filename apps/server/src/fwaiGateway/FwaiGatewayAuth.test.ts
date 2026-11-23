import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
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
