import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, VaultEntryId, VaultSyncError } from "@t3tools/contracts";
import { RelayVaultConflictError, type RelayVaultEntryBlob } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as VaultCrypto from "./VaultCrypto.ts";
import * as VaultSyncKeys from "./VaultSyncKeys.ts";
import * as VaultSyncKeysRelay from "./VaultSyncKeysRelay.ts";

interface RelayRow {
  encryptionKey: string;
  wrappedKey: string | null;
  vkGeneration: number;
}

/** The relay's vault rules for one account, in memory. */
const makeRelay = () => {
  const rows = new Map<string, RelayRow>();
  const entries = new Map<string, RelayVaultEntryBlob>();
  const meta: {
    vkGeneration: number;
    putKeys: number;
    rotations: number;
    /** Runs once at the start of the next rotation, as if another environment raced it. */
    beforeRotate?: Effect.Effect<void> | undefined;
    /** Runs once at the start of the next putKey. */
    beforePutKey?: Effect.Effect<void> | undefined;
  } = { vkGeneration: 0, putKeys: 0, rotations: 0 };
  const holdsKey = (row: RelayRow | undefined) =>
    row !== undefined && row.wrappedKey !== null && row.vkGeneration === meta.vkGeneration;
  const stateFor = (caller: string) => {
    const own = rows.get(caller);
    return {
      active: rows.size > 0,
      vkGeneration: rows.size === 0 ? 0 : meta.vkGeneration,
      wrappedKey: holdsKey(own) ? own!.wrappedKey : null,
      cursor: null,
      environments: [...rows].map(([environmentId, row]) => ({
        environmentId: EnvironmentId.make(environmentId),
        encryptionKey: row.encryptionKey,
        hasKey: holdsKey(row),
        enrolledAt: "2026-11-24T00:00:00.000Z",
      })),
    };
  };
  const stale = () =>
    Effect.fail(new RelayVaultConflictError({ code: "generation_stale", message: "stale" }));
  const conflict = () =>
    Effect.fail(new RelayVaultConflictError({ code: "version_conflict", message: "conflict" }));
  const relayFailed = () => Effect.fail(new VaultSyncError({ reason: "relay_failed" }));
  /** Nobody holds the key any more: its entries are useless, and the next key is a new vault. */
  const restartIfKeyless = (hadHolder: boolean) => {
    if (rows.size === 0) {
      entries.clear();
      meta.vkGeneration = 0;
    } else if (hadHolder && ![...rows.values()].some(holdsKey)) {
      entries.clear();
      meta.vkGeneration += 1;
    }
  };
  const runOnce = (key: "beforeRotate" | "beforePutKey") =>
    Effect.suspend(() => {
      const race = meta[key];
      meta[key] = undefined;
      return race ?? Effect.void;
    });

  const clientFor = (caller: string, linked: { value: boolean }) =>
    Layer.mock(VaultSyncKeysRelay.VaultSyncKeysRelay)({
      linked: Effect.sync(() => linked.value),
      getState: () => Effect.sync(() => stateFor(caller)),
      enroll: (encryptionKey) =>
        Effect.sync(() => {
          const existing = rows.get(caller);
          if (existing?.encryptionKey === encryptionKey) return stateFor(caller);
          const first = rows.size === 0;
          const hadHolder = [...rows.values()].some(holdsKey);
          rows.set(caller, { encryptionKey, wrappedKey: null, vkGeneration: 0 });
          if (first) {
            entries.clear();
            meta.vkGeneration += 1;
          } else {
            restartIfKeyless(hadHolder);
          }
          return stateFor(caller);
        }),
      putKey: (target, request) =>
        Effect.gen(function* () {
          yield* runOnce("beforePutKey");
          const row = rows.get(target);
          if (!rows.has(caller) || row === undefined) return yield* relayFailed();
          if (request.vkGeneration !== meta.vkGeneration) return yield* stale();
          if (request.encryptionKey !== row.encryptionKey || holdsKey(row)) {
            return yield* conflict();
          }
          const bootstrap = target === caller && ![...rows.values()].some(holdsKey);
          if (!holdsKey(rows.get(caller)) && !bootstrap) return yield* relayFailed();
          meta.putKeys += 1;
          rows.set(target, {
            ...row,
            wrappedKey: request.wrappedKey,
            vkGeneration: meta.vkGeneration,
          });
        }),
      listEntries: () =>
        Effect.sync(() => ({ entries: [...entries.values()], cursor: "1", hasMore: false })),
      rotate: (request) =>
        Effect.gen(function* () {
          yield* runOnce("beforeRotate");
          if (!holdsKey(rows.get(caller))) return yield* relayFailed();
          if (request.fromGeneration !== meta.vkGeneration) return yield* stale();
          const live = [...entries.values()].filter((entry) => !entry.deleted);
          const named = new Map(request.entries.map((entry) => [entry.entryId, entry.version]));
          const covered = [
            ...request.wrappedKeys.map((key) => [key.environmentId, key.encryptionKey] as const),
            ...request.revokeEnvironmentIds.map(
              (environmentId) => [environmentId, rows.get(environmentId)?.encryptionKey] as const,
            ),
          ];
          if (
            named.size !== request.entries.length ||
            named.size !== live.length ||
            live.some((entry) => named.get(entry.entryId) !== entry.version) ||
            covered.length !== rows.size ||
            covered.some(([id, key]) => key === undefined || rows.get(id)?.encryptionKey !== key)
          ) {
            return yield* conflict();
          }
          meta.vkGeneration += 1;
          meta.rotations += 1;
          for (const [entryId, entry] of entries) {
            const ciphertext = request.entries.find((next) => next.entryId === entryId)?.ciphertext;
            entries.set(entryId, {
              ...entry,
              ...(ciphertext === undefined ? {} : { ciphertext, version: entry.version + 1 }),
              vkGeneration: meta.vkGeneration,
            });
          }
          for (const environmentId of request.revokeEnvironmentIds) rows.delete(environmentId);
          for (const key of request.wrappedKeys) {
            rows.set(key.environmentId, {
              ...rows.get(key.environmentId)!,
              wrappedKey: key.wrappedKey,
              vkGeneration: meta.vkGeneration,
            });
          }
          return stateFor(caller);
        }),
      leave: () =>
        Effect.sync(() => {
          const hadHolder = [...rows.values()].some(holdsKey);
          rows.delete(caller);
          restartIfKeyless(hadHolder);
        }),
      deleteVault: () =>
        Effect.gen(function* () {
          if (!rows.has(caller)) return yield* relayFailed();
          rows.clear();
          entries.clear();
          meta.vkGeneration = 0;
        }),
    });
  return { rows, entries, meta, clientFor };
};

/** One environment: its own secret store, sharing the relay. Each `keys` call is a fresh start. */
const makeEnvironment = (relay: ReturnType<typeof makeRelay>, id: string) => {
  const store = new Map<string, Uint8Array>();
  const linked = { value: true };
  const layer = VaultSyncKeys.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        relay.clientFor(id, linked),
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (name) => Effect.sync(() => Option.fromUndefinedOr(store.get(name))),
          set: (name, value) => Effect.sync(() => void store.set(name, value)),
          remove: (name) => Effect.sync(() => void store.delete(name)),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make(id)),
        }),
      ),
    ),
  );
  return {
    id,
    store,
    linked,
    keys: Effect.provide(VaultSyncKeys.VaultSyncKeys, layer),
  };
};

const keyPairOf = (environment: ReturnType<typeof makeEnvironment>) =>
  JSON.parse(
    new TextDecoder().decode(environment.store.get("vault-sync-keypair")),
  ) as VaultCrypto.VaultKeyPair;

const keyOf = (environment: ReturnType<typeof makeEnvironment>) =>
  environment.keys.pipe(
    Effect.flatMap((keys) => keys.currentKey()),
    Effect.map(Option.getOrThrow),
  );

const failureReason = <A>(exit: Exit.Exit<A, VaultSyncError>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? exit.cause.reasons[0].error.reason
    : undefined;

const putEntry = (
  relay: ReturnType<typeof makeRelay>,
  key: VaultSyncKeys.VaultKey,
  id: string,
  plaintext: string,
) => {
  const entryId = VaultEntryId.make(id);
  relay.entries.set(entryId, {
    entryId,
    version: 1,
    deleted: false,
    vkGeneration: key.generation,
    ciphertext: VaultCrypto.encryptEntry({
      vaultKey: key.key,
      generation: key.generation,
      entryId,
      plaintext,
    }),
    storedAt: "2026-11-24T00:00:00.000Z",
  });
};

describe("VaultSyncKeys", () => {
  it.effect("starts generation 1 on the first environment and seals the key to itself", () =>
    Effect.gen(function* () {
      const relay = makeRelay();
      const a = makeEnvironment(relay, "env-a");
      assert.equal((yield* (yield* a.keys).status()).state, "off");

      const status = yield* (yield* a.keys).join();
      assert.equal(status.state, "on");
      assert.deepEqual(
        status.environments.map((environment) => [environment.isThis, environment.hasKey]),
        [[true, true]],
      );
      const key = yield* keyOf(a);
      assert.equal(key.generation, 1);
      const opened = VaultCrypto.openVaultKey({
        wrappedKey: relay.rows.get("env-a")!.wrappedKey!,
        generation: 1,
        keyPair: keyPairOf(a),
      });
      assert.deepEqual(opened, key.key);
    }),
  );

  it.effect("a second environment waits, then gets the key when an enrolled one refreshes", () =>
    Effect.gen(function* () {
      const relay = makeRelay();
      const a = makeEnvironment(relay, "env-a");
      const b = makeEnvironment(relay, "env-b");
      yield* (yield* a.keys).join();

      const joined = yield* (yield* b.keys).join();
      assert.equal(joined.state, "waiting");
      assert.isTrue(Option.isNone(yield* (yield* b.keys).currentKey()));
      // Nothing changes until an enrolled environment comes online.
      yield* (yield* b.keys).refresh();
      assert.equal((yield* (yield* b.keys).status()).state, "waiting");

      yield* (yield* a.keys).refresh();
      yield* (yield* b.keys).refresh();
      assert.equal((yield* (yield* b.keys).status()).state, "on");
      assert.deepEqual((yield* keyOf(b)).key, (yield* keyOf(a)).key);
    }),
  );

  it.effect("a lost key shows needs_rejoin and is never replaced in place", () =>
    Effect.gen(function* () {
      const relay = makeRelay();
      const a = makeEnvironment(relay, "env-a");
      const b = makeEnvironment(relay, "env-b");
      yield* (yield* a.keys).join();
      yield* (yield* b.keys).join();
      yield* (yield* a.keys).refresh();
      yield* (yield* b.keys).refresh();
      const original = yield* keyOf(a);

      b.store.delete("vault-sync-key");
      const putKeys = relay.meta.putKeys;
      assert.equal((yield* (yield* b.keys).status()).state, "needs_rejoin");
      yield* (yield* b.keys).refresh();
      assert.equal((yield* (yield* b.keys).status()).state, "needs_rejoin");
      assert.isFalse(b.store.has("vault-sync-key"));
      assert.equal(relay.meta.putKeys, putKeys);

      a.store.set("vault-sync-keypair", new TextEncoder().encode("not json"));
      assert.equal((yield* (yield* a.keys).status()).state, "needs_rejoin");

      // Joining again is a fresh enrollment that waits for a peer holding the key.
      const oldPublicKey = relay.rows.get("env-b")!.encryptionKey;
      assert.equal((yield* (yield* b.keys).join()).state, "waiting");
      assert.notEqual(relay.rows.get("env-b")!.encryptionKey, oldPublicKey);
      assert.equal(relay.meta.vkGeneration, original.generation);
      assert.isFalse(b.store.has("vault-sync-key"));
    }),
  );

  it.effect("rotation re-encrypts every entry and reseals to every kept environment", () =>
    Effect.gen(function* () {
      const relay = makeRelay();
      const a = makeEnvironment(relay, "env-a");
      const b = makeEnvironment(relay, "env-b");
      yield* (yield* a.keys).join();
      yield* (yield* b.keys).join();
      yield* (yield* a.keys).refresh();
      yield* (yield* b.keys).refresh();
      const before = yield* keyOf(a);
      putEntry(relay, before, "entry-1", '{"value":"hunter2"}');

      const status = yield* (yield* a.keys).rotate();
      assert.equal(status.state, "on");
      const after = yield* keyOf(a);
      assert.equal(after.generation, 2);
      assert.notDeepEqual(after.key, before.key);
      const entry = relay.entries.get("entry-1")!;
      assert.equal(entry.vkGeneration, 2);
      assert.equal(
        VaultCrypto.decryptEntry({
          vaultKey: after.key,
          generation: 2,
          entryId: entry.entryId,
          ciphertext: entry.ciphertext,
        }),
        '{"value":"hunter2"}',
      );

      yield* (yield* b.keys).refresh();
      assert.deepEqual(yield* keyOf(b), after);
    }),
  );

  it.effect("retries a rotation once after another environment rotated first", () =>
    Effect.gen(function* () {
      const relay = makeRelay();
      const a = makeEnvironment(relay, "env-a");
      const b = makeEnvironment(relay, "env-b");
      yield* (yield* a.keys).join();
      yield* (yield* b.keys).join();
      yield* (yield* a.keys).refresh();
      yield* (yield* b.keys).refresh();
      relay.meta.beforeRotate = Effect.flatMap(b.keys, (keys) => keys.rotate()).pipe(
        Effect.asVoid,
        Effect.orDie,
      );
      assert.equal((yield* (yield* a.keys).rotate()).state, "on");
      assert.equal((yield* keyOf(a)).generation, 3);
      assert.equal(relay.meta.rotations, 2);
    }),
  );

  it.effect("revoking drops the environment, which turns itself off on its next refresh", () =>
    Effect.gen(function* () {
      const relay = makeRelay();
      const a = makeEnvironment(relay, "env-a");
      const b = makeEnvironment(relay, "env-b");
      yield* (yield* a.keys).join();
      yield* (yield* b.keys).join();
      yield* (yield* a.keys).refresh();
      yield* (yield* b.keys).refresh();

      const status = yield* (yield* a.keys).revoke("env-b");
      assert.deepEqual(
        status.environments.map((environment) => environment.environmentId),
        ["env-a"],
      );
      assert.equal((yield* keyOf(a)).generation, 2);
      assert.isFalse(relay.rows.has("env-b"));

      const keysOfB = yield* b.keys;
      yield* keysOfB.refresh();
      assert.equal((yield* keysOfB.status()).state, "off");
      assert.isTrue(Option.isNone(yield* keysOfB.currentKey()));
      assert.isFalse(b.store.has("vault-sync-key"));
      assert.isFalse(b.store.has("vault-sync-keypair"));
    }),
  );

  it.effect("leave removes only this environment; turn off empties the relay", () =>
    Effect.gen(function* () {
      const relay = makeRelay();
      const a = makeEnvironment(relay, "env-a");
      const b = makeEnvironment(relay, "env-b");
      yield* (yield* a.keys).join();
      yield* (yield* b.keys).join();
      yield* (yield* a.keys).refresh();
      yield* (yield* b.keys).refresh();

      assert.equal((yield* (yield* b.keys).leave()).state, "off");
      assert.deepEqual([...relay.rows.keys()], ["env-a"]);
      assert.equal((yield* (yield* a.keys).status()).state, "on");
      assert.equal(failureReason(yield* Effect.exit((yield* b.keys).leave())), "not_joined");

      assert.equal((yield* (yield* a.keys).turnOff()).state, "off");
      assert.equal(relay.rows.size, 0);
      assert.equal(a.store.size, 0);
    }),
  );

  it.effect("is unavailable while not linked through fwai Connect", () =>
    Effect.gen(function* () {
      const relay = makeRelay();
      const a = makeEnvironment(relay, "env-a");
      a.linked.value = false;
      assert.equal((yield* (yield* a.keys).status()).state, "unavailable");
      assert.equal(failureReason(yield* Effect.exit((yield* a.keys).join())), "not_linked");
      yield* (yield* a.keys).refresh();
      assert.equal(relay.rows.size, 0);
    }),
  );

  it.effect("a key that stops opening drops the key entry sync uses", () =>
    Effect.gen(function* () {
      const relay = makeRelay();
      const a = makeEnvironment(relay, "env-a");
      const keys = yield* a.keys;
      yield* keys.join();
      assert.isTrue(Option.isSome(yield* keys.currentKey()));
      a.store.set("vault-sync-key", new TextEncoder().encode("not json"));
      yield* keys.refresh();
      assert.equal((yield* keys.status()).state, "needs_rejoin");
      assert.isTrue(Option.isNone(yield* keys.currentKey()));
    }),
  );

  it.effect("a waiting environment starts the vault again after the only key holder left", () =>
    Effect.gen(function* () {
      const relay = makeRelay();
      const a = makeEnvironment(relay, "env-a");
      const b = makeEnvironment(relay, "env-b");
      yield* (yield* a.keys).join();
      putEntry(relay, yield* keyOf(a), "entry-1", "{}");
      assert.equal((yield* (yield* b.keys).join()).state, "waiting");
      yield* (yield* a.keys).leave();
      assert.equal(relay.entries.size, 0);

      const keysOfB = yield* b.keys;
      yield* keysOfB.refresh();
      assert.equal((yield* keysOfB.status()).state, "on");
      const key = yield* keyOf(b);
      assert.equal(key.generation, relay.meta.vkGeneration);
      assert.deepEqual(
        VaultCrypto.openVaultKey({
          wrappedKey: relay.rows.get("env-b")!.wrappedKey!,
          generation: key.generation,
          keyPair: keyPairOf(b),
        }),
        key.key,
      );
    }),
  );

  it.effect("of two waiting environments one starts the vault and the other takes its key", () =>
    Effect.gen(function* () {
      const relay = makeRelay();
      const a = makeEnvironment(relay, "env-a");
      const b = makeEnvironment(relay, "env-b");
      const c = makeEnvironment(relay, "env-c");
      yield* (yield* a.keys).join();
      yield* (yield* b.keys).join();
      yield* (yield* c.keys).join();
      yield* (yield* a.keys).leave();

      relay.meta.beforePutKey = Effect.flatMap(c.keys, (keys) => keys.refresh()).pipe(Effect.orDie);
      yield* (yield* b.keys).refresh();
      assert.equal((yield* (yield* b.keys).status()).state, "on");
      assert.equal((yield* (yield* c.keys).status()).state, "on");
      assert.deepEqual(yield* keyOf(b), yield* keyOf(c));
    }),
  );

  it.effect("reseals to a waiting environment's new key when the relay refuses the old one", () =>
    Effect.gen(function* () {
      const relay = makeRelay();
      const a = makeEnvironment(relay, "env-a");
      const b = makeEnvironment(relay, "env-b");
      yield* (yield* a.keys).join();
      yield* (yield* b.keys).join();
      const replacement = VaultCrypto.generateKeyPair();
      relay.meta.beforePutKey = Effect.sync(() => {
        relay.rows.get("env-b")!.encryptionKey = replacement.publicKey;
      });
      yield* (yield* a.keys).refresh();
      assert.deepEqual(
        VaultCrypto.openVaultKey({
          wrappedKey: relay.rows.get("env-b")!.wrappedKey!,
          generation: 1,
          keyPair: replacement,
        }),
        (yield* keyOf(a)).key,
      );
    }),
  );

  it.effect("retries a rotation that missed an entry written meanwhile", () =>
    Effect.gen(function* () {
      const relay = makeRelay();
      const a = makeEnvironment(relay, "env-a");
      yield* (yield* a.keys).join();
      const before = yield* keyOf(a);
      putEntry(relay, before, "entry-1", '{"value":"one"}');
      relay.meta.beforeRotate = Effect.sync(() =>
        putEntry(relay, before, "entry-2", '{"value":"two"}'),
      );
      yield* (yield* a.keys).rotate();
      const after = yield* keyOf(a);
      assert.equal(after.generation, 2);
      assert.equal(relay.meta.rotations, 1);
      const second = relay.entries.get("entry-2")!;
      assert.equal(
        VaultCrypto.decryptEntry({
          vaultKey: after.key,
          generation: 2,
          entryId: second.entryId,
          ciphertext: second.ciphertext,
        }),
        '{"value":"two"}',
      );
    }),
  );

  it.effect("turning off a vault this environment never joined fails with not_joined", () =>
    Effect.gen(function* () {
      const relay = makeRelay();
      const a = makeEnvironment(relay, "env-a");
      const b = makeEnvironment(relay, "env-b");
      yield* (yield* a.keys).join();
      assert.equal(failureReason(yield* Effect.exit((yield* b.keys).turnOff())), "not_joined");
      assert.equal(relay.rows.size, 1);
    }),
  );
});
