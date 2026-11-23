import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fwaiGatewayRouteOf } from "./threadRoute";

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
