import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";

/**
 * fwai: secrets vault on one environment. Values live on the environment and
 * never cross an RPC: every read shape below omits `value`, and there is no reveal method.
 */
export const VaultEntryId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("VaultEntryId"),
);
export type VaultEntryId = typeof VaultEntryId.Type;

/** Changes only the form and defaults, never behaviour. */
export const VaultEntryKind = Schema.Literals(["password", "token", "note"]);
export type VaultEntryKind = typeof VaultEntryKind.Type;

/** Only `global` entries sync; a `projectId` means nothing on another environment. */
export const VaultScope = Schema.Union([
  Schema.Literal("global"),
  Schema.Struct({ projects: Schema.Array(ProjectId) }),
]);
export type VaultScope = typeof VaultScope.Type;

export const VAULT_NAME_MAX_LENGTH = 200;
export const VAULT_VALUE_MAX_LENGTH = 64_000;
export const VAULT_DOMAINS_MAX = 20;

export const VaultEntryName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(VAULT_NAME_MAX_LENGTH),
);
/** A host such as `example.com`; it covers its subdomains. */
export const VaultDomain = TrimmedNonEmptyString.check(Schema.isMaxLength(253));
export const VaultDomains = Schema.Array(VaultDomain).check(Schema.isMaxLength(VAULT_DOMAINS_MAX));
const VaultValue = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(VAULT_VALUE_MAX_LENGTH),
);

export const VaultDelivery = Schema.Literals(["secretRef", "file", "form_fill"]);
export type VaultDelivery = typeof VaultDelivery.Type;

/** Kept beside, not in, the entry so a use never bumps `version`. Never synced. */
export const VaultEntryUsage = Schema.Struct({
  at: IsoDateTime,
  threadId: ThreadId,
  /** The run's acting account; absent for the owner's own runs. */
  accountId: Schema.optional(TrimmedNonEmptyString),
  delivery: VaultDelivery,
});
export type VaultEntryUsage = typeof VaultEntryUsage.Type;

export const VaultEntrySummary = Schema.Struct({
  id: VaultEntryId,
  name: VaultEntryName,
  kind: VaultEntryKind,
  username: Schema.optional(TrimmedNonEmptyString),
  domains: VaultDomains,
  scope: VaultScope,
  version: Schema.Int,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastUse: Schema.optional(VaultEntryUsage),
  /**
   * This environment's own value that a newer change replaced; kept here for 30 days. With
   * `deleted` the entry itself is gone: list still shows it until it is used or deleted.
   */
  previous: Schema.optional(
    Schema.Struct({
      replacedAt: IsoDateTime,
      reason: Schema.Literals(["newer_edit", "deleted"]),
    }),
  ),
  /** Another entry visible to one of the same projects has this name, which only sync can cause. */
  nameConflict: Schema.optional(Schema.Boolean),
});
export type VaultEntrySummary = typeof VaultEntrySummary.Type;

export const VaultListResult = Schema.Struct({
  entries: Schema.Array(VaultEntrySummary),
  /** Entries whose stored record could not be read; each fails alone. */
  unreadable: Schema.Int,
});
export type VaultListResult = typeof VaultListResult.Type;

export const VaultCreateInput = Schema.Struct({
  name: VaultEntryName,
  kind: VaultEntryKind,
  username: Schema.optional(TrimmedNonEmptyString),
  domains: VaultDomains,
  scope: VaultScope,
  value: VaultValue,
});
export type VaultCreateInput = typeof VaultCreateInput.Type;

/** `value` overwrites; omitting it keeps the stored value. `username: null` clears it. */
export const VaultUpdateInput = Schema.Struct({
  id: VaultEntryId,
  name: Schema.optional(VaultEntryName),
  kind: Schema.optional(VaultEntryKind),
  username: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  domains: Schema.optional(VaultDomains),
  scope: Schema.optional(VaultScope),
  value: Schema.optional(VaultValue),
});
export type VaultUpdateInput = typeof VaultUpdateInput.Type;

export const VaultDeleteInput = Schema.Struct({ id: VaultEntryId });
export type VaultDeleteInput = typeof VaultDeleteInput.Type;

export const VaultMatchesForRequestInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
});
export type VaultMatchesForRequestInput = typeof VaultMatchesForRequestInput.Type;

export const VaultRequestMatch = Schema.Struct({
  entry: VaultEntrySummary,
  matchedBy: Schema.Literals(["domain", "name"]),
  /** False for an entry scoped to other projects; answering may add this project. */
  inScope: Schema.Boolean,
});
export type VaultRequestMatch = typeof VaultRequestMatch.Type;

export const VaultMatchesForRequestResult = Schema.Struct({
  matches: Schema.Array(VaultRequestMatch),
  /** Prefill for **Save to vault**: from the request or the thread's preview tab. */
  suggestedName: Schema.optional(VaultEntryName),
  suggestedDomains: VaultDomains,
});
export type VaultMatchesForRequestResult = typeof VaultMatchesForRequestResult.Type;

/** Attached to a typed `secrets.answerRequest` answer to keep the value. */
export const VaultSaveFromRequest = Schema.Struct({
  name: VaultEntryName,
  kind: VaultEntryKind,
  username: Schema.optional(TrimmedNonEmptyString),
  scope: VaultScope,
  domains: VaultDomains,
});
export type VaultSaveFromRequest = typeof VaultSaveFromRequest.Type;

const VAULT_FAILURE_MESSAGES = {
  not_found: "That vault entry no longer exists.",
  name_taken: "Another entry visible to the same projects already has this name.",
  store_failed: "Could not update the vault.",
} as const;

export const VaultFailureReason = Schema.Literals(
  Object.keys(VAULT_FAILURE_MESSAGES) as Array<keyof typeof VAULT_FAILURE_MESSAGES>,
);
export type VaultFailureReason = typeof VaultFailureReason.Type;

export class VaultError extends Schema.TaggedError<VaultError>()("VaultError", {
  reason: VaultFailureReason,
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return VAULT_FAILURE_MESSAGES[this.reason];
  }
}

/** Errors the agent tools return; the MCP layer maps them onto its own failure shape. */
export const VAULT_TOOL_FAILURE_MESSAGES = {
  out_of_scope: "That vault entry is not available in this project. Ask the user to allow it.",
  ambiguous_name: "More than one vault entry has that name. Ask the user which one to use.",
  domain_mismatch: "That secret may not be typed into this page.",
  approval_denied: "The environment owner did not allow this use of the vault.",
  vault_unavailable_on_host:
    "The browser's machine cannot read this vault entry. Turn on vault sync there or use a server browser.",
  not_allowed: "Only the environment owner's runs can use the vault.",
} as const;
export type VaultToolFailureReason = keyof typeof VAULT_TOOL_FAILURE_MESSAGES;

export const VaultPreviousVersionInput = Schema.Struct({ id: VaultEntryId });
export type VaultPreviousVersionInput = typeof VaultPreviousVersionInput.Type;

/**
 * Sync across the account's environments. `unavailable`: this environment is not linked
 * through fwai Connect. `waiting`: joined, until an enrolled environment that is online hands it
 * the vault key. `needs_rejoin`: joined but its keys are missing or unreadable; it never makes new
 * ones in place.
 */
export const VaultSyncState = Schema.Literals([
  "unavailable",
  "off",
  "waiting",
  "on",
  "needs_rejoin",
]);
export type VaultSyncState = typeof VaultSyncState.Type;

export const VaultSyncEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  isThis: Schema.Boolean,
  hasKey: Schema.Boolean,
  enrolledAt: IsoDateTime,
});
export type VaultSyncEnvironment = typeof VaultSyncEnvironment.Type;

export const VaultSyncStatus = Schema.Struct({
  state: VaultSyncState,
  environments: Schema.Array(VaultSyncEnvironment),
  /** Local changes not yet accepted by the relay. */
  pendingUploads: Schema.Int,
  lastSyncedAt: Schema.optional(IsoDateTime),
  /** Why the last sync attempt failed, such as a quota; cleared by the next success. */
  problem: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals([
        "relay_unreachable",
        "quota_entry_size",
        "quota_entry_count",
        "quota_total_size",
      ]),
      entryName: Schema.optional(VaultEntryName),
    }),
  ),
});
export type VaultSyncStatus = typeof VaultSyncStatus.Type;

export const VaultSyncRevokeInput = Schema.Struct({ environmentId: EnvironmentId });
export type VaultSyncRevokeInput = typeof VaultSyncRevokeInput.Type;

const VAULT_SYNC_FAILURE_MESSAGES = {
  not_linked: "Link this environment through fwai Connect to sync secrets.",
  relay_failed: "Could not reach fwai Connect. Try again.",
  not_joined: "This environment does not sync secrets.",
  store_failed: "Could not update the vault.",
} as const;

export const VaultSyncFailureReason = Schema.Literals(
  Object.keys(VAULT_SYNC_FAILURE_MESSAGES) as Array<keyof typeof VAULT_SYNC_FAILURE_MESSAGES>,
);
export type VaultSyncFailureReason = typeof VaultSyncFailureReason.Type;

export class VaultSyncError extends Schema.TaggedError<VaultSyncError>()("VaultSyncError", {
  reason: VaultSyncFailureReason,
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return VAULT_SYNC_FAILURE_MESSAGES[this.reason];
  }
}
