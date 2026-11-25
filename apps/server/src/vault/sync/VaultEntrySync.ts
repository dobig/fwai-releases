// Moves global vault entries between this environment and the relay: a persistent upload queue,
// catch-up from a cursor, conflict resolution by edit time, tombstones and kept previous values.
import {
  IsoDateTime,
  NonNegativeInt,
  VaultEntryId,
  type VaultEntrySummary,
  type VaultError,
} from "@t3tools/contracts";
import {
  RelayVaultConflictError,
  RelayVaultQuotaError,
  type RelayVaultNotEnrolledError,
  VaultSyncCursor,
  type RelayVaultEntryBlob,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as VaultService from "../VaultService.ts";
import { decryptEntry, encryptEntry, vaultKeyFingerprint } from "./VaultCrypto.ts";
import * as VaultEntryRelay from "./VaultEntryRelay.ts";
import { VaultSyncKeys, type VaultKey } from "./VaultSyncKeys.ts";

export interface VaultUploadState {
  readonly pendingUploads: number;
  readonly lastSyncedAt?: string;
  readonly problem?: {
    readonly reason:
      | "relay_unreachable"
      | "quota_entry_size"
      | "quota_entry_count"
      | "quota_total_size";
    readonly entryName?: string;
  };
}

export class VaultEntrySync extends Context.Service<
  VaultEntrySync,
  {
    /** Queues what sync must send; VaultService calls it after every local write. */
    readonly localChanged: (change: VaultService.VaultLocalChange) => Effect.Effect<void>;
    /** Fetch from the cursor and upload the queue; no-op while sync has no key. */
    readonly syncNow: () => Effect.Effect<void>;
    readonly uploadState: () => Effect.Effect<VaultUploadState>;
    /** Makes a kept previous value current again, through a normal new write. */
    readonly usePreviousVersion: (id: VaultEntryId) => Effect.Effect<VaultEntrySummary, VaultError>;
  }
>()("t3/vault/sync/VaultEntrySync") {}

const STATE_SECRET = "vault-sync-entries";
const MAX_ATTEMPTS = 3;

// The relay knows an entry by `entryId`; locally it may have another id, because an entry made
// global again uploads under a new id so it never meets its own tombstone.
const QueuedChange = Schema.Struct({
  entryId: VaultEntryId,
  localId: VaultEntryId,
  kind: Schema.Literals(["upsert", "delete"]),
  baseVersion: NonNegativeInt,
  updatedAt: IsoDateTime,
});
type QueuedChange = typeof QueuedChange.Type;

const SyncState = Schema.Struct({
  /** The vault key's fingerprint the cursor and versions belong to; another key starts over. */
  vault: Schema.optional(Schema.String),
  cursor: Schema.NullOr(VaultSyncCursor),
  lastSyncedAt: Schema.optional(IsoDateTime),
  /** By local id: the relay's id and the relay version the local entry is based on. */
  entries: Schema.Record(
    Schema.String,
    Schema.Struct({ remoteId: VaultEntryId, version: NonNegativeInt }),
  ),
  queue: Schema.Array(QueuedChange),
});
type SyncState = typeof SyncState.Type;
const SyncStateJson = Schema.fromJsonString(SyncState);
const decodeState = Schema.decodeUnknownOption(SyncStateJson);
const encodeState = Schema.encodeSync(SyncStateJson);
const EMPTY_STATE: SyncState = { cursor: null, entries: {}, queue: [] };

const ContentJson = Schema.fromJsonString(VaultService.VaultEntryContent);
const decodeContent = Schema.decodeUnknownOption(ContentJson);
const encodeContent = Schema.encodeSync(ContentJson);

const sameContent = (a: VaultService.VaultEntryContent, b: VaultService.VaultEntryContent) =>
  a.name === b.name &&
  a.kind === b.kind &&
  a.username === b.username &&
  a.value === b.value &&
  a.domains.join("\n") === b.domains.join("\n");

const openBlob = (key: VaultKey, blob: RelayVaultEntryBlob) => {
  try {
    return decodeContent(
      decryptEntry({
        vaultKey: key.key,
        generation: blob.vkGeneration,
        entryId: blob.entryId,
        ciphertext: blob.ciphertext,
      }),
    );
  } catch {
    return Option.none<VaultService.VaultEntryContent>();
  }
};

const fingerprintOf = (key: VaultKey) =>
  vaultKeyFingerprint({ vaultKey: key.key, generation: key.generation });

const isQuotaError = Schema.is(RelayVaultQuotaError);
const isConflictError = Schema.is(RelayVaultConflictError);
const isUnavailable = Schema.is(VaultEntryRelay.VaultRelayUnavailableError);

const editedAfter = (a: string, b: string) => Date.parse(a) > Date.parse(b);

const QUOTA_REASONS = {
  entry_size: "quota_entry_size",
  entry_count: "quota_entry_count",
  total_size: "quota_total_size",
} as const;

const withoutEntry = (state: SyncState, localId: string): SyncState["entries"] =>
  Object.fromEntries(Object.entries(state.entries).filter(([id]) => id !== localId));

const replaceQueued = (state: SyncState, entryId: string, item: QueuedChange | null) => ({
  ...state,
  queue: [
    ...state.queue.filter((queued) => queued.entryId !== entryId),
    ...(item === null ? [] : [item]),
  ],
});

/** Folds one local change into the state: a live global entry uploads, anything else deletes. */
const track = (
  state: SyncState,
  input: {
    readonly localId: VaultEntryId;
    readonly entry: Option.Option<VaultService.VaultStoredEntry>;
    readonly newRemoteId: VaultEntryId;
    readonly now: string;
  },
): SyncState => {
  const mapped = state.entries[input.localId];
  if (Option.isSome(input.entry) && input.entry.value.scope === "global") {
    const remoteId = mapped?.remoteId ?? input.newRemoteId;
    const version = mapped?.version ?? 0;
    return replaceQueued(
      { ...state, entries: { ...state.entries, [input.localId]: { remoteId, version } } },
      remoteId,
      {
        entryId: remoteId,
        localId: input.localId,
        kind: "upsert",
        baseVersion: version,
        updatedAt: input.entry.value.updatedAt,
      },
    );
  }
  if (mapped === undefined) return state;
  return replaceQueued(
    { ...state, entries: withoutEntry(state, input.localId) },
    mapped.remoteId,
    mapped.version === 0
      ? null
      : {
          entryId: mapped.remoteId,
          localId: input.localId,
          kind: "delete",
          baseVersion: mapped.version,
          updatedAt: input.now,
        },
  );
};

const make = Effect.gen(function* () {
  const vault = yield* VaultService.VaultService;
  const keys = yield* VaultSyncKeys;
  const relay = yield* VaultEntryRelay.VaultEntryRelay;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  const stateLock = yield* Semaphore.make(1);
  const problem = yield* Ref.make<VaultUploadState["problem"]>(undefined);
  // What the run holding the entry lock has hit so far; published to `problem` when the run ends.
  const found = yield* Ref.make<VaultUploadState["problem"]>(undefined);

  const stored = yield* store.get(STATE_SECRET).pipe(Effect.orElseSucceed(Option.none));
  const state = yield* Ref.make(
    Option.getOrElse(
      Option.flatMap(stored, (bytes) => decodeState(new TextDecoder().decode(bytes))),
      () => EMPTY_STATE,
    ),
  );

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const newId = crypto.randomUUIDv4().pipe(Effect.map((uuid) => VaultEntryId.make(uuid)));

  // The queue lives in memory and on disk together; a failed write is logged, and the next
  // change or sync writes the whole state again.
  const updateState = (apply: (current: SyncState) => SyncState) =>
    stateLock.withPermits(1)(
      Effect.gen(function* () {
        const next = apply(yield* Ref.get(state));
        yield* Ref.set(state, next);
        yield* store
          .set(STATE_SECRET, new TextEncoder().encode(encodeState(next)))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("vault sync could not persist its queue", { cause }),
            ),
          );
      }),
    );

  const decrypt = (key: VaultKey, blob: RelayVaultEntryBlob) => {
    const content = openBlob(key, blob);
    return Option.isSome(content)
      ? Effect.succeed(content)
      : Effect.logWarning("vault sync skipped an entry it could not decrypt", {
          entryId: blob.entryId,
        }).pipe(Effect.as(content));
  };

  // Helpers below run inside syncNow's or upload's span, so they add none of their own.

  /**
   * Settles a remote version against the local entry by edit time. `pending` is the queued local
   * change it met, if any. A local write in between makes VaultService refuse; that write is queued.
   */
  const resolve = Effect.fnUntraced(function* (
    key: VaultKey,
    localId: VaultEntryId,
    remote: RelayVaultEntryBlob,
    options: { readonly pending?: QueuedChange; readonly keepPrevious: boolean },
  ) {
    const { pending, keepPrevious } = options;
    const local = yield* vault.readStored(localId);
    const stillPending = (current: SyncState) => {
      const queued = current.queue.find((item) => item.entryId === remote.entryId);
      return pending === undefined
        ? queued === undefined
        : queued?.kind === pending.kind &&
            queued.localId === pending.localId &&
            queued.updatedAt === pending.updatedAt;
    };
    if (remote.deleted) {
      if (Option.isSome(local)) {
        const applied = yield* vault.applyRemoteDelete(localId, {
          keepPrevious,
          expectedVersion: local.value.version,
        });
        if (!applied) return "settled" as const;
      }
      yield* updateState((current) => {
        const next =
          current.entries[localId]?.remoteId === remote.entryId
            ? { ...current, entries: withoutEntry(current, localId) }
            : current;
        return stillPending(current) ? replaceQueued(next, remote.entryId, null) : next;
      });
      return "settled" as const;
    }
    const content = yield* decrypt(key, remote);
    const winner =
      Option.isSome(local) &&
      (Option.isNone(content) || editedAfter(local.value.updatedAt, content.value.updatedAt))
        ? local
        : Option.none<VaultService.VaultStoredEntry>();
    if (Option.isNone(winner) && Option.isSome(local) && Option.isSome(content)) {
      if (!sameContent(VaultService.entryContent(local.value), content.value)) {
        const applied = yield* vault.applyRemote(localId, content.value, {
          keepPrevious,
          expectedVersion: local.value.version,
        });
        if (!applied) return "settled" as const;
      }
    }
    yield* updateState((current) => {
      const mapped = current.entries[localId];
      const entries =
        mapped?.remoteId === remote.entryId || (mapped === undefined && Option.isSome(local))
          ? {
              ...current.entries,
              [localId]: { remoteId: remote.entryId, version: remote.version },
            }
          : current.entries;
      const next = { ...current, entries };
      if (!stillPending(current)) return next;
      return replaceQueued(
        next,
        remote.entryId,
        Option.isSome(winner)
          ? {
              entryId: remote.entryId,
              localId,
              kind: "upsert",
              baseVersion: remote.version,
              updatedAt: winner.value.updatedAt,
            }
          : null,
      );
    });
    return Option.isSome(winner) ? ("local_wins" as const) : ("settled" as const);
  });

  const uploaded = (item: QueuedChange, updatedAt: string, version: number) =>
    updateState((current) => {
      const queued = current.queue.find((candidate) => candidate.entryId === item.entryId);
      const mapped = current.entries[item.localId];
      if (mapped?.remoteId === item.entryId) {
        const entries = { ...current.entries, [item.localId]: { ...mapped, version } };
        const done = queued?.kind === "upsert" && queued.updatedAt === updatedAt;
        return replaceQueued(
          { ...current, entries },
          item.entryId,
          done || queued === undefined ? null : { ...queued, baseVersion: version },
        );
      }
      // Deleted or made project-only while the upload was in flight: the tombstone follows.
      return replaceQueued(current, item.entryId, {
        entryId: item.entryId,
        localId: item.localId,
        kind: "delete",
        baseVersion: version,
        updatedAt,
      });
    });

  const failed = Effect.fnUntraced(function* (
    error:
      | VaultEntryRelay.VaultRelayUnavailableError
      | RelayVaultQuotaError
      | RelayVaultNotEnrolledError,
    entryName: string | undefined,
  ) {
    if (isQuotaError(error)) {
      yield* Ref.set(found, {
        reason: QUOTA_REASONS[error.limit],
        ...(entryName === undefined ? {} : { entryName }),
      });
      return "skip" as const;
    }
    if (isUnavailable(error)) {
      yield* Ref.set(found, { reason: "relay_unreachable" });
    }
    return "stop" as const;
  });

  const uploadOne = Effect.fnUntraced(function* (key: VaultKey, queued: QueuedChange) {
    let baseVersion = queued.baseVersion;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const item: QueuedChange = { ...queued, baseVersion };
      const entry =
        item.kind === "upsert"
          ? Option.filter(yield* vault.readStored(item.localId), (live) => live.scope === "global")
          : Option.none();
      // Gone or project-only since it was queued: the delete that change queued replaces this.
      if (item.kind === "upsert" && Option.isNone(entry)) return "ok" as const;
      const ciphertext = Option.isSome(entry)
        ? encryptEntry({
            vaultKey: key.key,
            generation: key.generation,
            entryId: item.entryId,
            plaintext: encodeContent(VaultService.entryContent(entry.value)),
          })
        : "";
      const result = yield* relay
        .put(item.entryId, {
          expectedVersion: item.baseVersion,
          deleted: item.kind === "delete",
          vkGeneration: key.generation,
          ciphertext,
        })
        .pipe(Effect.result);
      if (result._tag === "Success") {
        if (Option.isSome(entry)) {
          yield* uploaded(item, entry.value.updatedAt, result.success.version);
        } else {
          // A tombstoned id is never uploaded again, so whatever is queued under it is done.
          yield* updateState((current) => replaceQueued(current, item.entryId, null));
        }
        return "ok" as const;
      }
      const error = result.failure;
      if (!isConflictError(error)) {
        const entryName = Option.isSome(entry) ? entry.value.name : undefined;
        return (yield* failed(error, entryName)) === "skip" ? ("ok" as const) : ("stop" as const);
      }
      // The key rotated under us; keyChanges brings the new one and runs syncNow again.
      if (error.code === "generation_stale") return "stop" as const;
      const remote = error.current;
      if (item.kind === "delete") {
        // A local delete wins over any edit.
        if (remote === undefined || remote.deleted) {
          yield* updateState((current) => replaceQueued(current, item.entryId, null));
          return "ok" as const;
        }
        baseVersion = remote.version;
        yield* updateState((current) =>
          replaceQueued(current, item.entryId, { ...item, baseVersion }),
        );
        continue;
      }
      if (remote === undefined) {
        baseVersion = 0;
        continue;
      }
      const resolved = yield* resolve(key, item.localId, remote, {
        pending: item,
        keepPrevious: true,
      });
      if (resolved === "settled") return "ok" as const;
      baseVersion = remote.version;
    }
    return "ok" as const;
  });

  const drain = Effect.fnUntraced(function* (key: VaultKey) {
    for (const { entryId } of (yield* Ref.get(state)).queue) {
      const item = (yield* Ref.get(state)).queue.find((queued) => queued.entryId === entryId);
      if (item === undefined) continue;
      if ((yield* uploadOne(key, item)) === "stop") return "stop" as const;
    }
    return "ok" as const;
  });

  /** `fresh`: catching up from scratch, so local versions say nothing about the relay's. */
  const applyBlob = Effect.fnUntraced(function* (
    key: VaultKey,
    blob: RelayVaultEntryBlob,
    fresh: boolean,
  ) {
    const current = yield* Ref.get(state);
    const queued = current.queue.find((item) => item.entryId === blob.entryId);
    if (queued !== undefined) {
      if (!fresh && blob.version <= queued.baseVersion) return;
      if (queued.kind === "delete") {
        yield* updateState((latest) =>
          replaceQueued(
            latest,
            blob.entryId,
            blob.deleted ? null : { ...queued, baseVersion: blob.version },
          ),
        );
        return;
      }
      yield* resolve(key, queued.localId, blob, { pending: queued, keepPrevious: true });
      return;
    }
    const localId = Object.entries(current.entries).find(
      ([, mapped]) => mapped.remoteId === blob.entryId,
    )?.[0];
    const mapped = localId === undefined ? undefined : current.entries[localId];
    if (localId !== undefined && mapped !== undefined) {
      const id = VaultEntryId.make(localId);
      if (fresh) {
        yield* resolve(key, id, blob, { keepPrevious: false });
        return;
      }
      if (blob.version <= mapped.version) return;
      const local = yield* vault.readStored(id);
      const setVersion = updateState((latest) => ({
        ...latest,
        entries: {
          ...latest.entries,
          [localId]: { remoteId: blob.entryId, version: blob.version },
        },
      }));
      if (blob.deleted) {
        if (
          Option.isSome(local) &&
          !(yield* vault.applyRemoteDelete(id, {
            keepPrevious: false,
            expectedVersion: local.value.version,
          }))
        ) {
          return;
        }
        yield* updateState((latest) => ({ ...latest, entries: withoutEntry(latest, localId) }));
        return;
      }
      const content = yield* decrypt(key, blob);
      if (Option.isNone(content)) return;
      // Gone locally without a queued delete: the delete wins, and reconcile queues it.
      if (Option.isNone(local)) return yield* setVersion;
      const applied = yield* vault.applyRemote(id, content.value, {
        keepPrevious: false,
        expectedVersion: local.value.version,
      });
      if (applied) yield* setVersion;
      return;
    }
    const sameId = yield* vault.readStored(blob.entryId);
    if (
      Option.isSome(sameId) &&
      sameId.value.scope === "global" &&
      current.entries[blob.entryId] === undefined
    ) {
      // This environment's copy of the entry with its mapping lost: settle it, never copy it.
      yield* resolve(key, blob.entryId, blob, { keepPrevious: true });
      return;
    }
    if (blob.deleted) return;
    const content = yield* decrypt(key, blob);
    if (Option.isNone(content)) return;
    const id = Option.isSome(sameId) ? yield* newId : blob.entryId;
    // Entry first, then the mapping: a crash in between re-uploads a copy instead of deleting it.
    const applied = yield* vault.applyRemote(id, content.value, {
      keepPrevious: false,
      expectedVersion: null,
    });
    if (!applied) return;
    yield* updateState((latest) => ({
      ...latest,
      entries: { ...latest.entries, [id]: { remoteId: blob.entryId, version: blob.version } },
    }));
  });

  /** `seen` collects every entry the relay has while catching up from scratch. */
  const catchUp = Effect.fnUntraced(function* (key: VaultKey, seen: Set<string> | null) {
    for (;;) {
      const page = yield* relay.list((yield* Ref.get(state)).cursor).pipe(Effect.result);
      if (page._tag === "Failure") {
        if (isUnavailable(page.failure)) {
          yield* Ref.set(found, { reason: "relay_unreachable" });
        }
        return "stop" as const;
      }
      for (const blob of page.success.entries) {
        // Tombstones carry nothing to open, so they apply at any generation. A newer live one
        // waits, cursor unmoved, for the key keyChanges brings.
        if (!blob.deleted && blob.vkGeneration > key.generation) return "stop" as const;
        if (!blob.deleted && blob.vkGeneration < key.generation) {
          yield* Effect.logWarning("vault sync skipped an entry sealed under an older key", {
            entryId: blob.entryId,
          });
          continue;
        }
        seen?.add(blob.entryId);
        yield* applyBlob(key, blob, seen !== null);
      }
      yield* updateState((latest) => ({ ...latest, cursor: page.success.cursor }));
      if (!page.success.hasMore) return "ok" as const;
    }
  });

  /**
   * After a full catch-up into a vault this environment did not know: every mapped global entry
   * the relay lacks uploads again as new, and queued deletes of what it lacks are dropped.
   */
  const resettle = Effect.fnUntraced(function* (seen: ReadonlySet<string>) {
    const { entries: live, unreadableIds } = yield* vault.listStored();
    yield* updateState((current) => {
      const queue = current.queue
        .filter((item) => seen.has(item.entryId) || item.kind === "upsert")
        .map((item) => (seen.has(item.entryId) ? item : { ...item, baseVersion: 0 }));
      const entries = Object.fromEntries(
        Object.entries(current.entries).flatMap(([localId, mapped]) => {
          if (seen.has(mapped.remoteId)) return [[localId, mapped] as const];
          const local = live.find((entry) => entry.id === localId);
          if (local?.scope === "global") {
            if (!queue.some((item) => item.entryId === mapped.remoteId)) {
              queue.push({
                entryId: mapped.remoteId,
                localId: local.id,
                kind: "upsert",
                baseVersion: 0,
                updatedAt: local.updatedAt,
              });
            }
            return [[localId, { ...mapped, version: 0 }] as const];
          }
          return unreadableIds.has(localId) ? [[localId, { ...mapped, version: 0 }] as const] : [];
        }),
      );
      return { ...current, entries, queue };
    });
  });

  /** Local global entries the relay has never seen, and mapped ones that vanished meanwhile. */
  const reconcile = Effect.fnUntraced(function* () {
    const { entries, unreadableIds } = yield* vault.listStored();
    const now = yield* nowIso;
    const current = yield* Ref.get(state);
    for (const entry of entries) {
      if (entry.scope !== "global" || current.entries[entry.id] !== undefined) continue;
      const newRemoteId = yield* newId;
      yield* updateState((latest) =>
        track(latest, { localId: entry.id, entry: Option.some(entry), newRemoteId, now }),
      );
    }
    for (const [localId, mapped] of Object.entries(current.entries)) {
      const live = entries.find((entry) => entry.id === localId);
      if (live?.scope === "global") continue;
      // Still in the store but unreadable: not a delete.
      if (live === undefined && unreadableIds.has(localId)) continue;
      if (current.queue.some((item) => item.entryId === mapped.remoteId)) continue;
      yield* updateState((latest) =>
        track(latest, {
          localId: VaultEntryId.make(localId),
          entry: Option.none(),
          newRemoteId: mapped.remoteId,
          now,
        }),
      );
    }
  });

  const runLogged = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => Effect.logWarning("vault sync failed", { cause })),
    );

  const syncNow: VaultEntrySync["Service"]["syncNow"] = Effect.fn("VaultEntrySync.syncNow")(
    function* () {
      const key = yield* keys.currentKey();
      if (Option.isNone(key)) return;
      yield* Ref.set(found, undefined);
      const fingerprint = fingerprintOf(key.value);
      const seen = (yield* Ref.get(state)).vault === fingerprint ? null : new Set<string>();
      if (seen !== null) yield* updateState((latest) => ({ ...latest, cursor: null }));
      const caughtUp = yield* catchUp(key.value, seen);
      if (seen !== null && caughtUp === "ok") {
        yield* resettle(seen);
        yield* updateState((latest) => ({ ...latest, vault: fingerprint }));
      }
      yield* reconcile();
      const drained = yield* drain(key.value);
      const hit = yield* Ref.get(found);
      if (caughtUp === "ok" && drained === "ok" && hit === undefined) {
        const now = yield* nowIso;
        yield* updateState((latest) => ({ ...latest, lastSyncedAt: now }));
      }
      yield* Ref.set(problem, hit);
    },
    runLogged,
    keys.withEntryLock,
  );

  const upload = Effect.fn("VaultEntrySync.upload")(
    function* () {
      const key = yield* keys.currentKey();
      if (Option.isNone(key)) return;
      yield* Ref.set(found, undefined);
      yield* drain(key.value);
      yield* Ref.set(problem, yield* Ref.get(found));
    },
    runLogged,
    keys.withEntryLock,
  );

  const localChanged: VaultEntrySync["Service"]["localChanged"] = Effect.fn(
    "VaultEntrySync.localChanged",
  )(function* (change) {
    const entry =
      change.kind === "upsert" ? yield* vault.readStored(change.entryId) : Option.none();
    // Without a key only entries the relay already has are queued; the first sync adds the rest.
    const syncing = Option.isSome(yield* keys.currentKey());
    if (!syncing && (yield* Ref.get(state)).entries[change.entryId] === undefined) return;
    const newRemoteId = yield* newId;
    const now = yield* nowIso;
    yield* updateState((current) =>
      track(current, { localId: change.entryId, entry, newRemoteId, now }),
    );
    yield* Effect.forkIn(upload(), scope);
  }, runLogged);

  const uploadState: VaultEntrySync["Service"]["uploadState"] = () =>
    Effect.all([Ref.get(state), Ref.get(problem)]).pipe(
      Effect.map(([current, currentProblem]) => ({
        pendingUploads: current.queue.length,
        ...(current.lastSyncedAt === undefined ? {} : { lastSyncedAt: current.lastSyncedAt }),
        ...(currentProblem === undefined ? {} : { problem: currentProblem }),
      })),
    );

  const usePreviousVersion: VaultEntrySync["Service"]["usePreviousVersion"] = Effect.fn(
    "VaultEntrySync.usePreviousVersion",
  )(function* (id) {
    return yield* vault.usePrevious(id);
  });

  yield* vault.onLocalChange(localChanged);

  // keyChanges starts with the current key; startup catch-up is VaultSyncTriggers' job, so only
  // a new key syncs. Leaving keeps the mapping, so a later join settles entries instead of copying.
  const lastKey = yield* Ref.make(Option.map(yield* keys.currentKey(), fingerprintOf));
  yield* keys.keyChanges.pipe(
    Stream.runForEach((key) =>
      Effect.gen(function* () {
        const next = Option.map(key, fingerprintOf);
        const before = yield* Ref.getAndSet(lastKey, next);
        if (Option.isSome(next) && !Option.contains(before, next.value)) yield* syncNow();
      }),
    ),
    Effect.forkScoped,
  );

  return VaultEntrySync.of({ localChanged, syncNow, uploadState, usePreviousVersion });
});

export const layer = Layer.effect(VaultEntrySync, make);
