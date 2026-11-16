import {
  FWAI_DEFAULT_CLIENT_ID,
  FWAI_DEFAULT_GATEWAY_URL,
  normalizeFwaiGatewayUrl,
  type FwaiGatewayConfig,
} from "@t3tools/shared/fwaiGateway";
import { isRelayTracingEnabled } from "@t3tools/shared/otelEnvironment";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

declare const __T3CODE_BUILD_RELAY_URL__: string | undefined;
declare const __T3CODE_BUILD_FWAI_GATEWAY_URL__: string | undefined;
declare const __T3CODE_BUILD_FWAI_CLIENT_ID__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: string | undefined;

function validateRelayUrl(value: string) {
  const relayUrl = normalizeSecureRelayUrl(value);
  return relayUrl === null
    ? Effect.fail(
        new Config.ConfigError(
          new Schema.SchemaError(
            new SchemaIssue.InvalidValue({
              message: "Relay URL must be a secure absolute HTTPS origin.",
            }),
          ),
        ),
      )
    : Effect.succeed(relayUrl);
}

function readBuildTimeValue(value: string | undefined): string {
  return typeof value === "undefined" ? "" : value.trim();
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const buildTimeRelayUrl =
  typeof __T3CODE_BUILD_RELAY_URL__ === "undefined"
    ? ""
    : (normalizeSecureRelayUrl(__T3CODE_BUILD_RELAY_URL__) ?? "");
const buildTimeFwaiGatewayUrl = readBuildTimeValue(
  typeof __T3CODE_BUILD_FWAI_GATEWAY_URL__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_FWAI_GATEWAY_URL__,
);
const buildTimeFwaiClientId = readBuildTimeValue(
  typeof __T3CODE_BUILD_FWAI_CLIENT_ID__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_FWAI_CLIENT_ID__,
);
const buildTimeRelayClientTracing = {
  tracesUrl: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__,
  ),
  tracesDataset: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__,
  ),
  tracesToken: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__,
  ),
} as const;

export function resolveRelayClientTracingConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fallback = buildTimeRelayClientTracing,
) {
  if (!isRelayTracingEnabled(env)) {
    return null;
  }

  const tracesUrl = env.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL?.trim() || fallback.tracesUrl;
  const tracesDataset =
    env.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() || fallback.tracesDataset;
  const tracesToken = env.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() || fallback.tracesToken;
  const normalizedTracesUrl = normalizeSecureUrl(tracesUrl);
  return normalizedTracesUrl && tracesDataset && tracesToken
    ? { tracesUrl: normalizedTracesUrl, tracesDataset, tracesToken }
    : null;
}

export function makeRelayUrlConfig(fallback = buildTimeRelayUrl) {
  const runtimeConfig = Config.NonEmptyString("T3CODE_RELAY_URL");
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.mapEffect(validateRelayUrl),
  );
}

export const relayUrlConfig = makeRelayUrlConfig();

function validateFwaiGatewayUrl(value: string) {
  const gatewayUrl = normalizeFwaiGatewayUrl(value);
  return gatewayUrl === null
    ? Effect.fail(
        new Config.ConfigError(
          new Schema.SchemaError(
            new SchemaIssue.InvalidValue({
              message:
                "fwai gateway URL must be an absolute HTTPS origin (or HTTP loopback origin).",
            }),
          ),
        ),
      )
    : Effect.succeed(gatewayUrl);
}

function makePublicValueConfig(name: string, fallback: string) {
  return Config.NonEmptyString(name).pipe(
    Config.withDefault(fallback),
    Config.map((value) => value.trim()),
  );
}

export function makeFwaiGatewayConfig({
  gatewayUrlFallback = buildTimeFwaiGatewayUrl || FWAI_DEFAULT_GATEWAY_URL,
  clientIdFallback = buildTimeFwaiClientId || FWAI_DEFAULT_CLIENT_ID,
}: {
  readonly gatewayUrlFallback?: string;
  readonly clientIdFallback?: string;
} = {}): Config.Config<FwaiGatewayConfig> {
  return Config.all({
    gatewayUrl: makePublicValueConfig("T3CODE_FWAI_GATEWAY_URL", gatewayUrlFallback).pipe(
      Config.mapEffect(validateFwaiGatewayUrl),
    ),
    clientId: makePublicValueConfig("T3CODE_FWAI_CLIENT_ID", clientIdFallback),
  });
}

export const fwaiGatewayConfig = makeFwaiGatewayConfig();

export const hasCloudPublicConfig = Boolean(
  normalizeSecureRelayUrl(process.env.T3CODE_RELAY_URL ?? "") ?? buildTimeRelayUrl,
);
