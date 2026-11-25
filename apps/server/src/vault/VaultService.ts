// fwai: the secrets vault on one environment. Entries live in ServerSecretStore as
// plain JSON (0600), one secret per entry; usage lives beside them so a use never bumps
// `version`. Nothing here returns a value except `readValue` and the sync-only methods, which
// never cross an RPC.
import {
  IsoDateTime,
  VaultDomains,
  VaultEntryId,
  VaultEntryKind,
  VaultEntryName,
  VaultEntryUsage,
  VaultError,
  VaultScope,
  type ProjectId,
  type VaultCreateInput,
  type VaultEntrySummary,
  type VaultListResult,
  type VaultUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Domains from "./domains.ts";

export type VaultLookup =
  | { readonly type: "ok"; readonly entry: VaultEntrySummary }
  | { readonly type: "not_found" }
  | { readonly type: "out_of_scope"; readonly entry: VaultEntrySummary }
  | { readonly type: "ambiguous_name"; readonly entries: ReadonlyArray<VaultEntrySummary> };

/** What sync uploads, encrypted: everything but scope, version and usage. */
export const VaultEntryContent = Schema.Struct({
  name: VaultEntryName,
  kind: VaultEntryKind,
  username: Schema.optional(Schema.String),
  domains: VaultDomains,
  value: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type VaultEntryContent = typeof VaultEntryContent.Type;

/** A local write as sync sees it: an entry that is no longer global counts as deleted. */
export interface VaultLocalChange {
  readonly entryId: VaultEntryId;
  readonly kind: "upsert" | "delete";
}

export class VaultService extends Context.Service<
  VaultService,
  {
    readonly list: () => Effect.Effect<VaultListResult, VaultError>;
    readonly get: (id: VaultEntryId) => Effect.Effect<VaultEntrySummary, VaultError>;
    readonly create: (input: VaultCreateInput) => Effect.Effect<VaultEntrySummary, VaultError>;
    readonly update: (input: VaultUpdateInput) => Effect.Effect<VaultEntrySummary, VaultError>;
    readonly delete: (id: VaultEntryId) => Effect.Effect<void, VaultError>;
    /** Entries a project's agents may use: global ones and those scoped to it. */
    readonly entriesForProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<VaultEntrySummary>, VaultError>;
    /** Exact name lookup from a project; also reports entries scoped to other projects. */
    readonly findByName: (input: {
      readonly projectId: ProjectId;
      readonly name: string;
    }) => Effect.Effect<VaultLookup, VaultError>;
    /** Adds a project to a project-scoped entry; a global entry is left as is. */
    readonly allowProject: (input: {
      readonly id: VaultEntryId;
      readonly projectId: ProjectId;
    }) => Effect.Effect<VaultEntrySummary, VaultError>;
    /** Server-internal. Never return this from an RPC, log it, or put it in a span. */
    readonly readValue: (id: VaultEntryId) => Effect.Effect<string, VaultError>;
    readonly recordUse: (
      id: VaultEntryId,
      usage: VaultEntryUsage,
    ) => Effect.Effect<void, VaultError>;
    /** Whether a value may be typed into a page at `url` (domain binding, https, PSL). */
    readonly originAllowed: (input: {
      readonly id: VaultEntryId;
      readonly url: string;
    }) => Effect.Effect<boolean, VaultError>;
    /** Makes the kept previous value current through a normal write; a deleted one gets a new id. */
    readonly usePrevious: (id: VaultEntryId) => Effect.Effect<VaultEntrySummary, VaultError>;
    // Sync only. These carry values: never return them from an RPC, log them or span them.
    /** Called after every local write, inside the write lock; sync registers its queue here. */
    readonly onLocalChange: (
      handler: (change: VaultLocalChange) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
    readonly readStored: (
      id: VaultEntryId,
    ) => Effect.Effect<Option.Option<VaultStoredEntry>, VaultError>;
    /** `unreadableIds` exist in the store but do not read or decode: they are not deleted. */
    readonly listStored: () => Effect.Effect<
      {
        readonly entries: ReadonlyArray<VaultStoredEntry>;
        readonly unreadableIds: ReadonlySet<string>;
      },
      VaultError
    >;
    /**
     * Writes another environment's version as a global entry with its timestamps, without a name
     * check, a usage change or a change event. `keepPrevious` keeps the replaced local value.
     * Applies only while the local entry is still the global one at `expectedVersion` (null: no
     * entry); otherwise it returns false and the local change, already queued, goes through sync.
     */
    readonly applyRemote: (
      id: VaultEntryId,
      content: VaultEntryContent,
      options: { readonly keepPrevious: boolean; readonly expectedVersion: number | null },
    ) => Effect.Effect<boolean, VaultError>;
    /** Deletes for a remote tombstone, without a change event, on the same terms as applyRemote. */
    readonly applyRemoteDelete: (
      id: VaultEntryId,
      options: { readonly keepPrevious: boolean; readonly expectedVersion: number },
    ) => Effect.Effect<boolean, VaultError>;
  }
>()("t3/vault/VaultService") {}

const ENTRY_PREFIX = "vault-entry-";
const USAGE_PREFIX = "vault-usage-";
const PREVIOUS_PREFIX = "vault-previous-";
const PREVIOUS_KEPT_FOR = Duration.days(30);
// Ids name files in the secrets directory, so anything else is treated as missing.
const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const StoredEntry = Schema.Struct({
  id: VaultEntryId,
  name: VaultEntryName,
  kind: VaultEntryKind,
  username: Schema.optional(Schema.String),
  domains: VaultDomains,
  scope: VaultScope,
  value: Schema.String,
  version: Schema.Int,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
type StoredEntry = typeof StoredEntry.Type;
export type VaultStoredEntry = StoredEntry;
const StoredEntryJson = Schema.fromJsonString(StoredEntry);
const decodeEntry = Schema.decodeUnknownOption(StoredEntryJson);
const encodeEntry = Schema.encodeSync(StoredEntryJson);
const UsageJson = Schema.fromJsonString(VaultEntryUsage);
const decodeUsage = Schema.decodeUnknownOption(UsageJson);
const encodeUsage = Schema.encodeSync(UsageJson);

// A local value that lost to another environment's change. With `deleted` the entry itself is
// gone, so list shows the kept value alone until it is used or deleted.
const PreviousValue = Schema.Struct({
  ...VaultEntryContent.fields,
  version: Schema.Int,
  replacedAt: IsoDateTime,
  reason: Schema.Literals(["newer_edit", "deleted"]),
});
type PreviousValue = typeof PreviousValue.Type;
const PreviousJson = Schema.fromJsonString(PreviousValue);
const decodePrevious = Schema.decodeUnknownOption(PreviousJson);
const encodePrevious = Schema.encodeSync(PreviousJson);

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const storeFailed = (cause: unknown) => new VaultError({ reason: "store_failed", cause });
const notFound = () => new VaultError({ reason: "not_found" });

const inScope = (scope: VaultScope, projectId: ProjectId) =>
  scope === "global" || scope.projects.includes(projectId);

const scopesOverlap = (a: VaultScope, b: VaultScope) =>
  a === "global" ||
  b === "global" ||
  a.projects.some((projectId) => b.projects.includes(projectId));

const collides = (
  a: Pick<StoredEntry, "id" | "name" | "scope">,
  b: Pick<StoredEntry, "id" | "name" | "scope">,
) => a.id !== b.id && a.name === b.name && scopesOverlap(a.scope, b.scope);

export const entryContent = (entry: StoredEntry): VaultEntryContent => ({
  name: entry.name,
  kind: entry.kind,
  ...(entry.username === undefined ? {} : { username: entry.username }),
  domains: entry.domains,
  value: entry.value,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
});

const toSummary = (
  entry: StoredEntry,
  lastUse: Option.Option<VaultEntryUsage>,
  nameConflict: boolean,
  previous: Option.Option<PreviousValue>,
): VaultEntrySummary => ({
  id: entry.id,
  name: entry.name,
  kind: entry.kind,
  ...(entry.username === undefined ? {} : { username: entry.username }),
  domains: entry.domains,
  scope: entry.scope,
  version: entry.version,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
  ...(Option.isSome(lastUse) ? { lastUse: lastUse.value } : {}),
  ...(Option.isSome(previous)
    ? { previous: { replacedAt: previous.value.replacedAt, reason: previous.value.reason } }
    : {}),
  ...(nameConflict ? { nameConflict } : {}),
});

const fromPrevious = (id: VaultEntryId, previous: PreviousValue): StoredEntry => ({
  id,
  name: previous.name,
  kind: previous.kind,
  ...(previous.username === undefined ? {} : { username: previous.username }),
  domains: previous.domains,
  scope: "global",
  value: previous.value,
  version: previous.version,
  createdAt: previous.createdAt,
  updatedAt: previous.updatedAt,
});

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const writeLock = yield* Semaphore.make(1);
  const changeHandler = yield* Ref.make<(change: VaultLocalChange) => Effect.Effect<void>>(
    () => Effect.void,
  );

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const emit = (entry: Pick<StoredEntry, "id" | "scope"> | VaultEntryId) =>
    Effect.flatMap(Ref.get(changeHandler), (handler) =>
      handler(
        typeof entry === "string"
          ? { entryId: entry, kind: "delete" }
          : { entryId: entry.id, kind: entry.scope === "global" ? "upsert" : "delete" },
      ),
    );

  // Helpers below run inside the public operations' spans, so they add none of their own.
  const readEntry = Effect.fnUntraced(function* (id: string) {
    if (!ENTRY_ID_PATTERN.test(id)) return yield* notFound();
    const stored = yield* store.get(`${ENTRY_PREFIX}${id}`).pipe(Effect.mapError(storeFailed));
    if (Option.isNone(stored)) return yield* notFound();
    return yield* Effect.fromOption(decodeEntry(textDecoder.decode(stored.value))).pipe(
      Effect.mapError(() => storeFailed(undefined)),
    );
  });

  const readUsage = (id: string) =>
    store
      .get(`${USAGE_PREFIX}${id}`)
      .pipe(
        Effect.map(Option.flatMap((bytes) => decodeUsage(textDecoder.decode(bytes)))),
        Effect.orElseSucceed(Option.none),
      );

  const writeEntry = (entry: StoredEntry) =>
    store
      .set(`${ENTRY_PREFIX}${entry.id}`, textEncoder.encode(encodeEntry(entry)))
      .pipe(Effect.mapError(storeFailed));

  const readPrevious = Effect.fnUntraced(function* (id: string) {
    const stored = yield* store
      .get(`${PREVIOUS_PREFIX}${id}`)
      .pipe(
        Effect.map(Option.flatMap((bytes) => decodePrevious(textDecoder.decode(bytes)))),
        Effect.orElseSucceed(Option.none),
      );
    if (Option.isNone(stored)) return stored;
    const now = yield* DateTime.now;
    const age =
      DateTime.toEpochMillis(now) -
      DateTime.toEpochMillis(DateTime.makeUnsafe(stored.value.replacedAt));
    if (age > Duration.toMillis(PREVIOUS_KEPT_FOR)) {
      yield* store.remove(`${PREVIOUS_PREFIX}${id}`).pipe(Effect.ignore);
      return Option.none<PreviousValue>();
    }
    return stored;
  });

  const keepPrevious = Effect.fnUntraced(function* (
    entry: StoredEntry,
    reason: PreviousValue["reason"],
  ) {
    const previous: PreviousValue = {
      ...entryContent(entry),
      version: entry.version,
      replacedAt: yield* nowIso,
      reason,
    };
    yield* store
      .set(`${PREVIOUS_PREFIX}${entry.id}`, textEncoder.encode(encodePrevious(previous)))
      .pipe(Effect.mapError(storeFailed));
  });

  const dropPrevious = (id: string) => store.remove(`${PREVIOUS_PREFIX}${id}`).pipe(Effect.ignore);

  // Kept values whose entry is gone; list shows them so Use this version can bring them back.
  const readOrphanedPrevious = Effect.fnUntraced(function* (live: ReadonlyArray<StoredEntry>) {
    if (store.listNames === undefined) return [];
    const names = yield* store.listNames(PREVIOUS_PREFIX).pipe(Effect.orElseSucceed(() => []));
    const orphans: Array<{ readonly entry: StoredEntry; readonly previous: PreviousValue }> = [];
    for (const name of names) {
      const id = VaultEntryId.make(name.slice(PREVIOUS_PREFIX.length));
      if (live.some((entry) => entry.id === id)) continue;
      const previous = yield* readPrevious(id);
      if (Option.isSome(previous))
        orphans.push({ entry: fromPrevious(id, previous.value), previous: previous.value });
    }
    return orphans;
  });

  // One entry per file: a read or decode failure counts that entry unreadable and nothing else.
  const readAll = Effect.gen(function* () {
    if (store.listNames === undefined) return yield* storeFailed(undefined);
    const names = yield* store.listNames(ENTRY_PREFIX).pipe(Effect.mapError(storeFailed));
    const entries: Array<StoredEntry> = [];
    const unreadableIds = new Set<string>();
    for (const name of names) {
      const decoded = yield* store
        .get(name)
        .pipe(
          Effect.map(Option.flatMap((bytes) => decodeEntry(textDecoder.decode(bytes)))),
          Effect.orElseSucceed(Option.none),
        );
      if (Option.isSome(decoded) && `${ENTRY_PREFIX}${decoded.value.id}` === name) {
        entries.push(decoded.value);
      } else {
        unreadableIds.add(name.slice(ENTRY_PREFIX.length));
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name) || a.createdAt.localeCompare(b.createdAt));
    return { entries, unreadable: unreadableIds.size, unreadableIds };
  });

  const summarize = (entry: StoredEntry, all: ReadonlyArray<StoredEntry>) =>
    Effect.all([readUsage(entry.id), readPrevious(entry.id)]).pipe(
      Effect.map(([usage, previous]) =>
        toSummary(
          entry,
          usage,
          all.some((other) => collides(entry, other)),
          previous,
        ),
      ),
    );

  const summarizeAll = (entries: ReadonlyArray<StoredEntry>) =>
    Effect.forEach(entries, (entry) => summarize(entry, entries));

  const assertNameFree = (entry: StoredEntry, all: ReadonlyArray<StoredEntry>) =>
    all.some((other) => collides(entry, other))
      ? Effect.fail(new VaultError({ reason: "name_taken" }))
      : Effect.void;

  const list: VaultService["Service"]["list"] = Effect.fn("VaultService.list")(function* () {
    const { entries, unreadable } = yield* readAll;
    yield* Effect.annotateCurrentSpan({
      "vault.entries": entries.length,
      "vault.unreadable": unreadable,
    });
    const orphans = yield* readOrphanedPrevious(entries);
    const summaries = yield* summarizeAll(entries);
    return {
      entries: [
        ...summaries,
        ...orphans.map(({ entry, previous }) =>
          toSummary(entry, Option.none(), false, Option.some(previous)),
        ),
      ],
      unreadable,
    };
  });

  const get: VaultService["Service"]["get"] = Effect.fn("VaultService.get")(function* (id) {
    const entry = yield* readEntry(id).pipe(
      Effect.catchIf(
        (error) => error.reason === "not_found",
        (error) =>
          Effect.flatMap(readPrevious(id), (previous) =>
            Option.isSome(previous) && previous.value.reason === "deleted"
              ? Effect.succeed(fromPrevious(id, previous.value))
              : Effect.fail(error),
          ),
      ),
    );
    const { entries } = yield* readAll;
    return yield* summarize(entry, entries);
  });

  const newId = crypto.randomUUIDv4().pipe(
    Effect.map((uuid) => VaultEntryId.make(uuid)),
    Effect.mapError(storeFailed),
  );

  const insert = Effect.fnUntraced(function* (
    fields: Omit<StoredEntry, "id" | "version" | "createdAt" | "updatedAt">,
  ) {
    const now = yield* nowIso;
    const entry: StoredEntry = {
      ...fields,
      id: yield* newId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const { entries } = yield* readAll;
    yield* assertNameFree(entry, entries);
    yield* store
      .create(`${ENTRY_PREFIX}${entry.id}`, textEncoder.encode(encodeEntry(entry)))
      .pipe(Effect.mapError(storeFailed));
    yield* emit(entry);
    return yield* summarize(entry, [...entries, entry]);
  }, writeLock.withPermits(1));

  const create: VaultService["Service"]["create"] = Effect.fn("VaultService.create")(
    function* (input) {
      return yield* insert({
        name: input.name,
        kind: input.kind,
        ...(input.username === undefined ? {} : { username: input.username }),
        domains: input.domains,
        scope: input.scope,
        value: input.value,
      });
    },
  );

  /** Writes a changed entry under the lock; `change` returns null to leave it as is. */
  const change = Effect.fnUntraced(function* (
    id: VaultEntryId,
    apply: (entry: StoredEntry) => StoredEntry | null,
  ) {
    const current = yield* readEntry(id);
    const { entries } = yield* readAll;
    const patched = apply(current);
    if (patched === null) return yield* summarize(current, entries);
    const next: StoredEntry = {
      ...patched,
      version: current.version + 1,
      updatedAt: yield* nowIso,
    };
    // Entries that share a name only through sync stay editable as long as neither name nor scope moves.
    if (next.name !== current.name || next.scope !== current.scope) {
      yield* assertNameFree(next, entries);
    }
    yield* writeEntry(next);
    yield* emit(next);
    return yield* summarize(
      next,
      entries.map((entry) => (entry.id === next.id ? next : entry)),
    );
  }, writeLock.withPermits(1));

  const update: VaultService["Service"]["update"] = Effect.fn("VaultService.update")(
    function* (input) {
      return yield* change(input.id, (entry) => {
        const { username: _username, ...rest } = entry;
        const username = input.username === undefined ? entry.username : input.username;
        return {
          ...rest,
          ...(username === null || username === undefined ? {} : { username }),
          name: input.name ?? entry.name,
          kind: input.kind ?? entry.kind,
          domains: input.domains ?? entry.domains,
          scope: input.scope ?? entry.scope,
          value: input.value ?? entry.value,
        };
      });
    },
  );

  const allowProject: VaultService["Service"]["allowProject"] = Effect.fn(
    "VaultService.allowProject",
  )(function* (input) {
    return yield* change(input.id, (entry) =>
      entry.scope === "global" || entry.scope.projects.includes(input.projectId)
        ? null
        : { ...entry, scope: { projects: [...entry.scope.projects, input.projectId] } },
    );
  });

  const remove: VaultService["Service"]["delete"] = Effect.fn("VaultService.delete")(function* (
    id,
  ) {
    if (!ENTRY_ID_PATTERN.test(id)) return yield* notFound();
    const stored = yield* store.get(`${ENTRY_PREFIX}${id}`).pipe(Effect.mapError(storeFailed));
    if (Option.isNone(stored)) {
      const previous = yield* readPrevious(id);
      if (Option.isNone(previous)) return yield* notFound();
      return yield* dropPrevious(id);
    }
    yield* store.remove(`${ENTRY_PREFIX}${id}`).pipe(Effect.mapError(storeFailed));
    yield* store.remove(`${USAGE_PREFIX}${id}`).pipe(Effect.ignore);
    yield* dropPrevious(id);
    yield* emit(id);
  }, writeLock.withPermits(1));

  const entriesForProject: VaultService["Service"]["entriesForProject"] = Effect.fn(
    "VaultService.entriesForProject",
  )(function* (projectId) {
    const { entries } = yield* readAll;
    return yield* Effect.forEach(
      entries.filter((entry) => inScope(entry.scope, projectId)),
      (entry) => summarize(entry, entries),
    );
  });

  const findByName: VaultService["Service"]["findByName"] = Effect.fn("VaultService.findByName")(
    function* (input) {
      const { entries } = yield* readAll;
      const named = entries.filter((entry) => entry.name === input.name);
      const visible = named.filter((entry) => inScope(entry.scope, input.projectId));
      const [first, second] = visible;
      if (first !== undefined && second !== undefined) {
        return {
          type: "ambiguous_name" as const,
          entries: yield* Effect.forEach(visible, (entry) => summarize(entry, entries)),
        };
      }
      if (first !== undefined)
        return { type: "ok" as const, entry: yield* summarize(first, entries) };
      const [elsewhere] = named;
      if (elsewhere !== undefined) {
        return { type: "out_of_scope" as const, entry: yield* summarize(elsewhere, entries) };
      }
      return { type: "not_found" as const };
    },
  );

  const readValue: VaultService["Service"]["readValue"] = Effect.fn("VaultService.readValue")(
    function* (id) {
      return (yield* readEntry(id)).value;
    },
  );

  const recordUse: VaultService["Service"]["recordUse"] = Effect.fn("VaultService.recordUse")(
    function* (id, usage) {
      yield* readEntry(id);
      yield* store
        .set(`${USAGE_PREFIX}${id}`, textEncoder.encode(encodeUsage(usage)))
        .pipe(Effect.mapError(storeFailed));
    },
  );

  const originAllowed: VaultService["Service"]["originAllowed"] = Effect.fn(
    "VaultService.originAllowed",
  )(function* (input) {
    const entry = yield* readEntry(input.id);
    return Domains.originAllowed(entry.domains, input.url);
  });

  const usePrevious: VaultService["Service"]["usePrevious"] = Effect.fn("VaultService.usePrevious")(
    function* (id) {
      if (!ENTRY_ID_PATTERN.test(id)) return yield* notFound();
      const previous = yield* readPrevious(id);
      if (Option.isNone(previous)) return yield* notFound();
      const kept = previous.value;
      const live = yield* readEntry(id).pipe(Effect.option);
      const summary = Option.isSome(live)
        ? yield* change(id, (entry) => {
            const { username: _username, ...rest } = entry;
            return {
              ...rest,
              ...(kept.username === undefined ? {} : { username: kept.username }),
              name: kept.name,
              kind: kept.kind,
              domains: kept.domains,
              value: kept.value,
            };
          })
        : yield* insert({
            name: kept.name,
            kind: kept.kind,
            ...(kept.username === undefined ? {} : { username: kept.username }),
            domains: kept.domains,
            scope: "global",
            value: kept.value,
          });
      yield* dropPrevious(id);
      const { previous: _previous, ...rest } = summary;
      return rest;
    },
  );

  const onLocalChange: VaultService["Service"]["onLocalChange"] = (handler) =>
    Ref.set(changeHandler, handler);

  const readStored: VaultService["Service"]["readStored"] = (id) =>
    readEntry(id).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason === "not_found",
        () => Effect.succeedNone,
      ),
    );

  const listStored: VaultService["Service"]["listStored"] = () =>
    Effect.map(readAll, ({ entries, unreadableIds }) => ({ entries, unreadableIds }));

  const unchangedSince = (current: Option.Option<StoredEntry>, expectedVersion: number | null) =>
    expectedVersion === null
      ? Option.isNone(current)
      : Option.isSome(current) &&
        current.value.version === expectedVersion &&
        current.value.scope === "global";

  const applyRemote: VaultService["Service"]["applyRemote"] = Effect.fn("VaultService.applyRemote")(
    function* (id, content, options) {
      const current = yield* readStored(id);
      if (!unchangedSince(current, options.expectedVersion)) return false;
      if (Option.isSome(current) && options.keepPrevious) {
        yield* keepPrevious(current.value, "newer_edit");
      }
      yield* writeEntry({
        id,
        name: content.name,
        kind: content.kind,
        ...(content.username === undefined ? {} : { username: content.username }),
        domains: content.domains,
        scope: "global",
        value: content.value,
        version: Option.isSome(current) ? current.value.version + 1 : 1,
        createdAt: content.createdAt,
        updatedAt: content.updatedAt,
      });
      return true;
    },
    writeLock.withPermits(1),
  );

  const applyRemoteDelete: VaultService["Service"]["applyRemoteDelete"] = Effect.fn(
    "VaultService.applyRemoteDelete",
  )(function* (id, options) {
    const current = yield* readStored(id);
    if (Option.isNone(current) || !unchangedSince(current, options.expectedVersion)) return false;
    if (options.keepPrevious) yield* keepPrevious(current.value, "deleted");
    else yield* dropPrevious(id);
    yield* store.remove(`${ENTRY_PREFIX}${id}`).pipe(Effect.mapError(storeFailed));
    yield* store.remove(`${USAGE_PREFIX}${id}`).pipe(Effect.ignore);
    return true;
  }, writeLock.withPermits(1));

  return VaultService.of({
    usePrevious,
    onLocalChange,
    readStored,
    listStored,
    applyRemote,
    applyRemoteDelete,
    list,
    get,
    create,
    update,
    delete: remove,
    entriesForProject,
    findByName,
    allowProject,
    readValue,
    recordUse,
    originAllowed,
  });
});

export const layer = Layer.effect(VaultService, make);
