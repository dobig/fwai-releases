// fwai: vault entries a pending `request_secret` card can offer. Only the owner reaches this
// through `vault.matchesForRequest`; the card's projection carries no vault data.
import {
  VAULT_DOMAINS_MAX,
  VAULT_NAME_MAX_LENGTH,
  VaultError,
  type VaultMatchesForRequestInput,
  type VaultMatchesForRequestResult,
  type VaultRequestMatch,
} from "@t3tools/contracts";
import { parse } from "tldts";
import * as Effect from "effect/Effect";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as Domains from "./domains.ts";
import * as VaultService from "./VaultService.ts";

const HOST_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}\b/gi;
// Words too generic to make two names similar on their own.
const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  "api",
  "key",
  "token",
  "password",
  "secret",
  "login",
  "the",
  "for",
  "account",
]);

// Country-code suffixes that are far more often file extensions (`README.md`, `setup.sh`).
const FILE_LIKE_SUFFIXES: ReadonlySet<string> = new Set(["md", "sh", "py", "rs", "pl", "rb", "so"]);

/** Hosts named in free text whose suffix is on the Public Suffix List. */
function hostsInText(text: string): Array<string> {
  return Array.from(text.matchAll(HOST_PATTERN), ([match]) =>
    parse(match, { allowPrivateDomains: true }),
  ).flatMap((parsed) =>
    parsed.hostname !== null &&
    (parsed.isIcann === true || parsed.isPrivate === true) &&
    !FILE_LIKE_SUFFIXES.has(parsed.publicSuffix ?? "")
      ? [parsed.hostname]
      : [],
  );
}

const compact = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const tokens = (name: string) =>
  name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3 && !GENERIC_TOKENS.has(token));

/** Case-insensitive containment ignoring separators, or a shared distinctive word. */
function similarNames(a: string, b: string): boolean {
  const left = compact(a);
  const right = compact(b);
  if (left.length >= 3 && right.length >= 3 && (left.includes(right) || right.includes(left))) {
    return true;
  }
  const rightTokens = new Set(tokens(b));
  return tokens(a).some((token) => rightTokens.has(token));
}

function previewHosts(urls: ReadonlyArray<string>): Array<string> {
  return urls.flatMap((url) => {
    if (!URL.canParse(url)) return [];
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return [];
    const host = Domains.normalizeDomain(parsed.hostname.replace(/^\[|\]$/g, ""));
    return host === null ? [] : [host];
  });
}

export const matchesForRequest = Effect.fn("VaultRequestMatches.matchesForRequest")(function* (
  input: VaultMatchesForRequestInput,
) {
  const vault = yield* VaultService.VaultService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const previews = yield* PreviewManager.PreviewManager;
  yield* Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId });

  const records = yield* threadManagement
    .getThreadRecords(input.threadId, ["turnItems"], {
      turnItemTypes: ["secret_request"],
      messageRoles: [],
    })
    .pipe(Effect.mapError((cause) => new VaultError({ reason: "store_failed", cause })));
  const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
  if (item?.type !== "secret_request") return yield* new VaultError({ reason: "not_found" });

  const { sessions } = yield* previews.list({ threadId: input.threadId });
  const tabHosts = previewHosts(
    sessions.flatMap((session) =>
      session.navStatus._tag === "Idle" ? [] : [session.navStatus.url],
    ),
  );
  const requestHosts = [...new Set([...tabHosts, ...hostsInText(`${item.label} ${item.reason}`)])];
  const requestDomains = new Set(
    requestHosts.flatMap((host) => Domains.registrableDomain(host) ?? []),
  );

  const { entries } = yield* vault.list();
  const projectId = records.thread.projectId;
  const matches = entries.flatMap((entry): Array<VaultRequestMatch> => {
    const matchedBy = entry.domains.some((domain) =>
      requestDomains.has(Domains.registrableDomain(domain) ?? ""),
    )
      ? "domain"
      : similarNames(entry.name, item.label)
        ? "name"
        : null;
    if (matchedBy === null) return [];
    const inScope = entry.scope === "global" || entry.scope.projects.includes(projectId);
    return [{ entry, matchedBy, inScope }];
  });
  const rank = (match: VaultRequestMatch) =>
    (match.inScope ? 0 : 2) + (match.matchedBy === "domain" ? 0 : 1);
  const suggestedName = item.label.slice(0, VAULT_NAME_MAX_LENGTH).trim();

  return {
    matches: matches.toSorted((a, b) => rank(a) - rank(b)),
    ...(suggestedName === "" ? {} : { suggestedName }),
    suggestedDomains: requestHosts.slice(0, VAULT_DOMAINS_MAX),
  } satisfies VaultMatchesForRequestResult;
});
