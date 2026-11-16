import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ThreadShareId,
  type ThreadShare,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadShareService from "../threadShare/ThreadShareService.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for thread shares"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-share" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const threadId = ThreadId.make("thread:shared");
const share = (id: string, targetId: string): ThreadShare => ({
  id: ThreadShareId.make(id),
  target: { kind: "account", id: targetId, label: targetId },
  role: "collaborator",
  requireApproval: true,
  status: "active",
  grantedAt: "2026-11-11T00:00:00.000Z",
});

let commandCount = 0;
const nextCommandId = () => CommandId.make(`thread-share-${(commandCount += 1)}`);

const setup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: nextCommandId(),
    threadId,
    projectId: ProjectId.make("project:shared"),
    title: "Shared",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const shares = Effect.map(
    projections.getThreadProjection(threadId),
    (projection) => projection.thread.shares?.map((item) => `${item.id}:${item.status}`) ?? [],
  );
  const grant = (item: ThreadShare) =>
    Effect.exit(
      orchestrator.dispatch({
        type: "thread.share.grant",
        commandId: nextCommandId(),
        threadId,
        share: item,
      }),
    );
  return { orchestrator, shares, grant };
});

it.effect("grants, refuses a second share to the same person, and revokes", () =>
  Effect.gen(function* () {
    const { orchestrator, shares, grant } = yield* setup;
    assert.isTrue(Exit.isSuccess(yield* grant(share("share:a", "user-a"))));
    assert.isTrue(Exit.isFailure(yield* grant(share("share:a2", "user-a"))));
    assert.isTrue(Exit.isSuccess(yield* grant(share("share:b", "user-b"))));
    assert.deepEqual(yield* shares, ["share:a:active", "share:b:active"]);

    yield* orchestrator.dispatch({
      type: "thread.share.status.set",
      commandId: nextCommandId(),
      threadId,
      shareId: ThreadShareId.make("share:b"),
      status: "rejected",
    });
    // The relay may send the same decision again.
    yield* orchestrator.dispatch({
      type: "thread.share.status.set",
      commandId: nextCommandId(),
      threadId,
      shareId: ThreadShareId.make("share:b"),
      status: "rejected",
    });
    yield* orchestrator.dispatch({
      type: "thread.share.revoke",
      commandId: nextCommandId(),
      threadId,
      shareId: ThreadShareId.make("share:a"),
    });
    assert.deepEqual(yield* shares, ["share:b:rejected"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("ends every share when the owner settles, and refuses to share a settled thread", () =>
  Effect.gen(function* () {
    const { orchestrator, shares, grant } = yield* setup;
    yield* grant(share("share:a", "user-a"));
    yield* orchestrator.dispatch({ type: "thread.settle", commandId: nextCommandId(), threadId });
    assert.deepEqual(yield* shares, []);
    assert.isTrue(Exit.isFailure(yield* grant(share("share:b", "user-b"))));

    yield* orchestrator.dispatch({
      type: "thread.unsettle",
      commandId: nextCommandId(),
      threadId,
      reason: "user",
    });
    assert.deepEqual(yield* shares, [], "unsettling does not bring shares back");
    assert.isTrue(Exit.isSuccess(yield* grant(share("share:c", "user-c"))));
    yield* orchestrator.dispatch({ type: "thread.archive", commandId: nextCommandId(), threadId });
    assert.deepEqual(yield* shares, []);
  }).pipe(Effect.provide(layerTest)),
);

const layerService = ThreadShareService.layer.pipe(
  Layer.provideMerge(layerTest),
  Layer.provide(NodeCrypto.layer),
);

it.effect("keeps an agent's share as a proposal until the owner approves it", () =>
  Effect.gen(function* () {
    const { shares } = yield* setup;
    const service = yield* ThreadShareService.ThreadShareService;
    const proposed = yield* service.grant(
      { threadId, target: { kind: "account", id: "user-a", label: "a" }, role: "viewer" },
      { proposedByAgent: true },
    );
    const proposal = proposed.shares[0];
    assert.equal(proposal?.status, "proposed");
    if (proposal === undefined) return;

    const approved = yield* service.decide({ threadId, shareId: proposal.id, approve: true });
    assert.equal(approved.shares[0]?.status, "active");
    const again = yield* Effect.flip(
      service.decide({ threadId, shareId: proposal.id, approve: true }),
    );
    assert.equal(again.reason, "not_proposed");

    const orgProposal = yield* service.grant(
      { threadId, target: { kind: "organization", id: "org-1", label: "Org" }, role: "viewer" },
      { proposedByAgent: true },
    );
    const orgShare = orgProposal.shares.find((item) => item.target.kind === "organization");
    if (orgShare === undefined) return assert.fail("missing org proposal");
    const orgApproved = yield* service.decide({ threadId, shareId: orgShare.id, approve: true });
    assert.equal(
      orgApproved.shares.find((item) => item.id === orgShare.id)?.status,
      "pending_approval",
      "an approved whole-organization share still waits for an org owner",
    );

    const third = yield* service.grant(
      { threadId, target: { kind: "account", id: "user-c", label: "c" }, role: "viewer" },
      { proposedByAgent: true },
    );
    const rejected = third.shares.find((item) => item.target.id === "user-c");
    if (rejected === undefined) return assert.fail("missing proposal");
    yield* service.decide({ threadId, shareId: rejected.id, approve: false });
    assert.notInclude((yield* shares).join(","), rejected.id);
  }).pipe(Effect.provide(layerService)),
);

const minuteFrom = (iso: string, minutes: number) =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(iso), { minutes }));

const claim = (linkShareId: string, shareId: string, accountId: string, claimedAt: string) => ({
  threadId,
  shareId: ThreadShareId.make(shareId),
  linkShareId: ThreadShareId.make(linkShareId),
  accountId,
  username: accountId,
  claimedAt,
});

it.effect("lets one account join through a single invite link, then closes it", () =>
  Effect.gen(function* () {
    yield* setup;
    const service = yield* ThreadShareService.ThreadShareService;
    const created = yield* service.createLink({
      threadId,
      mode: "single",
      role: "collaborator",
      expiresIn: "7d",
    });
    const link = created.shares.find((item) => item.id === created.shareId);
    if (link === undefined || link.link === undefined) return assert.fail("missing link share");
    assert.equal(link.target.kind, "link");
    assert.notInclude(link.target.id, created.token, "only the token's hash is kept");
    const before = minuteFrom(link.link.expiresAt, -1);

    yield* service.acceptClaim(claim(link.id, "share:joined-a", "user-a", before));
    // The relay may report the same acceptance again.
    yield* service.acceptClaim(claim(link.id, "share:joined-a", "user-a", before));
    const second = yield* Effect.flip(
      service.acceptClaim(claim(link.id, "share:joined-b", "user-b", before)),
    );
    assert.equal(second.reason, "link_closed");

    const { shares } = yield* service.list(threadId);
    const joined = shares.filter((item) => item.viaShareId === link.id);
    assert.deepEqual(
      joined.map((item) => [item.target.id, item.role, item.requireApproval]),
      [["user-a", "collaborator", true]],
    );
    assert.isDefined(shares.find((item) => item.id === link.id)?.link?.closedAt);
  }).pipe(Effect.provide(layerService)),
);

it.effect("lets many accounts join through a multi link until it expires", () =>
  Effect.gen(function* () {
    yield* setup;
    const service = yield* ThreadShareService.ThreadShareService;
    const created = yield* service.createLink({
      threadId,
      mode: "multi",
      role: "viewer",
      expiresIn: "1d",
    });
    const link = created.shares.find((item) => item.id === created.shareId);
    if (link?.link === undefined) return assert.fail("missing link share");
    const before = minuteFrom(link.link.expiresAt, -1);
    const after = minuteFrom(link.link.expiresAt, 1);

    yield* service.acceptClaim(claim(link.id, "share:joined-a", "user-a", before));
    yield* service.acceptClaim(claim(link.id, "share:joined-b", "user-b", before));
    const late = yield* Effect.flip(
      service.acceptClaim(claim(link.id, "share:joined-c", "user-c", after)),
    );
    assert.equal(late.reason, "link_closed");

    const { shares } = yield* service.list(threadId);
    assert.deepEqual(
      shares.filter((item) => item.viaShareId === link.id).map((item) => item.target.id),
      ["user-a", "user-b"],
    );
  }).pipe(Effect.provide(layerService)),
);

it.effect("revokes a link alone, or with everyone who joined through it", () =>
  Effect.gen(function* () {
    yield* setup;
    const service = yield* ThreadShareService.ThreadShareService;
    const makeLink = Effect.gen(function* () {
      const created = yield* service.createLink({
        threadId,
        mode: "multi",
        role: "viewer",
        expiresIn: "30d",
      });
      const link = created.shares.find((item) => item.id === created.shareId);
      return { id: created.shareId, at: link?.grantedAt ?? "" };
    });
    const kept = yield* makeLink;
    yield* service.acceptClaim(claim(kept.id, "share:kept-a", "user-a", kept.at));
    const removed = yield* makeLink;
    yield* service.acceptClaim(claim(removed.id, "share:removed-b", "user-b", removed.at));

    yield* service.revoke({ threadId, shareId: kept.id });
    const listed = yield* service.revoke({ threadId, shareId: removed.id, removeJoined: true });
    assert.deepEqual(
      listed.shares.map((item) => item.id),
      ["share:kept-a"],
    );
  }).pipe(Effect.provide(layerService)),
);

it.effect("refuses to grant a link target directly", () =>
  Effect.gen(function* () {
    yield* setup;
    const service = yield* ThreadShareService.ThreadShareService;
    const error = yield* Effect.flip(
      service.grant({ threadId, target: { kind: "link", id: "hash", label: "" }, role: "viewer" }),
    );
    assert.equal(error.reason, "thread_unavailable");
  }).pipe(Effect.provide(layerService)),
);
