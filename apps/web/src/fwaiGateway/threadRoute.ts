import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";

import type { FwaiGatewayThreadRoute } from "../components/chat/FwaiGatewayThreadRouteTag";
import { CODEX_GATEWAY_PROVIDER_ID } from "./useFwaiGatewayRouting";

/** Null for non-Codex threads and for Codex threads started before fwai recorded the provider. */
export function fwaiGatewayRouteOf(
  providerThread: OrchestrationV2ProviderThread | undefined,
): FwaiGatewayThreadRoute | null {
  if (providerThread?.driver !== "codex") return null;
  const providerId = providerThread.nativeMetadata?.modelProviderId;
  if (providerId === undefined) return null;
  return providerId === CODEX_GATEWAY_PROVIDER_ID ? "gateway" : "direct";
}

/**
 * The driver of a thread that has not started a provider thread yet. Built-in instances are named
 * after their driver; a custom instance reads as unknown and shows no quota controls until it runs.
 */
export function activeThreadDriver(thread: { readonly providerInstanceId: string }): string {
  return thread.providerInstanceId;
}
