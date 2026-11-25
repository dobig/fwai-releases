import type { Settings as ClaudeSdkSettings } from "@anthropic-ai/claude-agent-sdk";
import { FWAI_ATTESTATION_HEADER, isFwaiGatewayOrigin } from "@t3tools/shared/fwaiGateway";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { fwaiGatewayConfig } from "../cloud/publicConfig.ts";
import { mergeCustomHeaderLines, renewableExpiry } from "./attestationHeaders.ts";
import * as FwaiAttestation from "./FwaiAttestation.ts";

/** The parts of one Claude settings file that decide where its requests go and how. */
export interface ClaudeSettingsLayer {
  readonly env?: Readonly<Record<string, unknown>>;
  readonly apiKeyHelper?: unknown;
}

const stringValue = (value: unknown) => (typeof value === "string" ? value : undefined);

/**
 * Adds X-FWAI-Attestation to a query's flag settings when Claude will send its requests to an
 * fwai gateway. `layers` are the settings files from highest precedence (local) to lowest (user);
 * flag settings beat them and they beat the process env, as in Claude Code. A key helper the user
 * configured makes the token unknown to fwai, so nothing is added then.
 */
export const attestClaudeSdkSettings = Effect.fn("FwaiAttestation.claudeSettings")(
  function* (input: {
    readonly sdkSettings: ClaudeSdkSettings | undefined;
    readonly layers: ReadonlyArray<ClaudeSettingsLayer>;
    readonly processEnv: NodeJS.ProcessEnv;
    readonly claims: FwaiAttestation.FwaiAttestationClaims;
  }) {
    const unchanged = { sdkSettings: input.sdkSettings, expiresAtMs: null as number | null };
    const attestation = yield* Effect.serviceOption(FwaiAttestation.FwaiAttestation);
    if (Option.isNone(attestation)) return unchanged;
    const flagEnv: Readonly<Record<string, unknown>> = input.sdkSettings?.env ?? {};
    const fromLayers = (key: string) =>
      input.layers
        .map((layer) => stringValue(layer.env?.[key]))
        .find((value) => value !== undefined);
    const userValue = (key: string) => fromLayers(key) ?? input.processEnv[key];
    const ownsKeyHelper = input.sdkSettings?.apiKeyHelper !== undefined;
    if (!ownsKeyHelper && input.layers.some((layer) => layer.apiKeyHelper !== undefined)) {
      return unchanged;
    }
    const baseUrl = stringValue(flagEnv.ANTHROPIC_BASE_URL) ?? userValue("ANTHROPIC_BASE_URL");
    const configured = yield* Effect.option(fwaiGatewayConfig);
    const gatewayUrl = Option.match(configured, {
      onNone: () => null,
      onSome: (config) => config.gatewayUrl,
    });
    if (!isFwaiGatewayOrigin(baseUrl, gatewayUrl)) return unchanged;
    const signed = yield* attestation.value.sign(input.claims);
    if (Option.isNone(signed)) return unchanged;
    // Later lines win in Claude Code, so fwai's own flag headers follow the user's.
    const existing = [
      userValue("ANTHROPIC_CUSTOM_HEADERS"),
      stringValue(flagEnv.ANTHROPIC_CUSTOM_HEADERS),
    ]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join("\n");
    return {
      sdkSettings: {
        ...input.sdkSettings,
        env: {
          ...input.sdkSettings?.env,
          ANTHROPIC_CUSTOM_HEADERS: mergeCustomHeaderLines(existing, {
            [FWAI_ATTESTATION_HEADER]: signed.value.token,
          }),
        },
      } satisfies ClaudeSdkSettings,
      expiresAtMs: renewableExpiry(signed.value.expiresAtMs, yield* Clock.currentTimeMillis),
    };
  },
);
