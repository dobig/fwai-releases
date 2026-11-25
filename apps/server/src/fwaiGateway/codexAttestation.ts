import { isFwaiGatewayOrigin } from "@t3tools/shared/fwaiGateway";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { fwaiGatewayConfig } from "../cloud/publicConfig.ts";
import { codexAttestationConfig, renewableExpiry } from "./attestationHeaders.ts";
import * as FwaiAttestation from "./FwaiAttestation.ts";

const decodeProviders = Schema.decodeUnknownOption(
  Schema.Record(
    Schema.String,
    Schema.StructWithRest(Schema.Struct({ base_url: Schema.optionalKey(Schema.String) }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  ),
);

/**
 * Thread config that adds X-FWAI-Attestation to every Codex provider whose base URL is an fwai
 * gateway, whichever of them the thread uses (the user's own, e.g. fwai_app's `llm_gateway`, or
 * fwai's `fwai_gateway`). `effectiveConfig` is the app-server's `config/read` result.
 */
export const attestCodexThreadConfig = Effect.fn("FwaiAttestation.codexThreadConfig")(function* <E>(
  effectiveConfig: Effect.Effect<Readonly<Record<string, unknown>>, E>,
  claims: FwaiAttestation.FwaiAttestationClaims,
) {
  const none = { config: {} as Record<string, string>, expiresAtMs: null as number | null };
  const attestation = yield* Effect.serviceOption(FwaiAttestation.FwaiAttestation);
  if (Option.isNone(attestation)) return none;
  const config = yield* effectiveConfig.pipe(Effect.option);
  if (Option.isNone(config)) return none;
  const providers = decodeProviders(config.value.model_providers ?? {});
  if (Option.isNone(providers)) return none;
  const gatewayUrl = Option.match(yield* Effect.option(fwaiGatewayConfig), {
    onNone: () => null,
    onSome: (value) => value.gatewayUrl,
  });
  const gatewayProviders = Object.entries(providers.value)
    .filter(([, provider]) => isFwaiGatewayOrigin(provider.base_url, gatewayUrl))
    .map(([id]) => id);
  if (gatewayProviders.length === 0) return none;
  const signed = yield* attestation.value.sign(claims);
  if (Option.isNone(signed)) return none;
  return {
    config: codexAttestationConfig(gatewayProviders, signed.value.token),
    expiresAtMs: renewableExpiry(signed.value.expiresAtMs, yield* Clock.currentTimeMillis),
  };
});
