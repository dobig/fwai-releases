import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import {
  claudeGatewaySettings,
  codexGatewayLaunchArgs,
  withFwaiGatewayProject,
} from "./FwaiGatewayRoute.ts";
import { fwaiGatewayProjectFor } from "./routeEnv.ts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

const route = {
  gatewayUrl: "https://api-staging.fwai.space",
  tokenCommand: "/Applications/fwai's app/fwai",
  tokenArgs: ["/srv/bin.mjs", "__fwai-gateway-token", "/tmp/t3-token-x/s", "env-1"],
};

describe("FwaiGatewayRoute", () => {
  it.effect("gives Claude the gateway endpoint, a quoted key helper and blank stale tokens", () =>
    Effect.gen(function* () {
      const settings = yield* claudeGatewaySettings(route).pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
      );
      expect(settings.env).toEqual({
        ANTHROPIC_BASE_URL: "https://api-staging.fwai.space",
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_API_KEY: "",
      });
      expect(settings.apiKeyHelper).toBe(
        "ELECTRON_RUN_AS_NODE=1 '/Applications/fwai'\\''s app/fwai' '/srv/bin.mjs' '__fwai-gateway-token' '/tmp/t3-token-x/s' 'env-1'",
      );
    }),
  );

  it("defines the Codex gateway provider as one -c override without the WebSocket", () => {
    const args = codexGatewayLaunchArgs(route);
    const [flag, value] = tokenizeCliArgs(args);
    expect(flag).toBe("-c");
    expect(value).toBe(
      `model_providers.fwai_gateway={name="fwai Gateway",base_url="https://api-staging.fwai.space/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,env_http_headers={"X-FWAI-Project"="T3CODE_FWAI_GATEWAY_PROJECT"},auth={command="/Applications/fwai's app/fwai",args=["/srv/bin.mjs","__fwai-gateway-token","/tmp/t3-token-x/s","env-1"],timeout_ms=80000,refresh_interval_ms=0}}`,
    );
  });

  it("sends a thread's own quota project ahead of the environment default", () => {
    const environment = { T3CODE_FWAI_GATEWAY_PROJECT: "proj-default" };
    expect(fwaiGatewayProjectFor(environment, "proj-thread")).toBe("proj-thread");
    expect(fwaiGatewayProjectFor(environment, null)).toBe("proj-default");
    expect(fwaiGatewayProjectFor({}, undefined)).toBeNull();
    const settings = { apiKeyHelper: "x", env: { ANTHROPIC_BASE_URL: "https://gw" } };
    expect(withFwaiGatewayProject(settings, null)).toBe(settings);
    expect(withFwaiGatewayProject(settings, "proj-thread").env).toEqual({
      ANTHROPIC_BASE_URL: "https://gw",
      ANTHROPIC_CUSTOM_HEADERS: "X-FWAI-Project: proj-thread",
    });
  });
});
