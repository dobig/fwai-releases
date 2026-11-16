import { describe, expect, it } from "vite-plus/test";

import { isLinkedToConfiguredRelay } from "./useCloudLinkController.ts";

describe("isLinkedToConfiguredRelay", () => {
  it("rejects a link made through another stage's relay", () => {
    expect(
      isLinkedToConfiguredRelay(
        { relayUrl: "https://relay-staging.fwaii-tunnel.com" },
        "https://relay.fwaii-tunnel.com",
      ),
    ).toBe(false);
  });

  it("accepts the configured relay regardless of path or trailing slash", () => {
    expect(
      isLinkedToConfiguredRelay(
        { relayUrl: "https://relay.fwaii-tunnel.com/" },
        "https://relay.fwaii-tunnel.com",
      ),
    ).toBe(true);
  });

  it("treats an unknown relay on either side as a match", () => {
    expect(isLinkedToConfiguredRelay({ relayUrl: null }, "https://relay.fwaii-tunnel.com")).toBe(
      true,
    );
    expect(isLinkedToConfiguredRelay({ relayUrl: "https://relay.fwaii-tunnel.com" }, null)).toBe(
      true,
    );
  });
});
