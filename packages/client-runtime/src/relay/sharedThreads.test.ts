import { EnvironmentId, ThreadId, ThreadShareId } from "@t3tools/contracts";
import type { RelayOrgShareRequest, RelaySharedThread } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { TestClock } from "effect/testing";

import * as ManagedRelay from "./managedRelay.ts";
import * as RelaySharedThreads from "./sharedThreads.ts";
import * as SharedThreadEvents from "./sharedThreadEvents.ts";
import type { ConnectionCatalogEntry, ConnectionRegistration } from "../connection/catalog.ts";
import * as Connectivity from "../connection/connectivity.ts";
import { RelayConnectionTarget } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";

const OWNER_ENVIRONMENT = EnvironmentId.make("env-owner");
const OTHER_ENVIRONMENT = EnvironmentId.make("env-other");
const OWN_ENVIRONMENT = EnvironmentId.make("env-own");

const sharedThread = (environmentId: EnvironmentId): RelaySharedThread => ({
  environmentId,
  threadId: ThreadId.make(`thread-${environmentId}`),
  title: "Shared",
  ownerSub: "usr_owner",
  role: "collaborator",
  targetKind: "project",
  online: true,
});

const orgRequest = (id: string): RelayOrgShareRequest => ({
  id,
  environmentId: OTHER_ENVIRONMENT,
  threadId: ThreadId.make(`thread-${id}`),
  shareId: ThreadShareId.make(`share-${id}`),
  title: `Thread ${id}`,
  ownerSub: "usr_member",
  role: "viewer",
  requestedAt: "2026-11-12T00:00:00.000Z",
});

const entry = (environmentId: EnvironmentId, shared: boolean): ConnectionCatalogEntry => ({
  target: new RelayConnectionTarget({
    environmentId,
    label: environmentId,
    ...(shared ? { shared: true as const } : {}),
  }),
  profile: Option.none(),
  enabled: true,
});

const makeHarness = Effect.fn("RelaySharedThreadsTest.makeHarness")(function* (
  initial: ReadonlyArray<ConnectionCatalogEntry>,
) {
  const listed = yield* Ref.make<ReadonlyArray<RelaySharedThread>>([]);
  const reads = yield* Ref.make(0);
  /** What `GET /v1/org-share-requests` answers; `forbidden` is a member's 403. */
  const pendingRequests = yield* Ref.make<ReadonlyArray<RelayOrgShareRequest> | "forbidden">([]);
  const requestReads = yield* Ref.make(0);
  /** Each connection the runtime opens; the test opens, hints and closes it. */
  const connections = yield* Queue.unbounded<{
    readonly handlers: SharedThreadEvents.SharedThreadEventsHandlers;
    readonly close: Deferred.Deferred<void>;
  }>();
  const wakeups = yield* Queue.unbounded<ConnectionWakeups.ConnectionWakeup>();
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map(initial.map((item) => [item.target.environmentId, item])),
  );
  const registered: Array<ConnectionRegistration> = [];
  const removed: Array<EnvironmentId> = [];
  const registry = EnvironmentRegistry.EnvironmentRegistry.of({
    entries,
    register: (registration: ConnectionRegistration) =>
      Effect.sync(() => {
        registered.push(registration);
        return true;
      }),
    remove: (environmentId: EnvironmentId) =>
      SubscriptionRef.update(entries, (current) => {
        removed.push(environmentId);
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      }),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const unused = () => Effect.die("unused");
  const relay = ManagedRelay.ManagedRelayClient.of({
    relayUrl: "https://relay.example.test",
    listEnvironments: unused,
    listDevices: unused,
    createEnvironmentLinkChallenge: unused,
    linkEnvironment: unused,
    unlinkEnvironment: unused,
    getEnvironmentStatus: unused,
    connectEnvironment: unused,
    registerDevice: unused,
    unregisterDevice: unused,
    registerLiveActivity: unused,
    getAgentActivitySnapshot: unused,
    listSharedThreads: () =>
      Ref.update(reads, (count) => count + 1).pipe(Effect.andThen(Ref.get(listed))),
    authorizeSharedThreadEvents: () =>
      Effect.succeed("wss://relay.example.test/v1/shared-threads/events"),
    authorizeVoice: unused,
    listOrgShareRequests: () =>
      Effect.gen(function* () {
        yield* Ref.update(requestReads, (count) => count + 1);
        const pending = yield* Ref.get(pendingRequests);
        if (pending !== "forbidden") return pending;
        return yield* new ManagedRelay.ManagedRelayRequestFailedError({
          action: "list relay organization share requests",
          cause: null,
          status: 403,
        });
      }),
    decideOrgShareRequest: unused,
    previewThreadInvite: unused,
    acceptThreadInvite: unused,
    getAgent: unused,
    disableAgent: unused,
    setAgentBlocked: unused,
    agentAvailability: unused,
    listAgentRequests: unused,
    decideAgentRequest: unused,
    cancelAgentRequest: unused,
    resetTokenCache: Effect.void,
  });
  const layer = RelaySharedThreads.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ManagedRelay.ManagedRelayClient, relay),
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry),
        Layer.succeed(
          ClientCapabilities.CloudSession,
          ClientCapabilities.CloudSession.of({
            identity: Effect.succeedSome({ accountId: "usr_me" }),
            accountToken: Effect.succeed("account-token"),
          }),
        ),
        Layer.succeed(
          Connectivity.Connectivity,
          Connectivity.Connectivity.of({
            status: Effect.succeed("online"),
            changes: Stream.empty,
          }),
        ),
        Layer.succeed(
          ConnectionWakeups.ConnectionWakeups,
          ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.fromQueue(wakeups) }),
        ),
        Layer.succeed(SharedThreadEvents.SharedThreadEventsSocket, {
          connect: (_url, handlers) =>
            Effect.gen(function* () {
              const close = yield* Deferred.make<void>();
              yield* Queue.offer(connections, { handlers, close });
              yield* Deferred.await(close);
            }),
        }),
        // Every retry waits the middle of its jitter window.
        Layer.succeed(Random.Random, { nextIntUnsafe: () => 0, nextDoubleUnsafe: () => 0.5 }),
      ),
    ),
  );
  return {
    layer,
    listed,
    reads,
    pendingRequests,
    requestReads,
    connections,
    wakeups,
    entries,
    registered,
    removed,
  };
});

describe("RelaySharedThreads", () => {
  it.effect("removes a shared environment once the relay no longer lists any of its threads", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        entry(OWNER_ENVIRONMENT, true),
        entry(OTHER_ENVIRONMENT, true),
        entry(OWN_ENVIRONMENT, false),
      ]);
      yield* Effect.gen(function* () {
        const service = yield* RelaySharedThreads.RelaySharedThreads;
        yield* Ref.set(harness.listed, [sharedThread(OWNER_ENVIRONMENT)]);
        yield* service.refresh;

        const state = yield* SubscriptionRef.get(service.state);
        expect(state.loaded).toBe(true);
        expect(state.threads.map((thread) => thread.environmentId)).toEqual([OWNER_ENVIRONMENT]);
        expect(harness.removed).toEqual([OTHER_ENVIRONMENT]);

        yield* Ref.set(harness.listed, []);
        yield* service.refresh;
        expect(harness.removed).toEqual([OTHER_ENVIRONMENT, OWNER_ENVIRONMENT]);
        expect([...(yield* SubscriptionRef.get(harness.entries)).keys()]).toEqual([
          OWN_ENVIRONMENT,
        ]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("registers an opened environment as shared, once", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([entry(OWN_ENVIRONMENT, false)]);
      yield* Effect.gen(function* () {
        const service = yield* RelaySharedThreads.RelaySharedThreads;
        yield* service.open({ environmentId: OWNER_ENVIRONMENT, label: "bob's environment" });
        yield* service.open({ environmentId: OWN_ENVIRONMENT, label: "mine" });

        expect(harness.registered).toHaveLength(1);
        const target = harness.registered[0]?.target;
        expect(target).toMatchObject({
          _tag: "RelayConnectionTarget",
          environmentId: OWNER_ENVIRONMENT,
          shared: true,
        });
      }).pipe(Effect.provide(harness.layer));
    }),
  );
  it.effect("refreshes when the channel opens and on each hint", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);
      yield* Effect.gen(function* () {
        const service = yield* RelaySharedThreads.RelaySharedThreads;
        const connection = yield* Queue.take(harness.connections);
        yield* connection.handlers.onOpen;
        expect(yield* Ref.get(harness.reads)).toBe(1);

        yield* Ref.set(harness.listed, [sharedThread(OWNER_ENVIRONMENT)]);
        yield* connection.handlers.onHint("shares-changed");
        expect(yield* Ref.get(harness.reads)).toBe(2);
        expect((yield* SubscriptionRef.get(service.state)).threads).toEqual([
          sharedThread(OWNER_ENVIRONMENT),
        ]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("re-reads an owner's pending requests on the relay's hint and counts them", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);
      yield* Effect.gen(function* () {
        const service = yield* RelaySharedThreads.RelaySharedThreads;
        const connection = yield* Queue.take(harness.connections);
        yield* connection.handlers.onOpen;
        expect((yield* SubscriptionRef.get(service.orgRequests)).requests).toEqual([]);

        yield* Ref.set(harness.pendingRequests, [orgRequest("r1"), orgRequest("r2")]);
        const threadReads = yield* Ref.get(harness.reads);
        yield* connection.handlers.onHint("org-share-requests-changed");
        expect((yield* SubscriptionRef.get(service.orgRequests)).requests).toHaveLength(2);
        // The shared-thread list did not change, so it is not read again.
        expect(yield* Ref.get(harness.reads)).toBe(threadReads);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect(
    "bumps the agent revision on open and on the agent hint, without re-reading shares",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness([]);
        yield* Effect.gen(function* () {
          const service = yield* RelaySharedThreads.RelaySharedThreads;
          const connection = yield* Queue.take(harness.connections);
          yield* connection.handlers.onOpen;
          expect(yield* SubscriptionRef.get(service.agentRevision)).toBe(1);

          const threadReads = yield* Ref.get(harness.reads);
          yield* connection.handlers.onHint("agent-requests-changed");
          expect(yield* SubscriptionRef.get(service.agentRevision)).toBe(2);
          expect(yield* Ref.get(harness.reads)).toBe(threadReads);
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("announces each new request once, not again after a reconnect", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);
      yield* Effect.gen(function* () {
        const service = yield* RelaySharedThreads.RelaySharedThreads;
        yield* Ref.set(harness.pendingRequests, [orgRequest("old")]);
        const first = yield* Queue.take(harness.connections);
        yield* first.handlers.onOpen;
        // Requests already waiting at the first read only count; they do not alert.
        expect(yield* SubscriptionRef.get(service.orgRequests)).toEqual({
          requests: [orgRequest("old")],
          arrived: [],
        });

        yield* Ref.set(harness.pendingRequests, [orgRequest("old"), orgRequest("new")]);
        yield* first.handlers.onHint("org-share-requests-changed");
        expect((yield* SubscriptionRef.get(service.orgRequests)).arrived).toEqual([
          orgRequest("new"),
        ]);

        yield* Deferred.succeed(first.close, undefined);
        yield* Queue.offer(harness.wakeups, "application-active");
        const second = yield* Queue.take(harness.connections);
        yield* second.handlers.onOpen;
        expect(yield* SubscriptionRef.get(service.orgRequests)).toEqual({
          requests: [orgRequest("old"), orgRequest("new")],
          arrived: [],
        });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("stops asking for a member's requests until the relay hints otherwise", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);
      yield* Effect.gen(function* () {
        const service = yield* RelaySharedThreads.RelaySharedThreads;
        yield* Ref.set(harness.pendingRequests, "forbidden");
        const connection = yield* Queue.take(harness.connections);
        yield* connection.handlers.onOpen;
        expect((yield* SubscriptionRef.get(service.orgRequests)).requests).toBeNull();
        yield* connection.handlers.onOpen;
        expect(yield* Ref.get(harness.requestReads)).toBe(1);

        // Promoted to owner: only owners' sockets get this hint.
        yield* Ref.set(harness.pendingRequests, [orgRequest("r1")]);
        yield* connection.handlers.onHint("org-share-requests-changed");
        expect(yield* SubscriptionRef.get(service.orgRequests)).toEqual({
          requests: [orgRequest("r1")],
          arrived: [orgRequest("r1")],
        });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("reconnects after a jittered delay that backs off while attempts fail", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);
      yield* Effect.gen(function* () {
        const first = yield* Queue.take(harness.connections);
        yield* first.handlers.onOpen;
        yield* Deferred.succeed(first.close, undefined);

        // First retry after a disconnect: anywhere in 0–30 s, here 15 s.
        yield* TestClock.adjust("14999 millis");
        expect(yield* Queue.poll(harness.connections)).toEqual(Option.none());
        yield* TestClock.adjust("1 millis");
        const second = yield* Queue.take(harness.connections);

        // It never opened, so the next wait doubles: 30–60 s, here 45 s.
        yield* Deferred.succeed(second.close, undefined);
        yield* TestClock.adjust("44999 millis");
        expect(yield* Queue.poll(harness.connections)).toEqual(Option.none());
        yield* TestClock.adjust("1 millis");
        const third = yield* Queue.take(harness.connections);

        // Opening resets the backoff.
        yield* third.handlers.onOpen;
        yield* Deferred.succeed(third.close, undefined);
        yield* TestClock.adjust("15 seconds");
        yield* Queue.take(harness.connections);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("reconnects at once when the app returns to the foreground", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);
      yield* Effect.gen(function* () {
        const first = yield* Queue.take(harness.connections);
        yield* Deferred.succeed(first.close, undefined);
        yield* Queue.offer(harness.wakeups, "application-active");
        yield* Queue.take(harness.connections);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("catches agent requests up whenever shares catch up, not only on hints", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);
      yield* Effect.gen(function* () {
        const service = yield* RelaySharedThreads.RelaySharedThreads;
        yield* Queue.take(harness.connections);
        const revisionAtLeast = (value: number) =>
          SubscriptionRef.changes(service.agentRevision).pipe(
            Stream.filter((revision) => revision >= value),
            Stream.runHead,
          );
        yield* Queue.offer(harness.wakeups, "application-active");
        yield* revisionAtLeast(1);
        yield* TestClock.adjust("10 minutes");
        yield* revisionAtLeast(2);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("polls every ten minutes as a fallback", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);
      yield* Effect.gen(function* () {
        yield* Queue.take(harness.connections);
        expect(yield* Ref.get(harness.reads)).toBe(0);
        yield* TestClock.adjust("10 minutes");
        expect(yield* Ref.get(harness.reads)).toBe(1);
        yield* TestClock.adjust("10 minutes");
        expect(yield* Ref.get(harness.reads)).toBe(2);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
