import {
  FWAI_DEFAULT_CLIENT_ID,
  FWAI_DEFAULT_GATEWAY_URL,
  normalizeFwaiGatewayUrl,
} from "@t3tools/shared/fwaiGateway";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";

export interface CloudPublicConfig {
  /** Origin of the fwai account gateway; null when the configured URL is invalid. */
  readonly gatewayUrl: string | null;
  readonly gatewayClientId: string;
  readonly relayUrl: string | null;
  readonly relayTracing: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

function trimNonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function resolveCloudPublicConfig(): CloudPublicConfig {
  return {
    gatewayUrl: normalizeFwaiGatewayUrl(
      trimNonEmpty(import.meta.env.VITE_T3CODE_FWAI_GATEWAY_URL as string | undefined) ??
        FWAI_DEFAULT_GATEWAY_URL,
    ),
    gatewayClientId:
      trimNonEmpty(import.meta.env.VITE_T3CODE_FWAI_CLIENT_ID as string | undefined) ??
      FWAI_DEFAULT_CLIENT_ID,
    relayUrl: normalizeSecureRelayUrl(
      (import.meta.env.VITE_T3CODE_RELAY_URL as string | undefined) ?? "",
    ),
    relayTracing: {
      tracesUrl: normalizeSecureUrl(
        (import.meta.env.VITE_RELAY_OTLP_TRACES_URL as string | undefined) ?? "",
      ),
      tracesDataset: trimNonEmpty(
        import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET as string | undefined,
      ),
      tracesToken: trimNonEmpty(import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN as string | undefined),
    },
  };
}

export function resolveRelayTracingConfig() {
  // The relay exporter is created during module initialization, so this must be synchronous.
  if (
    typeof window !== "undefined" &&
    window.desktopBridge?.getRelayTelemetryEnabled?.() === false
  ) {
    return null;
  }
  const { relayTracing } = resolveCloudPublicConfig();
  return relayTracing.tracesUrl && relayTracing.tracesDataset && relayTracing.tracesToken
    ? {
        tracesUrl: relayTracing.tracesUrl,
        tracesDataset: relayTracing.tracesDataset,
        tracesToken: relayTracing.tracesToken,
      }
    : null;
}

export function hasCloudPublicConfig(): boolean {
  const config = resolveCloudPublicConfig();
  if (!config.gatewayUrl || !config.relayUrl) return false;
  if (typeof window === "undefined" || window.desktopBridge !== undefined) return true;
  return (
    isHostedAppOrigin(window.location) || isGatewayAllowedOrigin(config.gatewayUrl, window.location)
  );
}

// fwai: the hosted web app (chat.fwaii.com) is not on the gateway's site; its deploy sets this.
function isHostedAppOrigin(location: Pick<Location, "origin">): boolean {
  const hostedAppUrl = normalizeSecureUrl(
    (import.meta.env.VITE_HOSTED_APP_URL as string | undefined)?.trim() ?? "",
  );
  return hostedAppUrl !== null && new URL(hostedAppUrl).origin === location.origin;
}

/**
 * The gateway's CORS allowlist covers its own site (gateway `api.fwai.space`
 * serves `fwai.space` and its subdomains). Other origins, such as the web app
 * served by a local server on a LAN address, keep account features off.
 */
function isGatewayAllowedOrigin(
  gatewayUrl: string,
  location: Pick<Location, "hostname" | "protocol" | "port">,
): boolean {
  const gateway = new URL(gatewayUrl);
  if (gateway.protocol === "http:") return true;
  const labels = gateway.hostname.split(".");
  const domain = labels.length > 2 ? labels.slice(1).join(".") : gateway.hostname;
  const { hostname, protocol, port } = location;
  return (
    protocol === "https:" && port === "" && (hostname === domain || hostname.endsWith(`.${domain}`))
  );
}
