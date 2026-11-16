import { describe, expect, it } from "@effect/vitest";
import {
  ThreadId,
  ThreadShareId,
  type ThreadShare,
  type ThreadShareStatus,
} from "@t3tools/contracts";
import type { RelayThreadGrantSyncRequest, RelayThreadShareClaim } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";

import {
  makeRelayGrantSync,
  RelayGrantSyncError,
  type RelayGrantClient,
} from "./RelayGrantSync.ts";

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

const orgShare = (status: ThreadShareStatus): ThreadShare => ({
  id: ThreadShareId.make("share:org"),
  target: { kind: "organization", id: "org_1", label: "Acme" },
  role: "viewer",
  requireApproval: false,
  status,
  grantedAt: "2026-11-11T00:00:00.000Z",
});

function makeWorld() {
  const threads = new Map<ThreadId, { title: string; shares: Array<ThreadShare> }>();
  const relay = new Map<ThreadId, Map<string, ThreadShareStatus>>();
  const pushes: Array<{ threadId: ThreadId; payload: RelayThreadGrantSyncRequest }> = [];
  const state = { linked: true, key: "link-1", relayDown: false, listCalls: 0 };
  // Invite link acceptances the relay holds, and the ones the environment recorded.
  const claims: Array<RelayThreadShareClaim> = [];
  const accepted: Array<RelayThreadShareClaim> = [];

  const client: RelayGrantClient = {
    get key() {
      return state.key;
    },
    sync: (threadId, payload) =>
      state.relayDown
        ? Effect.fail(new RelayGrantSyncError({ operation: "sync", cause: "down" }))
        : Effect.sync(() => {
            pushes.push({ threadId, payload });
            const previous = relay.get(threadId) ?? new Map();
            const next = new Map(
              payload.shares.map((share) => [
                share.id,
                previous.get(share.id) ?? "pending_approval",
              ]),
            );
            if (next.size === 0) relay.delete(threadId);
            else relay.set(threadId, next);
            return {
              shares: [...next].map(([id, status]) => ({ id: ThreadShareId.make(id), status })),
              claims: claims.filter((claim) => claim.threadId === threadId),
            };
          }),
    list: Effect.sync(() => {
      state.listCalls += 1;
      return {
        grants: [...relay].flatMap(([threadId, shares]) =>
          [...shares].map(([id, status]) => ({ threadId, id: ThreadShareId.make(id), status })),
        ),
        claims,
      };
    }),
  };

  const sync = makeRelayGrantSync({
    connect: Effect.sync(() => (state.linked ? client : null)),
    listSharedThreadIds: Effect.sync(() =>
      [...threads].filter(([, thread]) => thread.shares.length > 0).map(([threadId]) => threadId),
    ),
    readThread: (threadId) => Effect.succeed(threads.get(threadId) ?? null),
    setStatus: ({ threadId, shareId, status }) =>
      Effect.sync(() => {
        const thread = threads.get(threadId);
        if (thread === undefined) return;
        thread.shares = thread.shares.map((share) =>
          share.id === shareId ? { ...share, status } : share,
        );
      }),
    acceptClaim: (claim) =>
      Effect.sync(() => {
        accepted.push(claim);
      }),
  });
  return { sync, threads, relay, pushes, state, claims, accepted };
}

describe("RelayGrantSync", () => {
  it.effect("pushes a thread's shares and applies the status the relay decides", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      world.threads.set(threadA, { title: "Fix login", shares: [orgShare("active")] });
      yield* world.sync.push(threadA);
      expect(world.pushes).toEqual([
        { threadId: threadA, payload: { title: "Fix login", shares: [orgShare("active")] } },
      ]);
      expect(world.threads.get(threadA)?.shares[0]?.status).toBe("pending_approval");
    }),
  );

  it.effect("picks up an org owner's decision on the next poll", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      world.threads.set(threadA, { title: "Fix login", shares: [orgShare("pending_approval")] });
      yield* world.sync.poll();
      yield* world.sync.push(threadA);
      world.relay.get(threadA)?.set("share:org", "active");
      yield* world.sync.poll();
      expect(world.threads.get(threadA)?.shares[0]?.status).toBe("active");
    }),
  );

  it.effect("removes the grants of threads whose shares ended while the relay was not told", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      // The relay still holds a grant for a thread that was settled (or deleted) meanwhile.
      world.relay.set(threadB, new Map([["share:org", "active"]]));
      world.threads.set(threadB, { title: "Old", shares: [] });
      yield* world.sync.poll();
      expect(world.pushes).toEqual([{ threadId: threadB, payload: { title: "Old", shares: [] } }]);
      expect(world.relay.has(threadB)).toBe(false);
      // Nothing left to follow, so later polls do not call the relay.
      const calls = world.state.listCalls;
      yield* world.sync.poll();
      expect(world.state.listCalls).toBe(calls);
    }),
  );

  it.effect("retries a push that failed on the next poll", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      yield* world.sync.poll();
      world.threads.set(threadA, { title: "Fix login", shares: [orgShare("active")] });
      world.state.relayDown = true;
      yield* world.sync.push(threadA);
      expect(world.relay.has(threadA)).toBe(false);
      world.state.relayDown = false;
      yield* world.sync.poll();
      expect(world.relay.get(threadA)?.get("share:org")).toBe("pending_approval");
    }),
  );

  it.effect("never sends the relay a share an agent only proposed", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      world.threads.set(threadA, {
        title: "Fix login",
        shares: [{ ...orgShare("active"), status: "proposed" }],
      });
      yield* world.sync.push(threadA);
      expect(world.pushes.map((push) => push.payload.shares)).toEqual([[]]);
    }),
  );

  it.effect("tells a new link about shares made while fwai Connect was unlinked", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      world.state.linked = false;
      world.threads.set(threadA, { title: "Fix login", shares: [orgShare("pending_approval")] });
      yield* world.sync.push(threadA);
      expect(world.pushes).toEqual([]);
      world.state.linked = true;
      yield* world.sync.poll();
      expect(world.pushes.map((push) => push.threadId)).toEqual([threadA]);
    }),
  );

  it.effect("does nothing while fwai Connect is not linked", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      world.state.linked = false;
      world.threads.set(threadA, { title: "Fix login", shares: [orgShare("active")] });
      yield* world.sync.push(threadA);
      yield* world.sync.poll();
      expect(world.pushes).toEqual([]);
      expect(world.state.listCalls).toBe(0);
    }),
  );

  it.effect("records invite link acceptances the relay reports on a push or a poll", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const claim = (shareId: string): RelayThreadShareClaim => ({
        threadId: threadA,
        shareId: ThreadShareId.make(shareId),
        linkShareId: ThreadShareId.make("share:link"),
        accountId: "user-b",
        username: "bo",
        claimedAt: "2026-11-15T00:00:00.000Z",
      });
      world.threads.set(threadA, { title: "Fix login", shares: [orgShare("active")] });
      world.claims.push(claim("share:joined-1"));
      yield* world.sync.push(threadA);
      expect(world.accepted.map((item) => item.shareId)).toEqual(["share:joined-1"]);

      world.claims.splice(0, world.claims.length, claim("share:joined-2"));
      yield* world.sync.poll();
      // Recording is idempotent, so a claim may arrive through both paths.
      expect(new Set(world.accepted.map((item) => item.shareId))).toEqual(
        new Set(["share:joined-1", "share:joined-2"]),
      );
    }),
  );

  it.effect("follows title changes and endings only for threads the relay holds", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      world.threads.set(threadA, { title: "Fix login", shares: [orgShare("active")] });
      const event = (type: string, threadId: ThreadId) => ({ type, threadId }) as never;
      expect(world.sync.affects(event("thread.metadata-updated", threadA))).toBe(false);
      expect(world.sync.affects(event("thread.shares-updated", threadA))).toBe(true);
      yield* world.sync.push(threadA);
      expect(world.sync.affects(event("thread.metadata-updated", threadA))).toBe(true);
      expect(world.sync.affects(event("thread.settled", threadA))).toBe(true);
      expect(world.sync.affects(event("thread.settled", threadB))).toBe(false);
    }),
  );
});
