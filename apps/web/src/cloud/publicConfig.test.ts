import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { hasCloudPublicConfig } from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("hasCloudPublicConfig", () => {
  it("rejects an insecure relay URL", () => {
    vi.stubEnv("VITE_T3CODE_FWAI_GATEWAY_URL", "https://api.example.com");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://relay.example.test");

    expect(hasCloudPublicConfig()).toBe(false);
  });

  it("rejects an insecure gateway URL", () => {
    vi.stubEnv("VITE_T3CODE_FWAI_GATEWAY_URL", "http://api.example.com");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    vi.stubGlobal("window", { location: new URL("https://example.com") });

    expect(hasCloudPublicConfig()).toBe(false);
  });

  describe("browser origins", () => {
    beforeEach(() => {
      vi.stubEnv("VITE_T3CODE_FWAI_GATEWAY_URL", "https://api.example.com");
      vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    });

    it.each(["https://example.com", "https://chat.example.com", "https://a.b.example.com:443"])(
      "enables accounts on the gateway's site and its subdomains: %s",
      (origin) => {
        vi.stubGlobal("window", { location: new URL(origin) });

        expect(hasCloudPublicConfig()).toBe(true);
      },
    );

    it.each(["http://localhost:3773", "https://machine.example.ts.net", "http://192.168.1.4:3773"])(
      "disables accounts on private browser origins: %s",
      (origin) => {
        vi.stubGlobal("window", { location: new URL(origin) });

        expect(hasCloudPublicConfig()).toBe(false);
      },
    );

    it.each(["http://app.example.com:443", "https://app.example.com:3773"])(
      "rejects unsupported schemes and ports even on the gateway's site: %s",
      (origin) => {
        vi.stubGlobal("window", { location: new URL(origin) });

        expect(hasCloudPublicConfig()).toBe(false);
      },
    );

    it.each(["https://notexample.com", "https://example.com.evil.test"])(
      "rejects domain lookalikes: %s",
      (origin) => {
        vi.stubGlobal("window", { location: new URL(origin) });

        expect(hasCloudPublicConfig()).toBe(false);
      },
    );

    it("enables accounts on the configured hosted app origin outside the gateway's site", () => {
      vi.stubEnv("VITE_HOSTED_APP_URL", "https://chat.example.net");
      vi.stubGlobal("window", { location: new URL("https://chat.example.net/settings") });

      expect(hasCloudPublicConfig()).toBe(true);
    });

    it("keeps accounts off on other origins when a hosted app origin is configured", () => {
      vi.stubEnv("VITE_HOSTED_APP_URL", "https://chat.example.net");
      vi.stubGlobal("window", { location: new URL("https://other.example.net") });

      expect(hasCloudPublicConfig()).toBe(false);
    });

    it("allows any origin against a loopback development gateway", () => {
      vi.stubEnv("VITE_T3CODE_FWAI_GATEWAY_URL", "http://localhost:8080");
      vi.stubGlobal("window", { location: new URL("http://localhost:5173") });

      expect(hasCloudPublicConfig()).toBe(true);
    });

    it("always enables accounts in the desktop app", () => {
      vi.stubGlobal("window", { location: new URL("t3://app/index.html"), desktopBridge: {} });

      expect(hasCloudPublicConfig()).toBe(true);
    });
  });
});
