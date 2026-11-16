import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  makeFwaiGatewayConfig,
  makeRelayUrlConfig,
  resolveRelayClientTracingConfig,
} from "./publicConfig.ts";

const provideEnv = (env: Readonly<Record<string, string>>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

it.effect("rejects an insecure runtime relay URL override", () =>
  makeRelayUrlConfig("https://embedded.example.test").pipe(
    provideEnv({ T3CODE_RELAY_URL: "http://runtime.example.test" }),
    Effect.flip,
  ),
);

it.effect("defaults the fwai gateway to the build-time values", () =>
  Effect.gen(function* () {
    const config = yield* makeFwaiGatewayConfig({
      gatewayUrlFallback: "https://gateway.example.test/",
      clientIdFallback: "fwai-embedded",
    }).pipe(provideEnv({}));
    assert.deepEqual(config, {
      gatewayUrl: "https://gateway.example.test",
      clientId: "fwai-embedded",
    });
  }),
);

it.effect("prefers runtime fwai gateway overrides", () =>
  Effect.gen(function* () {
    const config = yield* makeFwaiGatewayConfig().pipe(
      provideEnv({
        T3CODE_FWAI_GATEWAY_URL: "http://127.0.0.1:8080",
        T3CODE_FWAI_CLIENT_ID: " fwai-dev ",
      }),
    );
    assert.deepEqual(config, { gatewayUrl: "http://127.0.0.1:8080", clientId: "fwai-dev" });
  }),
);

it.effect("rejects malformed or insecure fwai gateway URLs", () =>
  Effect.gen(function* () {
    for (const value of ["api.fwai.space", "http://api.fwai.space", "ftp://api.fwai.space"]) {
      const result = yield* makeFwaiGatewayConfig().pipe(
        provideEnv({ T3CODE_FWAI_GATEWAY_URL: value }),
        Effect.result,
      );
      assert.isTrue(Result.isFailure(result), value);
    }
  }),
);

it("product opt-out disables relay tracing with either built-in or runtime credentials", () => {
  const fallback = {
    tracesUrl: "https://embedded.example.test/v1/traces",
    tracesDataset: "embedded-dataset",
    tracesToken: "embedded-token",
  };
  const env = {
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_OTEL_SDK_DISABLED: "false",
  };

  assert.equal(resolveRelayClientTracingConfig(env, fallback), null);
  assert.equal(
    resolveRelayClientTracingConfig(
      {
        ...env,
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://runtime.example.test/v1/traces",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "runtime-dataset",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "runtime-token",
      },
      fallback,
    ),
    null,
  );
});
