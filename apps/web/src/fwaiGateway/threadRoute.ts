export { fwaiGatewayRouteOf } from "@t3tools/client-runtime/fwai-gateway";

/**
 * The driver of a thread that has not started a provider thread yet. Built-in instances are named
 * after their driver; a custom instance reads as unknown and shows no quota controls until it runs.
 */
export function activeThreadDriver(thread: { readonly providerInstanceId: string }): string {
  return thread.providerInstanceId;
}
