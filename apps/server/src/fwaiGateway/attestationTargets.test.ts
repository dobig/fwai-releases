import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  attestationRenewalDue,
  mergeCustomHeaderLines,
  renewableExpiry,
} from "./attestationHeaders.ts";
import { attestClaudeSdkSettings } from "./claudeAttestation.ts";
import { attestCodexThreadConfig } from "./codexAttestation.ts";
import * as FwaiAttestation from "./FwaiAttestation.ts";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

const signed = Layer.succeed(FwaiAttestation.FwaiAttestation, {
  registration: Effect.succeed(null),
  report: () => Effect.void,
  sign: () => Effect.succeedSome({ token: "signed-jwt", expiresAtMs: FOUR_HOURS_MS }),
});
const unregistered = Layer.succeed(FwaiAttestation.FwaiAttestation, {
  registration: Effect.succeed(null),
  report: () => Effect.void,
  sign: () => Effect.succeedNone,
});

const claude = (input: Partial<Parameters<typeof attestClaudeSdkSettings>[0]>) =>
  attestClaudeSdkSettings({
    sdkSettings: undefined,
    layers: [],
    processEnv: {},
    claims: {},
    ...input,
  });

describe("Claude attestation", () => {
  it.effect("adds the header only when the effective base URL is an fwai gateway", () =>
    Effect.gen(function* () {
      const toGateway = yield* claude({
        layers: [{ env: { ANTHROPIC_BASE_URL: "https://api.fwai.space" } }],
      });
      assert.deepEqual(toGateway.sdkSettings, {
        env: { ANTHROPIC_CUSTOM_HEADERS: "X-FWAI-Attestation: signed-jwt" },
      });
      assert.equal(toGateway.expiresAtMs, FOUR_HOURS_MS);

      const staging = yield* claude({
        processEnv: { ANTHROPIC_BASE_URL: "https://api-staging.fwai.space/" },
      });
      assert.isDefined(staging.sdkSettings);

      // A project file pointing at Anthropic outranks the user's gateway setting.
      const direct = yield* claude({
        layers: [
          { env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } },
          { env: { ANTHROPIC_BASE_URL: "https://api.fwai.space" } },
        ],
      });
      assert.deepEqual(direct, { sdkSettings: undefined, expiresAtMs: null });
      assert.deepEqual(yield* claude({}), { sdkSettings: undefined, expiresAtMs: null });
      assert.deepEqual(
        yield* claude({ processEnv: { ANTHROPIC_BASE_URL: "https://api.fwai.space.evil.test" } }),
        { sdkSettings: undefined, expiresAtMs: null },
      );
    }).pipe(Effect.provide(signed)),
  );

  it.effect("keeps the user's custom headers and fwai's routed settings", () =>
    Effect.gen(function* () {
      const routed = yield* claude({
        sdkSettings: {
          apiKeyHelper: "fwai __fwai-gateway-token",
          env: {
            ANTHROPIC_BASE_URL: "https://api.fwai.space",
            ANTHROPIC_AUTH_TOKEN: "",
            ANTHROPIC_CUSTOM_HEADERS: "X-FWAI-Project: p1",
          },
        },
        layers: [{ env: { ANTHROPIC_CUSTOM_HEADERS: "X-Team: a\nX-FWAI-Attestation: stale" } }],
      });
      assert.deepEqual(routed.sdkSettings, {
        apiKeyHelper: "fwai __fwai-gateway-token",
        env: {
          ANTHROPIC_BASE_URL: "https://api.fwai.space",
          ANTHROPIC_AUTH_TOKEN: "",
          ANTHROPIC_CUSTOM_HEADERS: "X-Team: a\nX-FWAI-Project: p1\nX-FWAI-Attestation: signed-jwt",
        },
      });
    }).pipe(Effect.provide(signed)),
  );

  it.effect("adds nothing when the user's own key helper supplies the token", () =>
    Effect.gen(function* () {
      const result = yield* claude({
        layers: [
          {
            env: { ANTHROPIC_BASE_URL: "https://api.fwai.space" },
            apiKeyHelper: "my-token-script",
          },
        ],
      });
      assert.deepEqual(result, { sdkSettings: undefined, expiresAtMs: null });
    }).pipe(Effect.provide(signed)),
  );

  it.effect("adds nothing until the key is registered", () =>
    Effect.gen(function* () {
      const result = yield* claude({
        processEnv: { ANTHROPIC_BASE_URL: "https://api.fwai.space" },
      });
      assert.deepEqual(result, { sdkSettings: undefined, expiresAtMs: null });
    }).pipe(Effect.provide(unregistered)),
  );
});

describe("Codex attestation", () => {
  const effectiveConfig = Effect.succeed({
    model_provider: "llm_gateway",
    model_providers: {
      llm_gateway: { name: "llm_gateway", base_url: "https://api.fwai.space/v1" },
      fwai_gateway: { name: "fwai Gateway", base_url: "https://api.fwai.space/v1" },
      other: { base_url: "https://api.openai.com/v1" },
      "dotted.id": { base_url: "https://api.fwai.space/v1" },
    },
  });

  it.effect("targets every provider that points at an fwai gateway, and nothing else", () =>
    Effect.gen(function* () {
      const result = yield* attestCodexThreadConfig(effectiveConfig, {});
      assert.deepEqual(result, {
        config: {
          "model_providers.llm_gateway.http_headers.X-FWAI-Attestation": "signed-jwt",
          "model_providers.fwai_gateway.http_headers.X-FWAI-Attestation": "signed-jwt",
        },
        expiresAtMs: FOUR_HOURS_MS,
      });
      const direct = yield* attestCodexThreadConfig(
        Effect.succeed({ model_providers: { other: { base_url: "https://api.openai.com/v1" } } }),
        {},
      );
      assert.deepEqual(direct, { config: {}, expiresAtMs: null });
      const unreadable = yield* attestCodexThreadConfig(Effect.fail("config/read failed"), {});
      assert.deepEqual(unreadable, { config: {}, expiresAtMs: null });
    }).pipe(Effect.provide(signed)),
  );
});

describe("attestation headers", () => {
  it("replaces a same-named line and keeps the rest", () => {
    assert.equal(
      mergeCustomHeaderLines("X-A: 1\nx-fwai-attestation: old\n\nbroken line", {
        "X-FWAI-Attestation": "new",
      }),
      "X-A: 1\nX-FWAI-Attestation: new",
    );
  });

  it("renews within thirty minutes of expiry, but not a header born inside that window", () => {
    assert.isFalse(attestationRenewalDue(null, 0));
    assert.isFalse(attestationRenewalDue(31 * 60_000, 0));
    assert.isTrue(attestationRenewalDue(29 * 60_000, 0));
    // A key with twenty minutes left signs a twenty-minute header; restarting would not help.
    assert.isNull(renewableExpiry(20 * 60_000, 0));
    assert.equal(renewableExpiry(FOUR_HOURS_MS, 0), FOUR_HOURS_MS);
  });
});
