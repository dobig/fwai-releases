import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ProjectId, type VaultCreateInput, type VaultEntryId } from "@t3tools/contracts";
import {
  RelayVaultConflictError,
  RelayVaultQuotaError,
  type RelayVaultEntryBlob,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as VaultService from "../VaultService.ts";
import { decryptEntry, encryptEntry, generateVaultKey } from "./VaultCrypto.ts";
import * as VaultEntryRelay from "./VaultEntryRelay.ts";
import * as VaultEntrySync from "./VaultEntrySync.ts";
import { VaultSyncKeys, type VaultKey } from "./VaultSyncKeys.ts";

const project = ProjectId.make("project-a");
const KEY = { generation: 1, key: generateVaultKey() };
const PAGE_SIZE = 2;

// The relay as the environments see it: versions, tombstones, a cursor, and nothing readable.
interface FakeRelay {
  readonly blobs: Map<string, RelayVaultEntryBlob>;
  readonly changedAt: Map<string, number>;
  seq: number;
  generation: number;
  quota: RelayVaultQuotaError["limit"] | null;
  readonly offline: Set<string>;
  /** The vault key each environment holds; KEY unless a test changes it. */
  readonly keys: Map<string, Option.Option<VaultKey>>;
}

const makeRelay = (): FakeRelay => ({
  blobs: new Map(),
  changedAt: new Map(),
  seq: 0,
  generation: KEY.generation,
  quota: null,
  offline: new Set(),
  keys: new Map(),
});

const store = (relay: FakeRelay, blob: Omit<RelayVaultEntryBlob, "storedAt">) => {
  relay.seq += 1;
  relay.blobs.set(blob.entryId, { ...blob, storedAt: String(relay.seq) });
  relay.changedAt.set(blob.entryId, relay.seq);
};

/** Nobody held the key: the relay dropped every entry and the next key starts a new vault. */
const restartVault = (relay: FakeRelay, generation: number) => {
  relay.blobs.clear();
  relay.changedAt.clear();
  relay.generation = generation;
  return { generation, key: generateVaultKey() };
};

const relayLayer = (relay: FakeRelay, environment: string) =>
  Layer.succeed(
    VaultEntryRelay.VaultEntryRelay,
    VaultEntryRelay.VaultEntryRelay.of({
      list: (since) =>
        Effect.suspend(() => {
          if (relay.offline.has(environment)) {
            return Effect.fail(new VaultEntryRelay.VaultRelayUnavailableError({}));
          }
          const after = since === null ? 0 : Number(since);
          const changed = [...relay.blobs.values()]
            .filter((blob) => (relay.changedAt.get(blob.entryId) ?? 0) > after)
            .sort((a, b) => relay.changedAt.get(a.entryId)! - relay.changedAt.get(b.entryId)!);
          const page = changed.slice(0, PAGE_SIZE);
          const last = page.at(-1);
          return Effect.succeed({
            entries: page,
            cursor: last === undefined ? since : String(relay.changedAt.get(last.entryId)),
            hasMore: changed.length > PAGE_SIZE,
          });
        }),
      put: (entryId, payload) =>
        Effect.suspend((): ReturnType<VaultEntryRelay.VaultEntryRelay["Service"]["put"]> => {
          if (relay.offline.has(environment)) {
            return Effect.fail(new VaultEntryRelay.VaultRelayUnavailableError({}));
          }
          if (relay.quota !== null && !payload.deleted) {
            return Effect.fail(
              new RelayVaultQuotaError({
                code: "vault_quota_exceeded",
                limit: relay.quota,
                message: "over",
              }),
            );
          }
          if (payload.vkGeneration !== relay.generation) {
            return Effect.fail(
              new RelayVaultConflictError({ code: "generation_stale", message: "stale" }),
            );
          }
          const current = relay.blobs.get(entryId);
          if ((current?.version ?? 0) !== payload.expectedVersion) {
            return Effect.fail(
              new RelayVaultConflictError({
                code: "version_conflict",
                ...(current === undefined ? {} : { current }),
                message: "conflict",
              }),
            );
          }
          const version = (current?.version ?? 0) + 1;
          store(relay, {
            entryId,
            version,
            deleted: payload.deleted,
            vkGeneration: payload.vkGeneration,
            ciphertext: payload.ciphertext,
          });
          return Effect.succeed({ version, cursor: String(relay.seq) });
        }),
    }),
  );

const memoryStore = (data: Map<string, Uint8Array>) =>
  Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromNullishOr(data.get(name))),
      set: (name, value) => Effect.sync(() => void data.set(name, value)),
      create: (name, value) => Effect.sync(() => void data.set(name, value)),
      getOrCreateRandom: () => Effect.die("unused"),
      remove: (name) => Effect.sync(() => void data.delete(name)),
      listNames: (prefix) =>
        Effect.sync(() => [...data.keys()].filter((name) => name.startsWith(prefix))),
    }),
  );

const keysLayer = (relay: FakeRelay, environment: string) =>
  Layer.mock(VaultSyncKeys)({
    currentKey: () => Effect.sync(() => relay.keys.get(environment) ?? Option.some(KEY)),
    keyChanges: Stream.empty,
    withEntryLock: (effect) => effect,
  });

interface Environment {
  readonly vault: VaultService.VaultService["Service"];
  readonly sync: VaultEntrySync.VaultEntrySync["Service"];
  readonly stop: Effect.Effect<void>;
}

/** One environment over its own store; calling it again on the same store is a restart. */
const start = (relay: FakeRelay, name: string, data: Map<string, Uint8Array>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const context = yield* Layer.buildWithScope(
      VaultEntrySync.layer.pipe(
        Layer.provideMerge(VaultService.layer),
        Layer.provide(
          Layer.mergeAll(
            memoryStore(data),
            relayLayer(relay, name),
            keysLayer(relay, name),
            NodeCrypto.layer,
          ),
        ),
      ),
      scope,
    );
    return {
      vault: Context.get(context, VaultService.VaultService),
      sync: Context.get(context, VaultEntrySync.VaultEntrySync),
      stop: Scope.close(scope, Exit.void),
    } satisfies Environment;
  });

const twoEnvironments = Effect.gen(function* () {
  const relay = makeRelay();
  const storeA = new Map<string, Uint8Array>();
  const storeB = new Map<string, Uint8Array>();
  return {
    relay,
    storeA,
    storeB,
    a: yield* start(relay, "A", storeA),
    b: yield* start(relay, "B", storeB),
  };
});

const entry = (overrides: Partial<VaultCreateInput> = {}): VaultCreateInput => ({
  name: "GitHub",
  kind: "password",
  username: "octocat",
  domains: ["github.com"],
  scope: "global",
  value: "first",
  ...overrides,
});

const syncAll = (...environments: ReadonlyArray<Environment>) =>
  Effect.forEach(environments, (environment) => environment.sync.syncNow(), { discard: true });

/** The value an environment resolves for `name` from a project, or null when it has none. */
const valueOf = (environment: Environment, name = "GitHub") =>
  Effect.gen(function* () {
    const lookup = yield* environment.vault.findByName({ projectId: project, name });
    if (lookup.type !== "ok") return null;
    return yield* environment.vault.readValue(lookup.entry.id);
  });

const theOnly = (environment: Environment) =>
  Effect.map(environment.vault.list(), (listed) => {
    assert.equal(listed.entries.length, 1);
    return listed.entries[0]!;
  });

it.effect("brings a global entry to another environment, after it was offline and restarted", () =>
  Effect.gen(function* () {
    const { relay, storeB, a, b } = yield* twoEnvironments;
    const created = yield* a.vault.create(entry());
    yield* syncAll(a, b);
    assert.equal(yield* valueOf(b), "first");
    assert.equal((yield* theOnly(b)).username, "octocat");

    relay.offline.add("B");
    yield* a.vault.update({ id: created.id, value: "second" });
    yield* syncAll(a, b);
    assert.equal(yield* valueOf(b), "first");
    assert.equal((yield* b.sync.uploadState()).problem?.reason, "relay_unreachable");
    relay.offline.delete("B");
    yield* b.sync.syncNow();
    assert.equal(yield* valueOf(b), "second");

    yield* a.vault.update({ id: created.id, value: "third" });
    yield* a.sync.syncNow();
    yield* b.stop;
    const restarted = yield* start(relay, "B", storeB);
    yield* restarted.sync.syncNow();
    assert.equal(yield* valueOf(restarted), "third");
    assert.equal((yield* restarted.vault.list()).entries.length, 1);
    assert.isUndefined((yield* restarted.sync.uploadState()).problem);
  }),
);

it.effect("uploads changes queued while offline after a restart", () =>
  Effect.gen(function* () {
    const { relay, storeA, a, b } = yield* twoEnvironments;
    relay.offline.add("A");
    yield* a.vault.create(entry());
    yield* a.sync.syncNow();
    assert.equal((yield* a.sync.uploadState()).pendingUploads, 1);
    yield* a.stop;

    relay.offline.delete("A");
    const restarted = yield* start(relay, "A", storeA);
    assert.equal((yield* restarted.sync.uploadState()).pendingUploads, 1);
    yield* restarted.sync.syncNow();
    const state = yield* restarted.sync.uploadState();
    assert.equal(state.pendingUploads, 0);
    assert.isDefined(state.lastSyncedAt);
    yield* b.sync.syncNow();
    assert.equal(yield* valueOf(b), "first");
  }),
);

it.effect("keeps project entries local; scope changes delete and re-add under a new id", () =>
  Effect.gen(function* () {
    const { relay, a, b } = yield* twoEnvironments;
    yield* a.vault.create(entry({ name: "Local", scope: { projects: [project] } }));
    const shared = yield* a.vault.create(entry());
    yield* syncAll(a, b);
    assert.equal(relay.blobs.size, 1);
    const [firstRemoteId] = [...relay.blobs.keys()];
    assert.deepEqual(
      (yield* b.vault.list()).entries.map((summary) => summary.name),
      ["GitHub"],
    );

    yield* a.vault.update({ id: shared.id, scope: { projects: [project] } });
    yield* syncAll(a, b);
    assert.isTrue(relay.blobs.get(firstRemoteId!)?.deleted);
    assert.equal((yield* b.vault.list()).entries.length, 0);

    yield* a.vault.update({ id: shared.id, scope: "global" });
    yield* syncAll(a, b);
    const live = [...relay.blobs.values()].filter((blob) => !blob.deleted);
    assert.equal(live.length, 1);
    assert.notEqual(live[0]?.entryId, firstRemoteId);
    assert.equal(yield* valueOf(b), "first");
    assert.notEqual((yield* theOnly(b)).id, firstRemoteId);
    assert.equal((yield* a.vault.get(shared.id)).scope, "global");
  }),
);

it.effect("concurrent edits converge on the newer one and a delete does not come back", () =>
  Effect.gen(function* () {
    const { relay, a, b } = yield* twoEnvironments;
    const created = yield* a.vault.create(entry());
    yield* syncAll(a, b);
    const onB = yield* theOnly(b);

    yield* a.vault.update({ id: created.id, value: "older-a" });
    yield* TestClock.adjust("1 minute");
    yield* b.vault.update({ id: onB.id, value: "newer-b" });
    yield* syncAll(a, b, a);
    assert.equal(yield* valueOf(a), "newer-b");
    assert.equal(yield* valueOf(b), "newer-b");

    yield* b.vault.update({ id: onB.id, value: "older-b" });
    yield* b.sync.syncNow();
    yield* TestClock.adjust("1 minute");
    yield* a.vault.update({ id: created.id, value: "newer-a" });
    yield* syncAll(a, b);
    assert.equal(yield* valueOf(a), "newer-a");
    assert.equal(yield* valueOf(b), "newer-a");

    relay.offline.add("A");
    yield* a.vault.delete(created.id);
    yield* TestClock.adjust("1 minute");
    yield* b.vault.update({ id: onB.id, value: "edited-after-delete" });
    yield* b.sync.syncNow();
    relay.offline.delete("A");
    yield* syncAll(a, b, a, b);
    assert.equal((yield* a.vault.list()).entries.length, 0);
    assert.equal((yield* b.vault.list()).entries.length, 0);
  }),
);

it.effect("an offline edit lost to a delete is kept and comes back under a new id", () =>
  Effect.gen(function* () {
    const { relay, a, b } = yield* twoEnvironments;
    const created = yield* a.vault.create(entry());
    yield* syncAll(a, b);
    const onB = yield* theOnly(b);

    relay.offline.add("B");
    yield* b.vault.update({ id: onB.id, value: "kept-by-b" });
    yield* TestClock.adjust("1 minute");
    yield* a.vault.delete(created.id);
    yield* a.sync.syncNow();
    relay.offline.delete("B");
    yield* b.sync.syncNow();

    assert.isNull(yield* valueOf(b));
    const kept = yield* theOnly(b);
    assert.equal(kept.previous?.reason, "deleted");
    const restored = yield* b.sync.usePreviousVersion(kept.id);
    assert.notEqual(restored.id, kept.id);
    assert.isUndefined(restored.previous);
    yield* syncAll(b, a);
    assert.equal(yield* valueOf(a), "kept-by-b");
    assert.equal(yield* valueOf(b), "kept-by-b");
  }),
);

it.effect("Monday's offline edit loses to Tuesday's, and Use this version makes it win", () =>
  Effect.gen(function* () {
    const { relay, a, b } = yield* twoEnvironments;
    const created = yield* a.vault.create(entry());
    yield* syncAll(a, b);
    const onB = yield* theOnly(b);

    relay.offline.add("A");
    yield* a.vault.update({ id: created.id, value: "monday-a" });
    yield* TestClock.adjust("1 day");
    yield* b.vault.update({ id: onB.id, value: "tuesday-b" });
    yield* b.sync.syncNow();
    yield* TestClock.adjust("1 day");
    relay.offline.delete("A");
    yield* syncAll(a, b);

    assert.equal(yield* valueOf(a), "tuesday-b");
    assert.equal(yield* valueOf(b), "tuesday-b");
    assert.equal((yield* a.vault.get(created.id)).previous?.reason, "newer_edit");
    assert.isUndefined((yield* b.vault.get(onB.id)).previous);

    const used = yield* a.sync.usePreviousVersion(created.id);
    assert.equal(used.id, created.id);
    assert.isUndefined((yield* a.vault.get(created.id)).previous);
    yield* syncAll(a, b);
    assert.equal(yield* valueOf(a), "monday-a");
    assert.equal(yield* valueOf(b), "monday-a");
  }),
);

it.effect("forgets a replaced value after 30 days", () =>
  Effect.gen(function* () {
    const { relay, a, b } = yield* twoEnvironments;
    const created = yield* a.vault.create(entry());
    yield* syncAll(a, b);
    relay.offline.add("A");
    yield* a.vault.update({ id: created.id, value: "lost" });
    yield* TestClock.adjust("1 minute");
    yield* b.vault.update({ id: (yield* theOnly(b)).id, value: "won" });
    yield* b.sync.syncNow();
    relay.offline.delete("A");
    yield* a.sync.syncNow();
    assert.isDefined((yield* a.vault.get(created.id)).previous);

    yield* TestClock.adjust("31 days");
    assert.isUndefined((yield* a.vault.get(created.id)).previous);
    const exit = yield* Effect.exit(a.sync.usePreviousVersion(created.id));
    assert.isTrue(Exit.isFailure(exit));
  }),
);

it.effect("same-named entries from two environments are both kept", () =>
  Effect.gen(function* () {
    const { a, b } = yield* twoEnvironments;
    yield* a.vault.create(entry({ value: "from-a" }));
    yield* b.vault.create(entry({ value: "from-b" }));
    yield* syncAll(a, b, a);
    for (const environment of [a, b]) {
      const listed = yield* environment.vault.list();
      assert.equal(listed.entries.length, 2);
      assert.isTrue(listed.entries.every((summary) => summary.nameConflict === true));
      const lookup = yield* environment.vault.findByName({ projectId: project, name: "GitHub" });
      assert.equal(lookup.type, "ambiguous_name");
    }
    const [first] = (yield* a.vault.list()).entries;
    yield* a.vault.update({ id: first!.id as VaultEntryId, value: "still editable" });
  }),
);

it.effect("a quota refusal shows as a problem and keeps the entry queued", () =>
  Effect.gen(function* () {
    const { relay, a } = yield* twoEnvironments;
    relay.quota = "entry_size";
    yield* a.vault.create(entry());
    yield* a.sync.syncNow();
    assert.deepEqual(yield* a.sync.uploadState(), {
      pendingUploads: 1,
      problem: { reason: "quota_entry_size", entryName: "GitHub" },
    });

    relay.quota = null;
    yield* a.sync.syncNow();
    const state = yield* a.sync.uploadState();
    assert.equal(state.pendingUploads, 0);
    assert.isUndefined(state.problem);
    assert.equal(relay.blobs.size, 1);
  }),
);

const liveBlobs = (relay: FakeRelay) => [...relay.blobs.values()].filter((blob) => !blob.deleted);

it.effect("catches up past tombstones and stale entries left under an older key", () =>
  Effect.gen(function* () {
    const { relay, a } = yield* twoEnvironments;
    const gone = yield* a.vault.create(entry({ name: "Gone" }));
    yield* a.vault.create(entry());
    yield* a.sync.syncNow();
    yield* a.vault.delete(gone.id);
    yield* a.sync.syncNow();
    // A rotation by a relay that left the tombstone, and one live entry, at generation 1.
    const next = { generation: 2, key: generateVaultKey() };
    relay.generation = 2;
    for (const blob of liveBlobs(relay)) {
      const plaintext = decryptEntry({ vaultKey: KEY.key, ...blob, generation: 1 });
      store(relay, {
        ...blob,
        version: blob.version + 1,
        vkGeneration: 2,
        ciphertext: encryptEntry({ vaultKey: next.key, generation: 2, ...blob, plaintext }),
      });
    }
    const stale = liveBlobs(relay)[0]!;
    store(relay, { ...stale, entryId: "left-behind" as VaultEntryId, vkGeneration: 1 });
    relay.keys.set("C", Option.some(next));
    const blobsBefore = relay.blobs.size;

    const c = yield* start(relay, "C", new Map());
    yield* c.sync.syncNow();
    assert.equal(yield* valueOf(c), "first");
    assert.equal((yield* c.vault.list()).entries.length, 1);
    assert.equal(relay.blobs.size, blobsBefore);
    assert.equal((yield* c.sync.uploadState()).pendingUploads, 0);
  }),
);

it.effect("turning sync off and joining again keeps one copy of each entry", () =>
  Effect.gen(function* () {
    const { relay, a, b } = yield* twoEnvironments;
    yield* a.vault.create(entry());
    yield* syncAll(a, b);

    const next = restartVault(relay, 1);
    relay.keys.set("A", Option.none());
    relay.keys.set("B", Option.none());
    yield* TestClock.adjust("1 minute");
    yield* b.vault.update({ id: (yield* theOnly(b)).id, value: "edited-while-off" });
    relay.keys.set("A", Option.some(next));
    relay.keys.set("B", Option.some(next));
    yield* syncAll(b, a, b);

    assert.equal(liveBlobs(relay).length, 1);
    assert.equal(relay.blobs.size, 1);
    for (const environment of [a, b]) {
      assert.equal((yield* environment.vault.list()).entries.length, 1);
      assert.equal(yield* valueOf(environment), "edited-while-off");
    }
  }),
);

it.effect("the only key holder joining again uploads what the relay dropped", () =>
  Effect.gen(function* () {
    const relay = makeRelay();
    const a = yield* start(relay, "A", new Map());
    yield* a.vault.create(entry());
    yield* a.vault.create(entry({ name: "Deploy", value: "token" }));
    yield* a.sync.syncNow();
    const remoteIds = [...relay.blobs.keys()].toSorted();

    const next = restartVault(relay, 2);
    relay.keys.set("A", Option.some(next));
    yield* a.sync.syncNow();
    assert.deepEqual([...relay.blobs.keys()].toSorted(), remoteIds);
    assert.isTrue(liveBlobs(relay).every((blob) => blob.vkGeneration === 2));

    relay.keys.set("C", Option.some(next));
    const c = yield* start(relay, "C", new Map());
    yield* c.sync.syncNow();
    assert.equal(yield* valueOf(c), "first");
    assert.equal(yield* valueOf(c, "Deploy"), "token");
    assert.equal((yield* a.vault.list()).entries.length, 2);
  }),
);

it.effect("an environment that lost its sync state settles its entries instead of copying", () =>
  Effect.gen(function* () {
    const { relay, storeB, a, b } = yield* twoEnvironments;
    yield* a.vault.create(entry());
    yield* syncAll(a, b);
    yield* b.stop;
    storeB.delete("vault-sync-entries");

    const restarted = yield* start(relay, "B", storeB);
    yield* restarted.sync.syncNow();
    assert.equal((yield* restarted.vault.list()).entries.length, 1);
    assert.equal(relay.blobs.size, 1);
    yield* a.sync.syncNow();
    assert.equal((yield* a.vault.list()).entries.length, 1);
  }),
);

it.effect("an entry that no longer reads locally is not deleted everywhere", () =>
  Effect.gen(function* () {
    const { relay, storeA, a, b } = yield* twoEnvironments;
    const created = yield* a.vault.create(entry());
    yield* syncAll(a, b);
    storeA.set(`vault-entry-${created.id}`, new TextEncoder().encode("{not json"));

    yield* syncAll(a, b);
    assert.equal(liveBlobs(relay).length, 1);
    assert.equal(yield* valueOf(b), "first");
    assert.equal((yield* a.sync.uploadState()).pendingUploads, 0);
  }),
);
