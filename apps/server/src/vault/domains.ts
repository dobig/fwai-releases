// fwai: domain binding for vault entries. A domain covers its registrable domain from the
// Public Suffix List (private section included, so `alice.github.io` never covers `bob.github.io`).
import { parse } from "tldts";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1"]);

const parseHost = (input: string) =>
  parse(input.trim().replace(/^\*\./, ""), {
    allowPrivateDomains: true,
  });

/** The host of a domain or URL as typed by a user, lowercased, or null if it has none. */
export function normalizeDomain(input: string): string | null {
  return parseHost(input).hostname ?? null;
}

/**
 * The unit a domain binds to: its registrable domain, or the exact host for loopback names and IP
 * addresses. Null for a bare public suffix such as `com` or `github.io`, which binds nothing.
 */
export function registrableDomain(input: string): string | null {
  const parsed = parseHost(input);
  if (parsed.hostname === null) return null;
  if (parsed.isIp || LOOPBACK_HOSTS.has(parsed.hostname)) return parsed.hostname;
  return parsed.domain ?? null;
}

function hostMatchesDomain(host: string, domain: string): boolean {
  const bound = registrableDomain(domain);
  return bound !== null && registrableDomain(host) === bound;
}

/** `https`, or `http` on a loopback host. */
function isSecureOrigin(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ""));
}

/** Whether a value bound to `domains` may be typed into a page at `url`. No domains: never. */
export function originAllowed(domains: ReadonlyArray<string>, url: string): boolean {
  if (domains.length === 0 || !URL.canParse(url)) return false;
  const parsed = new URL(url);
  if (!isSecureOrigin(parsed)) return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  return domains.some((domain) => hostMatchesDomain(host, domain));
}
