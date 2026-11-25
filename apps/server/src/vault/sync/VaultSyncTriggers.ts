// When vault sync catches up: at startup and on each relay reconnect after a random 0–30 s wait
// (so a relay deploy does not make every environment fetch at once), and on each `vault.changed`
// hint. Each run refreshes membership, then syncs entries. There is no periodic polling.
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";

import * as CloudManagedEndpointRuntime from "../../cloud/ManagedEndpointRuntime.ts";
import * as VaultEntrySync from "./VaultEntrySync.ts";
import * as VaultSyncKeys from "./VaultSyncKeys.ts";

export const RECONNECT_JITTER = Duration.seconds(30);

export class VaultSyncTriggers extends Context.Service<
  VaultSyncTriggers,
  {
    /** The relay said the account's vault changed; catch up now. */
    readonly changed: () => Effect.Effect<void>;
  }
>()("t3/vault/sync/VaultSyncTriggers") {}

const make = Effect.gen(function* () {
  const keys = yield* VaultSyncKeys.VaultSyncKeys;
  const entrySync = yield* VaultEntrySync.VaultEntrySync;
  const runtime = yield* CloudManagedEndpointRuntime.CloudManagedEndpointRuntime;
  // Sliding: hints that arrive during a run collapse into one more run.
  const requests = yield* Queue.sliding<void>(1);

  const catchUp = Effect.fn("VaultSyncTriggers.catchUp")(function* () {
    yield* keys
      .refresh()
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Vault sync could not refresh", { reason: error.reason }),
        ),
      );
    yield* entrySync.syncNow();
  });
  yield* Stream.fromQueue(requests).pipe(Stream.runForEach(catchUp), Effect.forkScoped);

  const afterJitter = Effect.gen(function* () {
    const millis = yield* Random.nextIntBetween(0, Duration.toMillis(RECONNECT_JITTER));
    yield* Effect.sleep(Duration.millis(millis));
    yield* Queue.offer(requests, undefined);
  });
  yield* Stream.concat(Stream.make(undefined), runtime.tunnelConnectedBroadcast).pipe(
    // cloudflared registers several connections per reconnect.
    Stream.debounce("3 seconds"),
    Stream.runForEach(() => afterJitter),
    Effect.forkScoped,
  );

  return VaultSyncTriggers.of({
    changed: Effect.fn("VaultSyncTriggers.changed")(function* () {
      yield* Queue.offer(requests, undefined);
    }),
  });
});

export const layer = Layer.effect(VaultSyncTriggers, make);
