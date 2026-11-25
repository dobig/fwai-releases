// The relay vault endpoints VaultSyncKeys calls, with the environment credential fwai Connect
// stored. Every call fails with `not_linked` while this environment is not linked.
import { type EnvironmentId, VaultSyncError } from "@t3tools/contracts";
import {
  RelayVaultConflictError,
  type RelayVaultEntriesResponse,
  type RelayVaultPutKeyRequest,
  type RelayVaultRotateRequest,
  type RelayVaultState,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { readRelayConnection } from "../../cloud/config.ts";
import { makeRelayEnvironmentClient } from "../../relay/relayEnvironmentClient.ts";

type Failure = VaultSyncError;
type ConflictOrFailure = RelayVaultConflictError | VaultSyncError;

export class VaultSyncKeysRelay extends Context.Service<
  VaultSyncKeysRelay,
  {
    readonly linked: Effect.Effect<boolean>;
    readonly getState: () => Effect.Effect<RelayVaultState, Failure>;
    readonly enroll: (encryptionKey: string) => Effect.Effect<RelayVaultState, Failure>;
    readonly putKey: (
      environmentId: EnvironmentId,
      request: typeof RelayVaultPutKeyRequest.Type,
    ) => Effect.Effect<void, ConflictOrFailure>;
    readonly listEntries: (since?: string) => Effect.Effect<RelayVaultEntriesResponse, Failure>;
    readonly rotate: (
      request: typeof RelayVaultRotateRequest.Type,
    ) => Effect.Effect<RelayVaultState, ConflictOrFailure>;
    readonly leave: () => Effect.Effect<void, Failure>;
    readonly deleteVault: () => Effect.Effect<void, Failure>;
  }
>()("t3/vault/sync/VaultSyncKeysRelay") {}

const isConflict = Schema.is(RelayVaultConflictError);

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const connection = readRelayConnection.pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
  );
  const call = <A, E>(
    timeout: Duration.Input,
    run: (
      relay: Effect.Success<ReturnType<typeof makeRelayEnvironmentClient>>,
    ) => Effect.Effect<A, E>,
  ) =>
    connection.pipe(
      Effect.flatMap((linked) =>
        linked === null
          ? Effect.fail(new VaultSyncError({ reason: "not_linked" }))
          : makeRelayEnvironmentClient(linked).pipe(
              Effect.flatMap(run),
              Effect.timeout(timeout),
              Effect.mapError((cause) =>
                isConflict(cause) ? cause : new VaultSyncError({ reason: "relay_failed", cause }),
              ),
            ),
      ),
    );
  const failOnConflict = <A>(effect: Effect.Effect<A, ConflictOrFailure>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isConflict(cause) ? new VaultSyncError({ reason: "relay_failed", cause }) : cause,
      ),
    );

  return VaultSyncKeysRelay.of({
    linked: connection.pipe(Effect.map((linked) => linked !== null)),
    getState: Effect.fn("VaultSyncKeysRelay.getState")(() =>
      failOnConflict(call("15 seconds", (relay) => relay.server.getVaultState())),
    ),
    enroll: Effect.fn("VaultSyncKeysRelay.enroll")((encryptionKey: string) =>
      failOnConflict(
        call("15 seconds", (relay) => relay.server.enrollVault({ payload: { encryptionKey } })),
      ),
    ),
    putKey: Effect.fn("VaultSyncKeysRelay.putKey")((environmentId, request) =>
      call("15 seconds", (relay) =>
        relay.server.putVaultKey({ params: { environmentId }, payload: request }),
      ).pipe(Effect.asVoid),
    ),
    listEntries: Effect.fn("VaultSyncKeysRelay.listEntries")((since?: string) =>
      failOnConflict(
        call("30 seconds", (relay) =>
          relay.server.listVaultEntries({ query: since === undefined ? {} : { since } }),
        ),
      ),
    ),
    rotate: Effect.fn("VaultSyncKeysRelay.rotate")((request) =>
      call("60 seconds", (relay) => relay.server.rotateVault({ payload: request })),
    ),
    leave: Effect.fn("VaultSyncKeysRelay.leave")(() =>
      failOnConflict(call("15 seconds", (relay) => relay.server.leaveVault())).pipe(Effect.asVoid),
    ),
    deleteVault: Effect.fn("VaultSyncKeysRelay.deleteVault")(() =>
      failOnConflict(call("15 seconds", (relay) => relay.server.deleteVault())).pipe(Effect.asVoid),
    ),
  });
});

export const layer = Layer.effect(VaultSyncKeysRelay, make);
