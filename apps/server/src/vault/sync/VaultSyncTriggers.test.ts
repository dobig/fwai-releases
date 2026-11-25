import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CloudManagedEndpointRuntime from "../../cloud/ManagedEndpointRuntime.ts";
import * as VaultEntrySync from "./VaultEntrySync.ts";
import * as VaultSyncKeys from "./VaultSyncKeys.ts";
import * as VaultSyncTriggers from "./VaultSyncTriggers.ts";

it.effect("catches up at startup and on reconnect after the jitter, and at once on a hint", () =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const synced = yield* Queue.unbounded<void>();
    const tunnel = yield* PubSub.unbounded<void>();
    const layer = VaultSyncTriggers.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(VaultSyncKeys.VaultSyncKeys)({
            refresh: () => Effect.sync(() => void calls.push("refresh")),
          }),
          Layer.mock(VaultEntrySync.VaultEntrySync)({
            syncNow: () =>
              Effect.sync(() => void calls.push("sync")).pipe(
                Effect.andThen(Queue.offer(synced, undefined)),
                Effect.asVoid,
              ),
          }),
          Layer.mock(CloudManagedEndpointRuntime.CloudManagedEndpointRuntime)({
            tunnelConnectedBroadcast: Stream.fromPubSub(tunnel),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const triggers = yield* VaultSyncTriggers.VaultSyncTriggers;
      yield* TestClock.adjust("3 seconds");
      assert.deepEqual(calls, []);
      yield* TestClock.adjust(VaultSyncTriggers.RECONNECT_JITTER);
      yield* Queue.take(synced);
      assert.deepEqual(calls, ["refresh", "sync"]);

      yield* triggers.changed();
      yield* Queue.take(synced);
      assert.deepEqual(calls, ["refresh", "sync", "refresh", "sync"]);

      yield* PubSub.publish(tunnel, undefined);
      yield* TestClock.adjust("3 seconds");
      yield* TestClock.adjust(VaultSyncTriggers.RECONNECT_JITTER);
      yield* Queue.take(synced);
      assert.equal(calls.length, 6);
    }).pipe(Effect.provide(layer));
  }),
);
