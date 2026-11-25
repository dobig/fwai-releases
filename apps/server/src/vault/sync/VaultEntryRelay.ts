// fwai: the relay's vault entry endpoints as entry sync uses them, over the environment
// credential. Tests replace this with an in-memory relay.
import type { VaultEntryId } from "@t3tools/contracts";
import {
  RelayVaultConflictError,
  RelayVaultNotEnrolledError,
  RelayVaultQuotaError,
  type RelayVaultEntriesResponse,
  type RelayVaultPutEntryRequest,
  type RelayVaultPutEntryResponse,
  type VaultSyncCursor,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { readRelayConnection } from "../../cloud/config.ts";
import { makeRelayEnvironmentClient } from "../../relay/relayEnvironmentClient.ts";

export class VaultRelayUnavailableError extends Schema.TaggedError<VaultRelayUnavailableError>()(
  "VaultRelayUnavailableError",
  { cause: Schema.optionalKey(Schema.Defect()) },
) {
  override get message(): string {
    return "fwai Connect is not linked or could not be reached.";
  }
}

export class VaultEntryRelay extends Context.Service<
  VaultEntryRelay,
  {
    readonly list: (
      since: VaultSyncCursor | null,
    ) => Effect.Effect<
      RelayVaultEntriesResponse,
      VaultRelayUnavailableError | RelayVaultNotEnrolledError
    >;
    readonly put: (
      entryId: VaultEntryId,
      payload: typeof RelayVaultPutEntryRequest.Type,
    ) => Effect.Effect<
      typeof RelayVaultPutEntryResponse.Type,
      | VaultRelayUnavailableError
      | RelayVaultConflictError
      | RelayVaultQuotaError
      | RelayVaultNotEnrolledError
    >;
  }
>()("t3/vault/sync/VaultEntryRelay") {}

const isNotEnrolled = Schema.is(RelayVaultNotEnrolledError);
const isConflict = Schema.is(RelayVaultConflictError);
const isQuota = Schema.is(RelayVaultQuotaError);
const isUnavailable = Schema.is(VaultRelayUnavailableError);
const isPutError = (
  error: unknown,
): error is RelayVaultConflictError | RelayVaultQuotaError | RelayVaultNotEnrolledError =>
  isConflict(error) || isQuota(error) || isNotEnrolled(error);

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const client = readRelayConnection.pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.flatMap((connection) =>
      connection === null
        ? Effect.fail(new VaultRelayUnavailableError({}))
        : makeRelayEnvironmentClient(connection),
    ),
  );
  // Everything but the vault's own answers (conflict, quota, not enrolled) means unreachable.
  const call = <A, E, K extends E>(
    run: (relay: Effect.Success<typeof client>) => Effect.Effect<A, E>,
    keep: (error: unknown) => error is K,
  ) =>
    client.pipe(
      Effect.flatMap(run),
      Effect.timeout("30 seconds"),
      Effect.mapError((error) =>
        keep(error) || isUnavailable(error)
          ? error
          : new VaultRelayUnavailableError({ cause: error }),
      ),
    );

  return VaultEntryRelay.of({
    list: Effect.fn("VaultEntryRelay.list")(function* (since) {
      return yield* call(
        (relay) => relay.server.listVaultEntries({ query: since === null ? {} : { since } }),
        isNotEnrolled,
      );
    }),
    put: Effect.fn("VaultEntryRelay.put")(function* (entryId, payload) {
      return yield* call(
        (relay) => relay.server.putVaultEntry({ params: { entryId }, payload }),
        isPutError,
      );
    }),
  });
});

export const layer = Layer.effect(VaultEntryRelay, make);
