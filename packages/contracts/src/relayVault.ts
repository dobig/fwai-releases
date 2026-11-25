import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { VaultEntryId } from "./vault.ts";

/**
 * fwai: vault sync through the relay. The relay stores only ciphertext and wrapped keys,
 * keyed by account; every endpoint takes a linked environment's credential. Environments do all
 * cryptography; there is no recovery code, so a vault whose every environment is lost is gone.
 */

export const VAULT_SYNC_MAX_CIPHERTEXT_BYTES = 64 * 1024;
export const VAULT_SYNC_MAX_ENTRIES = 1000;
export const VAULT_SYNC_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const VAULT_SYNC_PAGE_SIZE = 200;

/** Opaque per-account change counter, compared only for equality and sent back as `since`. */
export const VaultSyncCursor = TrimmedNonEmptyString.check(Schema.isMaxLength(32));
export type VaultSyncCursor = typeof VaultSyncCursor.Type;

/** base64url. */
const Base64Url = Schema.String.check(
  Schema.isMaxLength(Math.ceil((VAULT_SYNC_MAX_CIPHERTEXT_BYTES * 4) / 3) + 4),
);

/** An environment's X25519 public key, base64url of the 32 raw bytes. */
export const VaultEncryptionKey = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
/** The vault key sealed to one environment's encryption key. */
export const VaultWrappedKey = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

export const RelayVaultEntryBlob = Schema.Struct({
  entryId: VaultEntryId,
  version: NonNegativeInt,
  deleted: Schema.Boolean,
  vkGeneration: NonNegativeInt,
  /** Empty for a tombstone. */
  ciphertext: Base64Url,
  /** Relay time of the write; not the edit time, which is inside the ciphertext. */
  storedAt: TrimmedNonEmptyString,
});
export type RelayVaultEntryBlob = typeof RelayVaultEntryBlob.Type;

export const RelayVaultEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  encryptionKey: VaultEncryptionKey,
  /** False until an enrolled environment seals the current vault key to it. */
  hasKey: Schema.Boolean,
  enrolledAt: TrimmedNonEmptyString,
});
export type RelayVaultEnvironment = typeof RelayVaultEnvironment.Type;

export const RelayVaultState = Schema.Struct({
  /** Whether the account has any enrolled environment; false means sync is off. */
  active: Schema.Boolean,
  vkGeneration: NonNegativeInt,
  /** The current vault key sealed to the caller; null when the caller is not enrolled or waits. */
  wrappedKey: Schema.NullOr(VaultWrappedKey),
  cursor: Schema.NullOr(VaultSyncCursor),
  environments: Schema.Array(RelayVaultEnvironment),
});
export type RelayVaultState = typeof RelayVaultState.Type;

/**
 * Registers or re-registers the caller's encryption key. With no environment enrolled yet the
 * caller starts the vault at generation 1 and must seal its own key with `putVaultKey`.
 */
export const RelayVaultEnrollRequest = Schema.Struct({ encryptionKey: VaultEncryptionKey });

/** `encryptionKey` is the target key the sealer used; a stale one is refused. */
export const RelayVaultPutKeyRequest = Schema.Struct({
  vkGeneration: NonNegativeInt,
  encryptionKey: VaultEncryptionKey,
  wrappedKey: VaultWrappedKey,
});

export const RelayVaultEntriesQuery = Schema.Struct({ since: Schema.optional(VaultSyncCursor) });
export const RelayVaultEntriesResponse = Schema.Struct({
  entries: Schema.Array(RelayVaultEntryBlob),
  cursor: Schema.NullOr(VaultSyncCursor),
  hasMore: Schema.Boolean,
});
export type RelayVaultEntriesResponse = typeof RelayVaultEntriesResponse.Type;

/** `expectedVersion: 0` creates. A delete sends `deleted: true` and an empty ciphertext. */
export const RelayVaultPutEntryRequest = Schema.Struct({
  expectedVersion: NonNegativeInt,
  deleted: Schema.Boolean,
  vkGeneration: NonNegativeInt,
  ciphertext: Base64Url,
});
export const RelayVaultPutEntryResponse = Schema.Struct({
  version: NonNegativeInt,
  cursor: VaultSyncCursor,
});

/**
 * Applied atomically. `entries` must name every live entry at the version the rotator re-encrypted
 * and `wrappedKeys` plus `revokeEnvironmentIds` every enrolled environment at the key it sealed to;
 * anything else is refused with `version_conflict`, so the rotator refreshes and tries again.
 */
export const RelayVaultRotateRequest = Schema.Struct({
  fromGeneration: NonNegativeInt,
  entries: Schema.Array(
    Schema.Struct({ entryId: VaultEntryId, version: NonNegativeInt, ciphertext: Base64Url }),
  ),
  wrappedKeys: Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      encryptionKey: VaultEncryptionKey,
      wrappedKey: VaultWrappedKey,
    }),
  ),
  revokeEnvironmentIds: Schema.Array(EnvironmentId),
});

export class RelayVaultConflictError extends Schema.TaggedError<RelayVaultConflictError>()(
  "RelayVaultConflictError",
  {
    code: Schema.Literals(["version_conflict", "generation_stale"]),
    /** For `version_conflict`: the entry as the relay holds it. */
    current: Schema.optional(RelayVaultEntryBlob),
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class RelayVaultQuotaError extends Schema.TaggedError<RelayVaultQuotaError>()(
  "RelayVaultQuotaError",
  {
    code: Schema.Literal("vault_quota_exceeded"),
    limit: Schema.Literals(["entry_size", "entry_count", "total_size"]),
    message: Schema.String,
  },
  { httpApiStatus: 413 },
) {}

export class RelayVaultNotEnrolledError extends Schema.TaggedError<RelayVaultNotEnrolledError>()(
  "RelayVaultNotEnrolledError",
  {
    code: Schema.Literal("not_enrolled"),
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {}

/** Where the relay posts a `vault.changed` hint on an environment, through its tunnel. */
export const RELAY_VAULT_CHANGED_ROUTE = "/api/vault/changed";

/** The hint carries no data: the environment fetches from its own cursor. */
export const RelayVaultChangedDelivery = Schema.Struct({
  targetEnvironmentId: EnvironmentId,
  cursor: VaultSyncCursor,
});
export type RelayVaultChangedDelivery = typeof RelayVaultChangedDelivery.Type;
