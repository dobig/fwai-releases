import { FWAI_ATTESTATION_HEADER } from "@t3tools/shared/fwaiGateway";

/** Re-sign this long before a header expires; the session restarts between turns to pick it up. */
const ATTESTATION_RENEW_BEFORE_MS = 30 * 60 * 1000;

export const attestationRenewalDue = (expiresAtMs: number | null, nowMs: number) =>
  expiresAtMs !== null && expiresAtMs - nowMs < ATTESTATION_RENEW_BEFORE_MS;

/**
 * The expiry to renew at, or null when a header is already inside the renewal window when signed:
 * its key expires sooner, so restarting would only sign another short header every turn.
 */
export const renewableExpiry = (expiresAtMs: number, nowMs: number) =>
  expiresAtMs - nowMs >= ATTESTATION_RENEW_BEFORE_MS ? expiresAtMs : null;

/**
 * Claude reads ANTHROPIC_CUSTOM_HEADERS as one `Name: value` per line and a flag setting replaces
 * the user's whole value, so the user's lines are kept and ours replace same-named ones.
 */
export function mergeCustomHeaderLines(
  existing: string | undefined,
  headers: Readonly<Record<string, string>>,
): string {
  const names = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  const kept = (existing ?? "").split(/\r?\n/).filter((line) => {
    const name = line.slice(0, Math.max(line.indexOf(":"), 0)).trim();
    return name.length > 0 && !names.has(name.toLowerCase());
  });
  return [...kept, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)].join(
    "\n",
  );
}

/**
 * Per-thread Codex config adding the header to each named provider. Codex deep-merges these dotted
 * keys into the user's config.toml tables without writing the file; ids with dots cannot be
 * addressed and are skipped.
 */
export function codexAttestationConfig(
  providerIds: Iterable<string>,
  token: string,
): Record<string, string> {
  const config: Record<string, string> = {};
  for (const id of providerIds) {
    if (id.length === 0 || id.includes(".")) continue;
    config[`model_providers.${id}.http_headers.${FWAI_ATTESTATION_HEADER}`] = token;
  }
  return config;
}
