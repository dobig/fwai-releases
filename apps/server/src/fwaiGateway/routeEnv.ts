/**
 * Set on a Claude or Codex instance's environment while fwai Gateway routing is on
 * (see deriveProviderInstanceConfigMap). Instances rebuild when it changes.
 */
export const FWAI_GATEWAY_ROUTE_ENV = "T3CODE_FWAI_GATEWAY_ROUTE";

/**
 * The organization project whose quota routed requests use: the environment default from
 * hydration, replaced per thread when the thread picks its own. Unset uses the account's.
 */
export const FWAI_GATEWAY_PROJECT_ENV = "T3CODE_FWAI_GATEWAY_PROJECT";
export const FWAI_GATEWAY_PROJECT_HEADER = "X-FWAI-Project";

/** Codex stores this id in each thread and refuses to resume a thread under another one. */
export const CODEX_GATEWAY_PROVIDER_ID = "fwai_gateway";

export const isFwaiGatewayRouted = (environment: NodeJS.ProcessEnv | undefined) =>
  environment?.[FWAI_GATEWAY_ROUTE_ENV] === "1";

export const fwaiGatewayProjectFor = (
  environment: NodeJS.ProcessEnv | undefined,
  threadProjectId: string | null | undefined,
) => threadProjectId ?? (environment?.[FWAI_GATEWAY_PROJECT_ENV] || null);
