import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fwaiGatewayRouteOf, threadRoutesThroughGateway } from "./fwaiGateway.ts";

const thread = (driver: string, modelProviderId?: string) =>
  ({
    driver,
    ...(modelProviderId === undefined ? {} : { nativeMetadata: { modelProviderId } }),
  }) as unknown as OrchestrationV2ProviderThread;

describe("fwaiGatewayRouteOf", () => {
  it("reads the provider a Codex thread started on", () => {
    expect(fwaiGatewayRouteOf(thread("codex", "fwai_gateway"))).toBe("gateway");
    expect(fwaiGatewayRouteOf(thread("codex", "openai"))).toBe("direct");
  });

  it("claims nothing for other providers or threads from before the provider was recorded", () => {
    expect(fwaiGatewayRouteOf(thread("claudeAgent", "fwai_gateway"))).toBeNull();
    expect(fwaiGatewayRouteOf(thread("codex"))).toBeNull();
    expect(fwaiGatewayRouteOf(undefined)).toBeNull();
  });
});

describe("threadRoutesThroughGateway", () => {
  const on = { fwaiGatewayEnabled: true, fwaiGatewayClaude: true, fwaiGatewayCodex: false };

  it("follows the per-provider switch, and Codex threads keep their starting route", () => {
    expect(threadRoutesThroughGateway(on, { driver: "claudeAgent", codexRoute: null })).toBe(true);
    expect(threadRoutesThroughGateway(on, { driver: "codex", codexRoute: null })).toBe(false);
    expect(threadRoutesThroughGateway(on, { driver: "codex", codexRoute: "gateway" })).toBe(true);
  });

  it("routes nothing while the gateway is off", () => {
    const off = { ...on, fwaiGatewayEnabled: false };
    expect(threadRoutesThroughGateway(off, { driver: "codex", codexRoute: "gateway" })).toBe(false);
  });
});
