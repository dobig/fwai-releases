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
const trustedThread = ThreadId.make("thread:trusted");
const sharesByThread = new Map<string, ReadonlyArray<ThreadShare>>([
  [sharedThread, [share({ target: { kind: "account", id: "user-bob", label: "bob" } })]],
  [viewedThread, [share({ target: { kind: "project", id: "prj-a", label: "A" }, role: "viewer" })]],
  [privateThread, []],
  [
    trustedThread,
    [
      share({
        target: { kind: "account", id: "user-bob", label: "bob" },
        requireApproval: false,
      }),
    ],
  ],
]);
// run:bob was started by bob's message, run:owner by the owner's.
const runs = [
  { id: "run:bob", userMessageId: "message:bob" },
  { id: "run:owner", userMessageId: "message:owner" },
];
const messages = [{ id: "message:bob", authorAccountId: "user-bob" }, { id: "message:owner" }];
const runtimeRequestKinds = new Map<string, string>([
  ["request:question", "user_input"],
  ["request:command", "command"],
  ["request:auth", "auth_refresh"],
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
      getThreadRecords: ((
        threadId: ThreadId,
        _fields: ReadonlyArray<string>,
        filter?: { readonly runIds?: ReadonlyArray<string>; messageIds?: ReadonlyArray<string> },
      ) =>
        Effect.succeed({
          thread: { id: threadId, deletedAt: null, shares: sharesByThread.get(threadId) ?? [] },
          runs: runs.filter((run) => filter?.runIds?.includes(run.id) ?? true),
          messages: messages.filter((message) => filter?.messageIds?.includes(message.id) ?? true),
        })) as never,
      getRuntimeRequest: ((_threadId: ThreadId, requestId: string) =>
        Effect.succeed(
          runtimeRequestKinds.has(requestId)
            ? { id: requestId, kind: runtimeRequestKinds.get(requestId), status: "pending" }
            : undefined,
        )) as never,
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

  it.effect(
    "lets a collaborator answer questions, and approvals only when their share skips the owner",
    () =>
      Effect.gen(function* () {
        const dispatch = ORCHESTRATION_V2_WS_METHODS.dispatchCommand;
        const respond = (threadId: ThreadId, requestId: string, principal = bob) =>
          allowed(
            dispatch,
            { type: "runtime-request.respond", threadId, requestId, decision: "accept" },
            principal,
          );
        assert.isTrue(yield* respond(sharedThread, "request:question"));
        assert.isTrue(
          yield* allowed(dispatch, {
            type: "thread.user-input.dismiss",
            threadId: sharedThread,
            requestId: "request:question",
          }),
        );
        assert.isFalse(
          yield* respond(sharedThread, "request:command"),
          "the owner approves when the share asks for it",
        );
        assert.isTrue(yield* respond(trustedThread, "request:command"));
        assert.isFalse(yield* respond(trustedThread, "request:auth"));
        assert.isFalse(yield* respond(trustedThread, "request:missing"));
        assert.isFalse(yield* respond(viewedThread, "request:question"), "viewers only read");
        assert.isTrue(yield* respond(privateThread, "request:command", owner));
      }).pipe(Effect.provide(layerPolicy)),
  );
});

describe("ThreadAccessPolicy.authorizeCall for a collaborator's own work", () => {
  const allowed = (method: string, payload: unknown, principal: AuthAccountPrincipal = bob) =>
    Effect.flatMap(ThreadAccessPolicy.ThreadAccessPolicy, (policy) =>
      Effect.exit(policy.authorizeCall(principal, method, payload)),
    ).pipe(Effect.map(Exit.isSuccess));
  const dispatch = (payload: Record<string, unknown>, principal?: AuthAccountPrincipal) =>
    allowed(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, payload, principal);

  it.effect("lets a collaborator stop, edit and retry only the runs they started", () =>
    Effect.gen(function* () {
      const own = { threadId: sharedThread, runId: "run:bob" };
      const owners = { threadId: sharedThread, runId: "run:owner" };
      for (const type of [
        "run.interrupt",
        "queued-run.cancel",
        "queued-run.edit",
        "queued-run.start",
        "prepared-run.retry",
      ]) {
        assert.isTrue(yield* dispatch({ type, ...own }), type);
        assert.isFalse(yield* dispatch({ type, ...owners }), type);
      }
      assert.isFalse(
        yield* dispatch({ type: "run.interrupt", ...own, holdQueue: true }),
        "holding the queue would hold everyone's messages",
      );
      assert.isTrue(
        yield* dispatch({
          type: "queued-message.promote-to-steer",
          threadId: sharedThread,
          queuedRunId: "run:bob",
          targetRunId: "run:bob",
        }),
      );
      assert.isFalse(
        yield* dispatch({
          type: "queued-message.promote-to-steer",
          threadId: sharedThread,
          queuedRunId: "run:bob",
          targetRunId: "run:owner",
        }),
      );
      assert.isFalse(
        yield* dispatch({ type: "run.interrupt", threadId: viewedThread, runId: "run:bob" }),
      );
      assert.isFalse(yield* dispatch({ type: "queue.resume", threadId: sharedThread }));
      assert.isFalse(yield* dispatch({ type: "queued-run.reorder", ...own, beforeRunId: null }));
      assert.isFalse(yield* dispatch({ type: "thread.stop", threadId: sharedThread }));
    }).pipe(Effect.provide(layerPolicy)),
  );

  it.effect("lets a collaborator change modes, loosening approvals only when trusted", () =>
    Effect.gen(function* () {
      const mode = (threadId: ThreadId, runtimeMode: string) =>
        dispatch({ type: "thread.runtime-mode.set", threadId, runtimeMode });
      assert.isTrue(
        yield* dispatch({
          type: "thread.interaction-mode.set",
          threadId: sharedThread,
          interactionMode: "default",
        }),
      );
      assert.isTrue(yield* mode(sharedThread, "approval-required"));
      assert.isFalse(yield* mode(sharedThread, "full-access"));
      assert.isTrue(yield* mode(trustedThread, "full-access"));
    }).pipe(Effect.provide(layerPolicy)),
  );

  it.effect("lets a collaborator upload attachments and load the thread's images only", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* allowed(WS_METHODS.attachmentsCreateUploadUrl, { name: "a.png" }));
      assert.isTrue(
        yield* allowed(WS_METHODS.assetsPersistChatAttachments, { threadId: sharedThread }),
      );
      assert.isFalse(
        yield* allowed(WS_METHODS.assetsPersistChatAttachments, { threadId: viewedThread }),
      );
      assert.isFalse(yield* allowed(WS_METHODS.attachmentsDelete, { attachmentId: "a" }));
      const asset = (resource: Record<string, unknown>) =>
        allowed(WS_METHODS.assetsCreateUrl, { resource });
      assert.isTrue(yield* asset({ _tag: "attachment", attachmentId: "a" }));
      assert.isTrue(yield* asset({ _tag: "tool-output-image", threadId: viewedThread }));
      assert.isFalse(yield* asset({ _tag: "tool-output-image", threadId: privateThread }));
      assert.isFalse(yield* asset({ _tag: "workspace-file", threadId: sharedThread, path: "a" }));
      assert.isTrue(yield* allowed(WS_METHODS.serverProbe, {}));
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
