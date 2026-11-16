import { assert, describe, it } from "@effect/vitest";
import {
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  ThreadShareId,
  WS_METHODS,
  type AuthAccountPrincipal,
  type OrchestrationV2ShellStreamItem,
  type ThreadShare,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadAccessPolicy from "./ThreadAccessPolicy.ts";

const share = (overrides: Partial<ThreadShare> & Pick<ThreadShare, "target">): ThreadShare => ({
  id: ThreadShareId.make(`share:${overrides.target.kind}:${overrides.target.id}`),
  role: "collaborator",
  requireApproval: true,
  status: "active",
  grantedAt: "2026-11-11T00:00:00.000Z",
  ...overrides,
});
const bob: AuthAccountPrincipal = {
  accountId: "user-bob",
  organization: { id: "org-1", role: "member", projectIds: ["prj-a"] },
  shareIds: [ThreadShareId.make("share:any")],
};
const owner: AuthAccountPrincipal = { accountId: "user-alice", organization: null };

describe("threadAccessFor", () => {
  it("keeps the owner's own sessions unrestricted", () => {
    assert.equal(ThreadAccessPolicy.threadAccessFor(undefined, { shares: [] }), "owner");
    assert.equal(ThreadAccessPolicy.threadAccessFor(owner, { shares: [] }), "owner");
  });

  it("matches a share by account, project or organization, and only while active", () => {
    const access = (shares: ReadonlyArray<ThreadShare>) =>
      ThreadAccessPolicy.threadAccessFor(bob, { shares, deletedAt: null });
    assert.equal(
      access([share({ target: { kind: "account", id: "user-bob", label: "bob" } })]),
      "collaborator",
    );
    assert.equal(
      access([share({ target: { kind: "project", id: "prj-a", label: "A" }, role: "viewer" })]),
      "viewer",
    );
    assert.equal(
      access([share({ target: { kind: "organization", id: "org-1", label: "Org" } })]),
      "collaborator",
    );
    assert.isNull(access([share({ target: { kind: "project", id: "prj-b", label: "B" } })]));
    assert.isNull(
      access([share({ target: { kind: "account", id: "user-carol", label: "carol" } })]),
    );
    assert.isNull(
      access([
        share({
          target: { kind: "organization", id: "org-1", label: "Org" },
          status: "pending_approval",
        }),
      ]),
    );
    assert.isNull(
      ThreadAccessPolicy.threadAccessFor(bob, {
        shares: [share({ target: { kind: "account", id: "user-bob", label: "bob" } })],
        deletedAt: "2026-11-11T00:00:00.000Z",
      }),
    );
  });

  it("lets the share granting the most decide whether the owner must approve", () => {
    const shares = [
      share({ target: { kind: "account", id: "user-bob", label: "bob" }, requireApproval: false }),
      share({ target: { kind: "project", id: "prj-a", label: "A" }, requireApproval: true }),
    ];
    assert.isFalse(ThreadAccessPolicy.collaboratorRunNeedsApproval(bob, shares));
    assert.isTrue(ThreadAccessPolicy.collaboratorRunNeedsApproval(bob, shares.slice(1)));
    const viewerWithoutApproval = share({
      target: { kind: "organization", id: "org-1", label: "Org" },
      role: "viewer",
      requireApproval: false,
    });
    assert.isTrue(
      ThreadAccessPolicy.collaboratorRunNeedsApproval(bob, [viewerWithoutApproval, shares[1]!]),
      "a viewer share cannot loosen a collaborator share",
    );
  });
});

const sharedThread = ThreadId.make("thread:shared");
const viewedThread = ThreadId.make("thread:viewed");
const privateThread = ThreadId.make("thread:private");
const sharesByThread = new Map<string, ReadonlyArray<ThreadShare>>([
  [sharedThread, [share({ target: { kind: "account", id: "user-bob", label: "bob" } })]],
  [viewedThread, [share({ target: { kind: "project", id: "prj-a", label: "A" }, role: "viewer" })]],
  [privateThread, []],
]);
const layerPolicy = ThreadAccessPolicy.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      getShell: ((projectId: string) =>
        Effect.succeedSome({ id: projectId, scripts: [{ id: "dev" }] })) as never,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: ((threadId: ThreadId) =>
        Effect.succeed({
          thread: { id: threadId, deletedAt: null, shares: sharesByThread.get(threadId) ?? [] },
        })) as never,
    }),
  ),
);

describe("ThreadAccessPolicy.authorizeCall", () => {
  const allowed = (method: string, payload: unknown, principal: AuthAccountPrincipal = bob) =>
    Effect.flatMap(ThreadAccessPolicy.ThreadAccessPolicy, (policy) =>
      Effect.exit(policy.authorizeCall(principal, method, payload)),
    ).pipe(Effect.map(Exit.isSuccess));

  it.effect("keeps a collaborator inside threads shared with them", () =>
    Effect.gen(function* () {
      const dispatch = ORCHESTRATION_V2_WS_METHODS.dispatchCommand;
      assert.isTrue(yield* allowed(ORCHESTRATION_V2_WS_METHODS.subscribeShell, {}));
      assert.isTrue(
        yield* allowed(ORCHESTRATION_V2_WS_METHODS.subscribeThread, { threadId: viewedThread }),
      );
      assert.isFalse(
        yield* allowed(ORCHESTRATION_V2_WS_METHODS.subscribeThread, { threadId: privateThread }),
      );
      assert.isTrue(yield* allowed(dispatch, { type: "message.dispatch", threadId: sharedThread }));
      assert.isFalse(
        yield* allowed(dispatch, { type: "message.dispatch", threadId: viewedThread }),
      );
      assert.isFalse(yield* allowed(dispatch, { type: "thread.settle", threadId: sharedThread }));
      assert.isFalse(yield* allowed(WS_METHODS.threadShareGrant, { threadId: sharedThread }));
      assert.isFalse(yield* allowed(WS_METHODS.terminalOpen, { threadId: sharedThread }));
      assert.isTrue(yield* allowed(WS_METHODS.terminalOpen, { threadId: sharedThread }, owner));
    }).pipe(Effect.provide(layerPolicy)),
  );
});

describe("ThreadAccessPolicy.runCeiling", () => {
  it.effect("holds a collaborator's runs to approval when their share asks for it", () =>
    Effect.gen(function* () {
      const policy = yield* ThreadAccessPolicy.ThreadAccessPolicy;
      assert.equal(yield* policy.runCeiling(bob, sharedThread), "approval-required");
      assert.isNull(yield* policy.runCeiling(bob, viewedThread));
      assert.isNull(yield* policy.runCeiling(owner, sharedThread));
    }).pipe(Effect.provide(layerPolicy)),
  );
});

describe("ThreadAccessPolicy.filterShell", () => {
  it.effect("sends only shared threads and their projects, and removes a thread on revoke", () =>
    Effect.gen(function* () {
      const policy = yield* ThreadAccessPolicy.ThreadAccessPolicy;
      const thread = (id: ThreadId, projectId: string) => ({ id, projectId }) as never;
      const project = (id: string) => ({ id, scripts: [{ id: "dev" }] }) as never;
      const items: ReadonlyArray<OrchestrationV2ShellStreamItem> = [
        {
          kind: "snapshot",
          snapshot: {
            snapshotSequence: 1,
            threads: [thread(sharedThread, "p1"), thread(privateThread, "p2")],
            archivedThreads: [thread(privateThread, "p2")],
            projects: [project("p1"), project("p2")],
          } as never,
        },
        {
          kind: "thread.updated",
          sequence: 2,
          location: "active",
          thread: thread(privateThread, "p2"),
        },
      ];
      const revoked = {
        kind: "thread.updated" as const,
        sequence: 3,
        location: "active" as const,
        thread: thread(sharedThread, "p1"),
      };
      const first = yield* Stream.runCollect(policy.filterShell(bob, Stream.fromIterable(items)));
      const [snapshot, ...rest] = Array.from(first);
      assert.equal(snapshot?.kind, "snapshot");
      if (snapshot?.kind === "snapshot") {
        assert.deepEqual(
          snapshot.snapshot.threads.map((item) => item.id),
          [sharedThread],
        );
        assert.deepEqual(snapshot.snapshot.archivedThreads, []);
        assert.deepEqual(
          snapshot.snapshot.projects.map((item) => ({ id: item.id, scripts: item.scripts.length })),
          [{ id: "p1", scripts: 0 }],
        );
      }
      assert.deepEqual(rest, [], "an update to a thread never shared is not sent");

      const afterRevoke = yield* Stream.runCollect(
        policy.filterShell(
          bob,
          Stream.fromIterable(items.slice(0, 1)).pipe(
            Stream.concat(
              Stream.fromEffect(Effect.sync(() => sharesByThread.set(sharedThread, []))).pipe(
                Stream.drain,
              ),
            ),
            Stream.concat(Stream.make(revoked)),
          ),
        ),
      );
      assert.deepEqual(Array.from(afterRevoke).at(-1), {
        kind: "thread.removed",
        sequence: 3,
        location: "active",
        threadId: sharedThread,
      });
    }).pipe(Effect.provide(layerPolicy)),
  );
});

describe("ThreadAccessPolicy.filterShell on resume", () => {
  it.effect(
    "sends a shared thread's project before the thread after a projects-only snapshot",
    () =>
      Effect.gen(function* () {
        const policy = yield* ThreadAccessPolicy.ThreadAccessPolicy;
        sharesByThread.set(sharedThread, [
          share({ target: { kind: "account", id: "user-bob", label: "bob" } }),
        ]);
        const items: ReadonlyArray<OrchestrationV2ShellStreamItem> = [
          {
            kind: "snapshot",
            snapshot: {
              snapshotSequence: 1,
              threads: [],
              archivedThreads: [],
              projects: [],
            } as never,
            resolvedRepositoryIdentityRoots: [],
          },
          {
            kind: "thread.updated",
            sequence: 2,
            location: "active",
            thread: { id: sharedThread, projectId: "p1" } as never,
          },
        ];
        const out = Array.from(
          yield* Stream.runCollect(policy.filterShell(bob, Stream.fromIterable(items))),
        );
        assert.deepEqual(
          out.map((item) => item.kind),
          ["snapshot", "project.updated", "thread.updated"],
        );
        const project = out[1];
        assert.deepEqual(
          project?.kind === "project.updated"
            ? { id: project.project.id, scripts: project.project.scripts.length }
            : null,
          { id: "p1", scripts: 0 },
        );
      }).pipe(Effect.provide(layerPolicy)),
  );
});
