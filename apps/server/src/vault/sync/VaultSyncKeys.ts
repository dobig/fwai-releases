// This environment's membership in the account's vault sync: its X25519 key pair, the vault key
// and its generation, and sealing the key to other environments. Entry sync builds on it.
import { VaultSyncError, type VaultSyncState, type VaultSyncStatus } from "@t3tools/contracts";
import type {
  RelayVaultEntryBlob,
  RelayVaultEnvironment,
  RelayVaultState,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as VaultCrypto from "./VaultCrypto.ts";
import * as VaultSyncKeysRelay from "./VaultSyncKeysRelay.ts";

export interface VaultKey {
  readonly generation: number;
  readonly key: Uint8Array;
}

export class VaultSyncKeys extends Context.Service<
  VaultSyncKeys,
  {
    /** The membership part of the status; entry sync adds `pendingUploads`, `lastSyncedAt`. */
    readonly status: () => Effect.Effect<VaultSyncStatus, VaultSyncError>;
    /** The vault key when this environment is joined and holds it. */
    readonly currentKey: () => Effect.Effect<Option.Option<VaultKey>>;
    /** Emits whenever `currentKey` changes: joined, rotated, left, turned off. */
    readonly keyChanges: Stream.Stream<Option.Option<VaultKey>>;
    readonly join: () => Effect.Effect<VaultSyncStatus, VaultSyncError>;
    readonly leave: () => Effect.Effect<VaultSyncStatus, VaultSyncError>;
    readonly turnOff: () => Effect.Effect<VaultSyncStatus, VaultSyncError>;
    readonly rotate: () => Effect.Effect<VaultSyncStatus, VaultSyncError>;
    readonly revoke: (environmentId: string) => Effect.Effect<VaultSyncStatus, VaultSyncError>;
    /** Reads relay state, picks up a sealed key, and seals ours to environments still waiting. */
    readonly refresh: () => Effect.Effect<void, VaultSyncError>;
    /** Entry sync runs under this; a rotation holds it so no upload lands between read and commit. */
    readonly withEntryLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/vault/sync/VaultSyncKeys") {}

/** Present while this environment is joined; `awaitingKey` until another environment seals VK. */
const MEMBERSHIP_SECRET = "vault-sync-membership";
const KEY_PAIR_SECRET = "vault-sync-keypair";
const VAULT_KEY_SECRET = "vault-sync-key";
const MAX_ROTATE_ATTEMPTS = 3;

const Membership = Schema.Struct({ awaitingKey: Schema.Boolean });
const StoredKeyPair = Schema.Struct({ publicKey: Schema.String, privateKey: Schema.String });
const StoredVaultKey = Schema.Struct({ generation: Schema.Int, key: Schema.String });

type Local =
  | { readonly _tag: "off" }
  | { readonly _tag: "needs_rejoin" }
  | { readonly _tag: "waiting"; readonly keyPair: VaultCrypto.VaultKeyPair }
  | {
      readonly _tag: "on";
      readonly keyPair: VaultCrypto.VaultKeyPair;
      readonly vaultKey: VaultKey;
    };

const storeFailed = (cause: unknown) => new VaultSyncError({ reason: "store_failed", cause });

const sameKey = (a: Option.Option<VaultKey>, b: Option.Option<VaultKey>) =>
  Option.isNone(a) || Option.isNone(b)
    ? Option.isNone(a) && Option.isNone(b)
    : a.value.generation === b.value.generation &&
      Buffer.from(a.value.key).equals(Buffer.from(b.value.key));

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const relay = yield* VaultSyncKeysRelay.VaultSyncKeysRelay;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const lock = yield* Semaphore.make(1);
  const serialized = lock.withPermits(1);
  const entryLock = yield* Semaphore.make(1);
  const withEntryLock = entryLock.withPermits(1);
  const environmentsRef = yield* Ref.make<ReadonlyArray<RelayVaultEnvironment>>([]);

  const read = <S extends Schema.Codec<unknown, string>>(name: string, schema: S) =>
    secrets.get(name).pipe(
      Effect.map(
        Option.match({
          onNone: () => "missing" as const,
          onSome: (bytes) =>
            Option.getOrElse(
              Schema.decodeOption(schema)(new TextDecoder().decode(bytes)),
              () => "unreadable" as const,
            ),
        }),
      ),
      Effect.orElseSucceed(() => "unreadable" as const),
    );
  const write = (name: string, json: unknown) =>
    secrets
      .set(name, new TextEncoder().encode(JSON.stringify(json)))
      .pipe(Effect.mapError(storeFailed));

  const loadLocal = Effect.gen(function* () {
    const membership = yield* read(MEMBERSHIP_SECRET, Schema.fromJsonString(Membership));
    if (membership === "missing") return { _tag: "off" } as Local;
    if (membership === "unreadable") return { _tag: "needs_rejoin" } as Local;
    const keyPair = yield* read(KEY_PAIR_SECRET, Schema.fromJsonString(StoredKeyPair));
    if (typeof keyPair === "string") return { _tag: "needs_rejoin" } as Local;
    const stored = yield* read(VAULT_KEY_SECRET, Schema.fromJsonString(StoredVaultKey));
    if (stored === "missing" && membership.awaitingKey) {
      return { _tag: "waiting", keyPair } as Local;
    }
    if (typeof stored === "string") return { _tag: "needs_rejoin" } as Local;
    const key = new Uint8Array(Buffer.from(stored.key, "base64url"));
    if (key.length !== 32) return { _tag: "needs_rejoin" } as Local;
    return { _tag: "on", keyPair, vaultKey: { generation: stored.generation, key } } as Local;
  });

  const keyOf = (local: Local) =>
    local._tag === "on" ? Option.some(local.vaultKey) : Option.none<VaultKey>();
  const keyRef = yield* SubscriptionRef.make(keyOf(yield* loadLocal));
  const publish = Effect.fnUntraced(function* (local: Local) {
    const next = keyOf(local);
    if (!sameKey(yield* SubscriptionRef.get(keyRef), next)) {
      yield* SubscriptionRef.set(keyRef, next);
    }
  });

  const storeVaultKey = Effect.fn("VaultSyncKeys.storeVaultKey")(function* (
    keyPair: VaultCrypto.VaultKeyPair,
    vaultKey: VaultKey,
  ) {
    yield* write(VAULT_KEY_SECRET, {
      generation: vaultKey.generation,
      key: Buffer.from(vaultKey.key).toString("base64url"),
    });
    yield* write(MEMBERSHIP_SECRET, { awaitingKey: false });
    const local: Local = { _tag: "on", keyPair, vaultKey };
    yield* publish(local);
    return local;
  });

  // Membership first, so a failure part-way leaves `off` rather than a half-joined state.
  const clearLocal = Effect.fn("VaultSyncKeys.clearLocal")(function* () {
    for (const name of [MEMBERSHIP_SECRET, VAULT_KEY_SECRET, KEY_PAIR_SECRET]) {
      yield* secrets.remove(name).pipe(Effect.mapError(storeFailed));
    }
    yield* Ref.set(environmentsRef, []);
    yield* publish({ _tag: "off" });
    return { _tag: "off" } as Local;
  });

  const sealTo = (vaultKey: VaultKey, recipientPublicKey: string) =>
    Effect.try({
      try: () =>
        VaultCrypto.sealVaultKey({
          vaultKey: vaultKey.key,
          generation: vaultKey.generation,
          recipientPublicKey,
        }),
      catch: storeFailed,
    });

  const putSealed = (environment: RelayVaultEnvironment, vaultKey: VaultKey) =>
    sealTo(vaultKey, environment.encryptionKey).pipe(
      Effect.flatMap((wrappedKey) =>
        relay.putKey(environment.environmentId, {
          vkGeneration: vaultKey.generation,
          encryptionKey: environment.encryptionKey,
          wrappedKey,
        }),
      ),
    );

  /** Hands the vault key to every enrolled environment still waiting for it; no prompt. */
  const sealToWaiting = Effect.fn("VaultSyncKeys.sealToWaiting")(function* (
    environments: ReadonlyArray<RelayVaultEnvironment>,
    vaultKey: VaultKey,
  ) {
    const waiting = environments.filter((environment) => !environment.hasKey);
    yield* Effect.annotateCurrentSpan({ "vault.sync.waiting": waiting.length });
    yield* Effect.forEach(
      waiting,
      (environment) =>
        putSealed(environment, vaultKey).pipe(
          // The target enrolled a new key meanwhile: seal to the one it has now.
          Effect.catchTags({
            RelayVaultConflictError: (conflict) =>
              conflict.code !== "version_conflict"
                ? Effect.fail(conflict)
                : relay.getState().pipe(
                    Effect.flatMap((state) => {
                      const now = state.environments.find(
                        (other) => other.environmentId === environment.environmentId,
                      );
                      return now === undefined ||
                        now.hasKey ||
                        now.encryptionKey === environment.encryptionKey ||
                        state.vkGeneration !== vaultKey.generation
                        ? Effect.void
                        : putSealed(now, vaultKey);
                    }),
                  ),
          }),
          Effect.catch((error) =>
            Effect.logWarning("Could not hand the vault key to an environment", {
              environmentId: environment.environmentId,
              reason: error._tag === "VaultSyncError" ? error.reason : error.code,
            }),
          ),
        ),
      { discard: true },
    );
  });

  const pickUpKey = Effect.fn("VaultSyncKeys.pickUpKey")(function* (
    local: Extract<Local, { readonly keyPair: VaultCrypto.VaultKeyPair }>,
    wrappedKey: string | null,
    generation: number,
  ) {
    if (wrappedKey === null) return local as Local;
    if (local._tag === "on" && local.vaultKey.generation === generation) return local as Local;
    const opened = yield* Effect.try({
      try: () => VaultCrypto.openVaultKey({ wrappedKey, generation, keyPair: local.keyPair }),
      catch: storeFailed,
    }).pipe(Effect.option);
    if (Option.isNone(opened)) {
      yield* Effect.logWarning("The vault key sealed to this environment does not open");
      return local as Local;
    }
    return yield* storeVaultKey(local.keyPair, { generation, key: opened.value });
  });

  /**
   * With no environment holding the key, this one starts the vault with a new key sealed to
   * itself. If another got there first the relay refuses, and this one waits for that key.
   */
  const bootstrap = Effect.fn("VaultSyncKeys.bootstrap")(function* (
    keyPair: VaultCrypto.VaultKeyPair,
    state: RelayVaultState,
  ) {
    const vaultKey: VaultKey = {
      generation: Math.max(1, state.vkGeneration),
      key: VaultCrypto.generateVaultKey(),
    };
    const put = yield* relay
      .putKey(environmentId, {
        vkGeneration: vaultKey.generation,
        encryptionKey: keyPair.publicKey,
        wrappedKey: yield* sealTo(vaultKey, keyPair.publicKey),
      })
      .pipe(Effect.result);
    if (put._tag === "Failure") {
      yield* Effect.logWarning("Could not start the vault key; waiting for another environment's");
      const latest = yield* relay.getState();
      yield* Ref.set(environmentsRef, latest.environments);
      return {
        local: yield* pickUpKey(
          { _tag: "waiting", keyPair },
          latest.wrappedKey,
          latest.vkGeneration,
        ),
        state: latest,
      };
    }
    const local = yield* storeVaultKey(keyPair, vaultKey);
    yield* sealToWaiting(
      state.environments.filter((environment) => environment.environmentId !== environmentId),
      vaultKey,
    );
    return { local, state };
  });

  const refreshLocked = Effect.fn("VaultSyncKeys.refreshLocked")(function* () {
    const local = yield* loadLocal;
    if (local._tag === "off" || local._tag === "needs_rejoin") {
      yield* publish(local);
      return { local, state: null };
    }
    if (!(yield* relay.linked)) return { local, state: null };
    const state = yield* relay.getState();
    yield* Ref.set(environmentsRef, state.environments);
    if (!state.environments.some((environment) => environment.environmentId === environmentId)) {
      // Revoked, left from elsewhere, or the account turned sync off.
      return { local: yield* clearLocal(), state };
    }
    if (local._tag === "waiting" && !state.environments.some((environment) => environment.hasKey)) {
      // The last key holder left: entries are gone and nobody can hand the key on.
      return yield* bootstrap(local.keyPair, state);
    }
    const next = yield* pickUpKey(local, state.wrappedKey, state.vkGeneration);
    if (next._tag === "on" && next.vaultKey.generation === state.vkGeneration) {
      yield* sealToWaiting(state.environments, next.vaultKey);
    }
    yield* publish(next);
    return { local: next, state };
  });

  const toStatus = (
    state: VaultSyncState,
    environments: ReadonlyArray<RelayVaultEnvironment>,
  ): VaultSyncStatus => ({
    state,
    environments: environments.map((environment) => ({
      environmentId: environment.environmentId,
      isThis: environment.environmentId === environmentId,
      hasKey: environment.hasKey,
      enrolledAt: environment.enrolledAt,
    })),
    pendingUploads: 0,
  });

  const statusOf = Effect.fn("VaultSyncKeys.statusOf")(function* (local: Local) {
    if (!(yield* relay.linked)) return toStatus("unavailable", []);
    if (local._tag === "off") return toStatus("off", []);
    const environments = yield* relay.getState().pipe(
      Effect.map((state) => state.environments),
      Effect.tap((environments) => Ref.set(environmentsRef, environments)),
      Effect.catch(() => Ref.get(environmentsRef)),
    );
    return toStatus(local._tag, environments);
  });

  const requireLinked = Effect.gen(function* () {
    if (!(yield* relay.linked)) return yield* new VaultSyncError({ reason: "not_linked" });
  });

  const join = Effect.fn("VaultSyncKeys.join")(function* () {
    return yield* serialized(
      Effect.gen(function* () {
        yield* requireLinked;
        const current = yield* loadLocal;
        if (current._tag === "on") return yield* statusOf((yield* refreshLocked()).local);
        let keyPair: VaultCrypto.VaultKeyPair;
        if (current._tag === "waiting") {
          keyPair = current.keyPair;
        } else {
          // A lost key is never replaced in place: joining again is a fresh enrollment.
          keyPair = VaultCrypto.generateKeyPair();
          yield* secrets.remove(VAULT_KEY_SECRET).pipe(Effect.mapError(storeFailed));
          yield* write(KEY_PAIR_SECRET, keyPair);
          yield* write(MEMBERSHIP_SECRET, { awaitingKey: true });
        }
        const state = yield* relay.enroll(keyPair.publicKey);
        yield* Ref.set(environmentsRef, state.environments);
        if (state.environments.every((environment) => !environment.hasKey)) {
          return yield* statusOf((yield* bootstrap(keyPair, state)).local);
        }
        const local = yield* pickUpKey(
          { _tag: "waiting", keyPair },
          state.wrappedKey,
          state.vkGeneration,
        );
        if (local._tag === "on") yield* sealToWaiting(state.environments, local.vaultKey);
        return yield* statusOf(local);
      }),
    );
  });

  const leaveLocked = Effect.fn("VaultSyncKeys.leaveLocked")(function* () {
    const local = yield* loadLocal;
    if (local._tag === "off") return yield* new VaultSyncError({ reason: "not_joined" });
    if (yield* relay.linked) yield* relay.leave();
    return yield* statusOf(yield* clearLocal());
  });

  const listAllEntries = Effect.fn("VaultSyncKeys.listAllEntries")(function* () {
    const byId = new Map<string, RelayVaultEntryBlob>();
    let since: string | undefined;
    while (true) {
      const page = yield* relay.listEntries(since);
      for (const entry of page.entries) byId.set(entry.entryId, entry);
      if (!page.hasMore || page.cursor === null || page.cursor === since) break;
      since = page.cursor;
    }
    return [...byId.values()];
  });

  /** A new vault key over every live entry, sealed to every kept environment, applied at once. */
  const rotateOnce = Effect.fn("VaultSyncKeys.rotateOnce")(function* (drop: string | null) {
    yield* requireLinked;
    const { local, state } = yield* refreshLocked();
    if (local._tag !== "on" || state === null) {
      return yield* new VaultSyncError({ reason: "not_joined" });
    }
    if (local.vaultKey.generation !== state.vkGeneration) {
      return yield* new VaultSyncError({ reason: "relay_failed" });
    }
    if (drop !== null && !state.environments.some((e) => e.environmentId === drop)) {
      return Option.some(toStatus("on", state.environments));
    }
    const previous = local.vaultKey;
    const next: VaultKey = {
      generation: previous.generation + 1,
      key: VaultCrypto.generateVaultKey(),
    };
    const live = (yield* listAllEntries()).filter((entry) => !entry.deleted);
    const entries = yield* Effect.try({
      try: () =>
        live.map((entry) => ({
          entryId: entry.entryId,
          version: entry.version,
          ciphertext: VaultCrypto.encryptEntry({
            vaultKey: next.key,
            generation: next.generation,
            entryId: entry.entryId,
            plaintext: VaultCrypto.decryptEntry({
              vaultKey: previous.key,
              generation: entry.vkGeneration,
              entryId: entry.entryId,
              ciphertext: entry.ciphertext,
            }),
          }),
        })),
      catch: storeFailed,
    });
    const kept = state.environments.filter((environment) => environment.environmentId !== drop);
    const wrappedKeys = yield* Effect.forEach(kept, (environment) =>
      sealTo(next, environment.encryptionKey).pipe(
        Effect.map((wrappedKey) => ({
          environmentId: environment.environmentId,
          encryptionKey: environment.encryptionKey,
          wrappedKey,
        })),
      ),
    );
    yield* Effect.annotateCurrentSpan({
      "vault.sync.entries": entries.length,
      "vault.sync.environments": wrappedKeys.length,
    });
    const result = yield* relay
      .rotate({
        fromGeneration: previous.generation,
        entries,
        wrappedKeys,
        revokeEnvironmentIds: state.environments
          .filter((environment) => environment.environmentId === drop)
          .map((environment) => environment.environmentId),
      })
      .pipe(Effect.asSome, Effect.catchTags({ RelayVaultConflictError: () => Effect.succeedNone }));
    if (Option.isNone(result)) return Option.none<VaultSyncStatus>();
    yield* Ref.set(environmentsRef, result.value.environments);
    yield* storeVaultKey(local.keyPair, next);
    return Option.some(toStatus("on", result.value.environments));
  });

  // The relay refuses a rotation that missed an entry, a version or an environment; try again.
  const rotateLocked = Effect.fn("VaultSyncKeys.rotateLocked")(function* (drop: string | null) {
    for (let attempt = 0; attempt < MAX_ROTATE_ATTEMPTS; attempt += 1) {
      const status = yield* rotateOnce(drop);
      if (Option.isSome(status)) return status.value;
    }
    return yield* new VaultSyncError({ reason: "relay_failed" });
  }, withEntryLock);

  return VaultSyncKeys.of({
    status: Effect.fn("VaultSyncKeys.status")(function* () {
      return yield* statusOf(yield* loadLocal);
    }),
    currentKey: Effect.fn("VaultSyncKeys.currentKey")(() => SubscriptionRef.get(keyRef)),
    keyChanges: SubscriptionRef.changes(keyRef),
    join,
    leave: Effect.fn("VaultSyncKeys.leave")(function* () {
      return yield* serialized(leaveLocked());
    }),
    turnOff: Effect.fn("VaultSyncKeys.turnOff")(function* () {
      return yield* serialized(
        Effect.gen(function* () {
          yield* requireLinked;
          if ((yield* loadLocal)._tag === "off") {
            return yield* new VaultSyncError({ reason: "not_joined" });
          }
          yield* relay.deleteVault();
          return yield* statusOf(yield* clearLocal());
        }),
      );
    }),
    rotate: Effect.fn("VaultSyncKeys.rotate")(function* () {
      return yield* serialized(rotateLocked(null));
    }),
    revoke: Effect.fn("VaultSyncKeys.revoke")(function* (target: string) {
      if (target === environmentId) return yield* serialized(leaveLocked());
      return yield* serialized(rotateLocked(target));
    }),
    refresh: Effect.fn("VaultSyncKeys.refresh")(function* () {
      yield* serialized(refreshLocked());
    }),
    withEntryLock,
  });
});

export const layer = Layer.effect(VaultSyncKeys, make);
