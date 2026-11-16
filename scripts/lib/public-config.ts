// @effect-diagnostics nodeBuiltinImport:off - Build bootstrap reads optional root env files before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

export interface T3CodePublicConfig {
  /** fwai: the llm_gateway origin that owns accounts. */
  readonly fwaiGatewayUrl: string;
  readonly fwaiClientId: string;
  readonly relayUrl: string | undefined;
  readonly mobileOtlpTracesUrl: string | undefined;
  readonly mobileOtlpTracesDataset: string | undefined;
  readonly mobileOtlpTracesToken: string | undefined;
  readonly relayClientOtlpTracesUrl: string | undefined;
  readonly relayClientOtlpTracesDataset: string | undefined;
  readonly relayClientOtlpTracesToken: string | undefined;
}

// Mirrors @t3tools/shared/fwaiGateway; build bootstrap cannot import workspace packages.
const FWAI_DEFAULT_GATEWAY_URL = "https://api.fwai.space";
const FWAI_DEFAULT_CLIENT_ID = "fwai";

type Environment = Readonly<Record<string, string | undefined>>;

const REPO_ROOT = NodePath.dirname(
  NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))),
);

export function loadRepoEnv({
  baseEnv = process.env,
  repoRoot = REPO_ROOT,
}: {
  readonly baseEnv?: Environment;
  readonly repoRoot?: string;
} = {}): Record<string, string | undefined> {
  const rootEnv = readEnvFile(NodePath.join(repoRoot, ".env"));
  const localEnv = readEnvFile(NodePath.join(repoRoot, ".env.local"));
  const config = resolvePublicConfig(baseEnv, localEnv, rootEnv);

  return {
    ...rootEnv,
    ...localEnv,
    ...baseEnv,
    T3CODE_FWAI_GATEWAY_URL: config.fwaiGatewayUrl,
    VITE_T3CODE_FWAI_GATEWAY_URL: config.fwaiGatewayUrl,
    EXPO_PUBLIC_T3CODE_FWAI_GATEWAY_URL: config.fwaiGatewayUrl,
    T3CODE_FWAI_CLIENT_ID: config.fwaiClientId,
    VITE_T3CODE_FWAI_CLIENT_ID: config.fwaiClientId,
    EXPO_PUBLIC_T3CODE_FWAI_CLIENT_ID: config.fwaiClientId,
    ...(config.relayUrl
      ? {
          T3CODE_RELAY_URL: config.relayUrl,
          VITE_T3CODE_RELAY_URL: config.relayUrl,
        }
      : {}),
    ...(config.mobileOtlpTracesUrl
      ? {
          T3CODE_MOBILE_OTLP_TRACES_URL: config.mobileOtlpTracesUrl,
          EXPO_PUBLIC_OTLP_TRACES_URL: config.mobileOtlpTracesUrl,
        }
      : {}),
    ...(config.mobileOtlpTracesDataset
      ? {
          T3CODE_MOBILE_OTLP_TRACES_DATASET: config.mobileOtlpTracesDataset,
          EXPO_PUBLIC_OTLP_TRACES_DATASET: config.mobileOtlpTracesDataset,
        }
      : {}),
    ...(config.mobileOtlpTracesToken
      ? {
          T3CODE_MOBILE_OTLP_TRACES_TOKEN: config.mobileOtlpTracesToken,
          EXPO_PUBLIC_OTLP_TRACES_TOKEN: config.mobileOtlpTracesToken,
        }
      : {}),
    ...(config.relayClientOtlpTracesUrl
      ? {
          T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: config.relayClientOtlpTracesUrl,
          VITE_RELAY_OTLP_TRACES_URL: config.relayClientOtlpTracesUrl,
        }
      : {}),
    ...(config.relayClientOtlpTracesDataset
      ? {
          T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: config.relayClientOtlpTracesDataset,
          VITE_RELAY_OTLP_TRACES_DATASET: config.relayClientOtlpTracesDataset,
        }
      : {}),
    ...(config.relayClientOtlpTracesToken
      ? {
          T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: config.relayClientOtlpTracesToken,
          VITE_RELAY_OTLP_TRACES_TOKEN: config.relayClientOtlpTracesToken,
        }
      : {}),
  };
}

export function resolvePublicConfig(...sources: readonly Environment[]): T3CodePublicConfig {
  return {
    fwaiGatewayUrl:
      firstNonEmpty(
        sources,
        "T3CODE_FWAI_GATEWAY_URL",
        "VITE_T3CODE_FWAI_GATEWAY_URL",
        "EXPO_PUBLIC_T3CODE_FWAI_GATEWAY_URL",
      ) ?? FWAI_DEFAULT_GATEWAY_URL,
    fwaiClientId:
      firstNonEmpty(
        sources,
        "T3CODE_FWAI_CLIENT_ID",
        "VITE_T3CODE_FWAI_CLIENT_ID",
        "EXPO_PUBLIC_T3CODE_FWAI_CLIENT_ID",
      ) ?? FWAI_DEFAULT_CLIENT_ID,
    relayUrl: firstNonEmpty(sources, "T3CODE_RELAY_URL", "VITE_T3CODE_RELAY_URL"),
    mobileOtlpTracesUrl: firstNonEmpty(
      sources,
      "T3CODE_MOBILE_OTLP_TRACES_URL",
      "EXPO_PUBLIC_OTLP_TRACES_URL",
    ),
    mobileOtlpTracesDataset: firstNonEmpty(
      sources,
      "T3CODE_MOBILE_OTLP_TRACES_DATASET",
      "EXPO_PUBLIC_OTLP_TRACES_DATASET",
    ),
    mobileOtlpTracesToken: firstNonEmpty(
      sources,
      "T3CODE_MOBILE_OTLP_TRACES_TOKEN",
      "EXPO_PUBLIC_OTLP_TRACES_TOKEN",
    ),
    relayClientOtlpTracesUrl: firstNonEmpty(
      sources,
      "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL",
      "VITE_RELAY_OTLP_TRACES_URL",
    ),
    relayClientOtlpTracesDataset: firstNonEmpty(
      sources,
      "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET",
      "VITE_RELAY_OTLP_TRACES_DATASET",
    ),
    relayClientOtlpTracesToken: firstNonEmpty(
      sources,
      "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN",
      "VITE_RELAY_OTLP_TRACES_TOKEN",
    ),
  };
}

function firstNonEmpty(sources: readonly Environment[], ...names: readonly string[]) {
  for (const source of sources) {
    for (const name of names) {
      const value = source[name]?.trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function readEnvFile(path: string): Record<string, string | undefined> {
  return NodeFS.existsSync(path) ? NodeUtil.parseEnv(NodeFS.readFileSync(path, "utf8")) : {};
}
