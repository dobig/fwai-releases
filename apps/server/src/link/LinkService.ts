import {
  type AuthAccountPrincipal,
  CommandId,
  type EnvironmentId,
  LINK_ACTIVITY_SUMMARY_MAX_LENGTH,
  LINK_MAX_HOPS,
  LINK_RATE_LIMIT,
  type LinkChain,
  type LinkChainId,
  type LinkActivityEntry,
  type LinkChainTask,
  type LinkCreateInput,
  type LinkCreateResult,
  LinkError,
  type LinkErrorCode,
  type LinkGroup,
  LinkGroupId,
  type LinkGroupInput,
  type LinkGroupsSnapshot,
  type LinkMember,
  type LinkMemberInput,
  type LinkMemberRemovalReason,
  type LinkRemoveMemberInput,
  type LinkSetMemberInput,
  type LinkTaskRecord,
  type LinkTaskSender,
  type LinkTaskStatus,
  type LinkThreadRef,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import {
  RELAY_LINK_PRESENCE_MAX_TARGETS,
  RELAY_LINK_TEXT_MAX_LENGTH,
  type RelayLinkDelivery,
  type RelayLinkEnvelope,
  type RelayLinkEnvelopeBody,
  type RelayLinkMemberInfo,
  type RelayLinkReceipt,
  type RelayLinkReceiptCode,
} from "@t3tools/contracts/relay";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { narrowerRuntimeMode } from "../orchestration-v2/RuntimePolicy.ts";
import { isActiveRun } from "../orchestration-v2/ThreadManagementService.ts";
import {
  collaboratorRunNeedsApproval,
  threadAccessFor,
} from "../threadShare/ThreadAccessPolicy.ts";
import {
  decideLinkAssignment,
  decideLinkCommand,
  type LinkCommand,
  linkPeerId,
  resolveCallerChain,
} from "./LinkDecider.ts";
import {
  type LinkContextPeer,
  type LinkContextState,
  renderLinkContext,
  renderLinkContextUpdate,
} from "./LinkContext.ts";
import * as LinkRelay from "./LinkRelay.ts";
import * as LinkStore from "./LinkStore.ts";
import * as LinkTurnContext from "./LinkTurnContext.ts";

export interface LinkPeer {
  readonly peerId: string;
  readonly linkName: string;
  readonly title: string;
  readonly purpose: string;
  readonly location: "local" | "remote";
  readonly project: string;
  readonly online: boolean;
  readonly paused: boolean;
  /** Remote peers only: the environment, its owner's name where known, and approval. */
  readonly environment?: string;
  readonly owner?: string | null;
  readonly requiresApproval?: boolean;
}

/** A peer's activity entry as `t3_link_activity` returns it (#37). */
export interface LinkPeerActivity extends LinkActivityEntry {
  readonly peerId: string;
  readonly peerTitle: string;
  readonly linkName: string;
}

/** What one assignment hands to the environment that owns the assignee. */
export interface LinkAssignEnvelope {
  readonly commandId: CommandId;
  readonly requester: LinkThreadRef;
  readonly requesterRunId: OrchestrationV2Run["id"];
  readonly requesterNodeId: NodeId;
  /** The mode the requester runs in; a remote assignee never runs broader. */
  readonly requesterRuntimeMode: RuntimeMode;
  /** The account the requester's run acts for; a local assignee's run inherits it. */
  readonly requesterActingAccountId?: string;
  readonly assignee: LinkThreadRef;
  readonly task: string;
  readonly link: LinkTaskRecord;
  readonly sender: LinkTaskSender;
}

/**
 * Every assign, result and cancel goes through here. Local members are delivered in process;
 * members in other environments get envelopes through the relay (#21 phase 2).
 */
export interface LinkDelivery {
  readonly assign: (envelope: LinkAssignEnvelope) => Effect.Effect<NodeId, LinkError>;
  /** Returns a finished run's result to its requester; local runs also do this as they end. */
  readonly result: (task: LinkStore.LinkTaskIndexRow) => Effect.Effect<void, LinkError>;
  /** Interrupts the assignee's run for the task, or drops it from the queue. */
  readonly cancel: (
    task: LinkStore.LinkTaskIndexRow,
    stoppedBy: string,
  ) => Effect.Effect<void, LinkError>;
}

export class LinkService extends Context.Service<
  LinkService,
  {
    readonly snapshot: Effect.Effect<LinkGroupsSnapshot, LinkError>;
    readonly subscribe: Stream.Stream<LinkGroupsSnapshot, LinkError>;
    readonly create: (input: LinkCreateInput) => Effect.Effect<LinkCreateResult, LinkError>;
    readonly setMember: (input: LinkSetMemberInput) => Effect.Effect<void, LinkError>;
    readonly removeMember: (input: LinkRemoveMemberInput) => Effect.Effect<void, LinkError>;
    readonly pause: (input: LinkGroupInput) => Effect.Effect<void, LinkError>;
    readonly resume: (input: LinkGroupInput) => Effect.Effect<void, LinkError>;
    readonly end: (input: LinkGroupInput) => Effect.Effect<void, LinkError>;
    readonly peers: (callerThreadId: ThreadId) => Effect.Effect<ReadonlyArray<LinkPeer>, LinkError>;
    /** Recent activity of one peer, or of every peer in the caller's groups; newest first. */
    readonly activity: (
      callerThreadId: ThreadId,
      peerId?: string,
    ) => Effect.Effect<ReadonlyArray<LinkPeerActivity>, LinkError>;
    /** Records what a linked thread's finished run did, and tells remote members (#37). */
    readonly recordActivity: (
      threadId: ThreadId,
      runId: OrchestrationV2Run["id"],
    ) => Effect.Effect<void>;
    /** The member a caller's peerId names, for mode checks before assigning. */
    readonly resolvePeer: (
      callerThreadId: ThreadId,
      peerId: string,
    ) => Effect.Effect<LinkThreadRef, LinkError>;
    readonly assign: (input: {
      readonly callerThreadId: ThreadId;
      readonly peerId: string;
      readonly task: string;
    }) => Effect.Effect<{ readonly taskId: NodeId; readonly peerId: string }, LinkError>;
    /** Stops the task and every task derived from it, and refuses its chain from now on. */
    readonly stopTask: (input: {
      readonly requesterThreadId: ThreadId;
      readonly taskId: NodeId;
      readonly stoppedBy: string;
    }) => Effect.Effect<void, LinkError>;
    /** `task_cancel` on a link task: the record's status, or null when it is not a link task. */
    readonly stopTaskIfLinked: (input: {
      readonly requesterThreadId: ThreadId;
      readonly taskId: NodeId;
      readonly stoppedBy: string;
    }) => Effect.Effect<OrchestrationV2Subagent["status"] | null, LinkError>;
    readonly getChain: (chainId: LinkChainId) => Effect.Effect<LinkChain, LinkError>;
    /** An envelope the relay forwarded here, already verified; this environment decides. */
    readonly receive: (delivery: RelayLinkDelivery) => Effect.Effect<RelayLinkReceipt>;
    /** Sends a finished run's result back to a requester in another environment. */
    readonly returnRemoteResult: (
      threadId: ThreadId,
      runId: OrchestrationV2Run["id"],
    ) => Effect.Effect<void>;
    /** Sends what waits in the outbox; envelopes the target did not take stay for later. */
    readonly flushOutbox: Effect.Effect<void>;
  }
>()("t3/link/LinkService") {}

const storeFailure = (cause: unknown) =>
  new LinkError({
    code: "invalid_request",
    message: `Link storage failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const orchestrationFailure = (cause: unknown) =>
  new LinkError({
    code: "invalid_request",
    message: cause instanceof Error ? cause.message : String(cause),
  });

const notAPeer = (message = "That peer is not in a link group with this thread.") =>
  new LinkError({ code: "not_a_peer", message });

const notAuthorized = (message: string) => new LinkError({ code: "not_authorized", message });

const isOpen = (task: Pick<OrchestrationV2Subagent, "result" | "status">) =>
  task.result === null &&
  task.status !== "completed" &&
  task.status !== "failed" &&
  task.status !== "cancelled" &&
  task.status !== "interrupted";

const isTerminalRun = (run: Pick<OrchestrationV2Run, "status">) =>
  run.status === "completed" ||
  run.status === "failed" ||
  run.status === "interrupted" ||
  run.status === "cancelled" ||
  run.status === "rolled_back";

const sameThread = (left: LinkThreadRef, right: LinkThreadRef) =>
  left.environmentId === right.environmentId && left.threadId === right.threadId;

/** How long an undelivered envelope keeps trying; a result older than this has no one waiting. */
/** A view without a version predates versioning, so it never outranks or loses to one. */
const isStaleView = (held: number | undefined, incoming: number | undefined) =>
  held !== undefined && incoming !== undefined && incoming < held;

const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The chain lists every hop's reply at once; the full text stays in the requester's record. */
export const LINK_CHAIN_RESULT_MAX_LENGTH = 4_000;
const LINK_CHAIN_RESULT_TRUNCATED = "\n\n[Reply truncated. Open the thread for the full text.]";

export function chainTaskResult(result: string | null | undefined): string | null {
  const text = result?.trim();
  if (!text) return null;
  return text.length <= LINK_CHAIN_RESULT_MAX_LENGTH
    ? text
    : `${text.slice(0, LINK_CHAIN_RESULT_MAX_LENGTH).trimEnd()}${LINK_CHAIN_RESULT_TRUNCATED}`;
}

const RECEIPT_CODES: Partial<Record<LinkErrorCode, RelayLinkReceiptCode>> = {
  not_a_peer: "not_a_peer",
  not_found: "not_a_peer",
  hop_limit: "hop_limit",
  cycle: "cycle",
  chain_stopped: "chain_stopped",
  link_paused: "link_paused",
  rate_limited: "rate_limited",
  not_authorized: "not_authorized",
  invalid_request: "invalid",
};

const LINK_ERROR_CODES: Partial<Record<RelayLinkReceiptCode, LinkErrorCode>> = {
  not_a_peer: "not_a_peer",
  hop_limit: "hop_limit",
  cycle: "cycle",
  chain_stopped: "chain_stopped",
  link_paused: "link_paused",
  rate_limited: "rate_limited",
  not_authorized: "not_authorized",
};

function chainTaskStatus(task: OrchestrationV2Subagent | undefined): LinkTaskStatus {
  if (task === undefined) return "failed";
  if (task.link?.stoppedBy !== undefined && !isOpen(task)) return "stopped";
  if (task.link?.remoteState !== undefined && isOpen(task)) return task.link.remoteState;
  switch (task.status) {
    case "idle":
    case "pending":
      return "queued";
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "cancelled":
      return "stopped";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
  }
}

function runTaskStatus(run: OrchestrationV2Run | undefined): LinkTaskStatus {
  switch (run?.status) {
    case undefined:
      return "failed";
    case "preparing":
    case "queued":
      return "queued";
    case "starting":
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "rolled_back":
      return "stopped";
    case "interrupted":
      return "interrupted";
  }
}

/** A group as one of this environment's threads sees it: homed here, or in another environment. */
interface GroupView {
  readonly linkId: LinkGroupId;
  readonly name: string;
  readonly status: LinkGroup["status"];
  readonly members: ReadonlyArray<LinkMember>;
  readonly membership?: LinkStore.LinkRemoteMembership;
}

const make = Effect.gen(function* () {
  const store = yield* LinkStore.LinkStore;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const relay = yield* LinkRelay.LinkRelay;
  const crypto = yield* Crypto.Crypto;
  const eventSink = yield* EventSink.EventSinkV2;
  const environmentId: EnvironmentId = yield* environment.getEnvironmentId;
  const changes = yield* PubSub.unbounded<void>();
  // Membership edits and assignments check state and then write it; one at a time keeps the
  // checks true when the write lands. Both are rare.
  const writes = yield* Semaphore.make(1);
  const outboxLock = yield* Semaphore.make(1);
  // Reporting a run reads what was last reported and then sends; one report at a time.
  const reportLock = yield* Semaphore.make(1);
  // What each remote peer's environment last said about approval, by `<env>:<thread>`.
  const approvals = new Map<string, boolean>();
  // The last state reported for each task run here for a remote requester.
  const reportedStates = new Map<NodeId, string>();

  const listGroups = store.listGroups.pipe(Effect.mapError(storeFailure));
  const listMemberships = store.listRemoteMemberships.pipe(Effect.mapError(storeFailure));
  const snapshot = listGroups.pipe(Effect.map((groups) => ({ environmentId, groups })));

  const local = (threadId: ThreadId): LinkThreadRef => ({ environmentId, threadId });
  const isLocal = (ref: Pick<LinkThreadRef, "environmentId">) =>
    ref.environmentId === environmentId;
  const refKey = (ref: LinkThreadRef) => `${ref.environmentId}:${ref.threadId}`;

  const threadShell = (threadId: ThreadId) =>
    orchestrator.getThreadShell(threadId).pipe(
      Effect.mapError(orchestrationFailure),
      Effect.map((shell) =>
        shell === null || shell.deletedAt !== null || shell.archivedAt !== null ? null : shell,
      ),
    );

  const newId = (prefix: string) =>
    crypto.randomUUIDv4().pipe(
      Effect.orDie,
      Effect.map((uuid) => `${prefix}:${uuid}`),
    );
  const newCommandId = (operation: string) =>
    newId(`link:${operation}`).pipe(Effect.map(CommandId.make));
  const nowMs = Effect.map(DateTime.now, DateTime.toEpochMillis);

  const flushOutbox = outboxLock
    .withPermits(1)(
      Effect.gen(function* () {
        const pending = yield* store.listOutbox.pipe(Effect.orElseSucceed(() => []));
        const now = yield* nowMs;
        for (const { envelope, createdAtMs } of pending) {
          if (now - createdAtMs > OUTBOX_MAX_AGE_MS) {
            yield* store.dequeue(envelope.id).pipe(Effect.ignore);
            continue;
          }
          const response = yield* relay.send(envelope);
          if (response === null) return;
          // A membership view may be refused until the reverse share reaches the relay.
          const retry =
            response.outcome === "peer_offline" ||
            response.outcome === "rate_limited" ||
            (envelope.body.kind === "member-joined" &&
              (response.outcome === "not_authorized" ||
                response.receipt?.code === "not_authorized"));
          if (retry) continue;
          yield* store.dequeue(envelope.id).pipe(Effect.ignore);
          if (response.receipt?.requiresApproval !== undefined) {
            approvals.set(refKey(envelope.target), response.receipt.requiresApproval);
          }
        }
      }),
    )
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to send linked-thread envelopes", { cause }),
      ),
    );

  const enqueue = Effect.fn("LinkService.enqueue")(function* (
    envelope: RelayLinkEnvelope,
    options: { readonly flush?: boolean } = {},
  ) {
    yield* store.enqueue(envelope, yield* nowMs).pipe(Effect.mapError(storeFailure));
    if (options.flush !== false) yield* flushOutbox;
  });

  const memberInfo = Effect.fn("LinkService.memberInfo")(function* (member: LinkMember) {
    const shell = isLocal(member) ? yield* threadShell(member.threadId) : null;
    return {
      environmentId: member.environmentId,
      threadId: member.threadId,
      purpose: member.purpose,
      title: (shell?.title ?? member.title ?? "").slice(0, 512),
      owner: member.owner ?? null,
    } satisfies RelayLinkMemberInfo;
  });

  /** Tells remote members what changed. The first local member speaks for the home. */
  const syncMembers = Effect.fn("LinkService.syncMembers")(function* (
    before: LinkGroup | undefined,
    after: LinkGroup | undefined,
    version: number,
  ) {
    const linkId = (after ?? before)?.linkId;
    if (linkId === undefined) return;
    const remoteAfter = (after?.members ?? []).filter((member) => !isLocal(member));
    const removed = (before?.members ?? []).filter(
      (member) =>
        !isLocal(member) && !remoteAfter.some((candidate) => sameThread(candidate, member)),
    );
    const speaker = (group: LinkGroup | undefined) =>
      group?.members.find((member) => isLocal(member));
    let queued = false;
    const afterSpeaker = speaker(after);
    if (after !== undefined && afterSpeaker !== undefined && remoteAfter.length > 0) {
      const members = yield* Effect.forEach(after.members, memberInfo);
      for (const member of remoteAfter) {
        yield* enqueue(
          {
            id: `joined:${linkId}:${refKey(member)}`,
            linkId,
            sender: { environmentId, threadId: afterSpeaker.threadId },
            target: { environmentId: member.environmentId, threadId: member.threadId },
            body: {
              kind: "member-joined",
              linkName: after.name,
              status: after.status,
              members,
              version,
            },
          },
          { flush: false },
        );
        queued = true;
      }
    }
    const beforeSpeaker = speaker(before) ?? afterSpeaker;
    if (beforeSpeaker !== undefined) {
      for (const member of removed) {
        yield* store.dequeue(`joined:${linkId}:${refKey(member)}`).pipe(Effect.ignore);
        yield* enqueue(
          {
            id: `left:${linkId}:${refKey(member)}`,
            linkId,
            sender: { environmentId, threadId: beforeSpeaker.threadId },
            target: { environmentId: member.environmentId, threadId: member.threadId },
            body: { kind: "member-left", reason: "user" },
          },
          { flush: false },
        );
        queued = true;
      }
    }
    if (queued) yield* flushOutbox;
  });

  const runCommand = Effect.fn("LinkService.runCommand")(function* (
    command: LinkCommand,
    groups: ReadonlyArray<LinkGroup>,
  ) {
    const before = groups.find((group) => group.linkId === command.linkId);
    const decided = decideLinkCommand({ command, group: before, now: yield* DateTime.now });
    if (Result.isFailure(decided)) return yield* decided.failure;
    if (decided.success.length === 0) return;
    const committed = yield* store.commit(decided.success).pipe(Effect.mapError(storeFailure));
    yield* PubSub.publish(changes, undefined);
    const after = (yield* listGroups).find((group) => group.linkId === command.linkId);
    // Event sequences only grow, so the last one versions this view of the group.
    yield* syncMembers(before, after, committed.at(-1)?.sequence ?? 0);
  });

  const userCommand = (build: (commandId: CommandId) => LinkCommand) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const command = build(yield* newCommandId("user"));
        yield* runCommand(command, yield* listGroups);
      }),
    );

  const linkableThread = Effect.fn("LinkService.linkableThread")(function* (threadId: ThreadId) {
    const shell = yield* threadShell(threadId);
    if (shell === null) {
      return yield* new LinkError({
        code: "invalid_request",
        message: `Thread ${threadId} is archived, deleted or missing.`,
      });
    }
    // Delegated children answer to their parent; linking one would give it a second owner.
    if (shell.lineage.relationshipToParent === "subagent") {
      return yield* new LinkError({
        code: "invalid_request",
        message: "Delegated child threads cannot join a link group.",
      });
    }
    return shell;
  });

  /** A member from user input: a thread here, or one in another environment (#21 phase 2). */
  const toMember = Effect.fn("LinkService.toMember")(function* (input: LinkMemberInput) {
    const memberEnvironment = input.environmentId ?? environmentId;
    if (memberEnvironment === environmentId) {
      yield* linkableThread(input.threadId);
      return { ...local(input.threadId), purpose: input.purpose } satisfies LinkMember;
    }
    return {
      environmentId: memberEnvironment,
      threadId: input.threadId,
      purpose: input.purpose,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.owner === undefined ? {} : { owner: input.owner }),
    } satisfies LinkMember;
  });

  const create = Effect.fn("LinkService.create")(function* (input: LinkCreateInput) {
    const members = yield* Effect.forEach(input.members, toMember);
    if (!members.some((member) => isLocal(member))) {
      return yield* new LinkError({
        code: "invalid_request",
        message: "A link group needs a thread in this environment.",
      });
    }
    const linkId = LinkGroupId.make(yield* newId("link"));
    yield* userCommand((commandId) => ({
      type: "link.create",
      commandId,
      linkId,
      name: input.name,
      members,
    }));
    return { linkId };
  });

  const setMember = Effect.fn("LinkService.setMember")(function* (input: LinkSetMemberInput) {
    const member = yield* toMember(input);
    yield* userCommand((commandId) => ({
      type: "link.member.set",
      commandId,
      linkId: input.linkId,
      member,
    }));
  });

  const removeMember = Effect.fn("LinkService.removeMember")(function* (
    input: LinkRemoveMemberInput,
  ) {
    yield* userCommand((commandId) => ({
      type: "link.member.remove",
      commandId,
      linkId: input.linkId,
      member: {
        environmentId: input.environmentId ?? environmentId,
        threadId: input.threadId,
      },
      reason: "user",
    }));
  });

  const groupCommand = (type: "link.pause" | "link.resume" | "link.end") =>
    Effect.fn(`LinkService.${type}`)(function* (input: LinkGroupInput) {
      yield* userCommand((commandId) => ({ type, commandId, linkId: input.linkId }));
    });

  const viewOfMembership = (membership: LinkStore.LinkRemoteMembership): GroupView => ({
    linkId: membership.linkId,
    name: membership.name,
    status: membership.status,
    members: membership.members.map((member) => ({
      environmentId: member.environmentId,
      threadId: member.threadId,
      purpose: member.purpose,
      title: member.title,
      ...(member.owner === null ? {} : { owner: member.owner }),
    })),
    membership,
  });

  /** Groups the thread belongs to, homed here or in another environment. */
  const callerViews = Effect.fn("LinkService.callerViews")(function* (threadId: ThreadId) {
    const me = local(threadId);
    const groups: Array<GroupView> = (yield* listGroups).filter((group) =>
      group.members.some((member) => sameThread(member, me)),
    );
    for (const membership of yield* listMemberships) {
      if (membership.threadId === threadId) groups.push(viewOfMembership(membership));
    }
    return groups;
  });

  /** Peers with what only the link context needs: the group, the ref, and whether it works. */
  const peerRows = Effect.fn("LinkService.peerRows")(function* (
    callerThreadId: ThreadId,
    options: { readonly views?: ReadonlyArray<GroupView>; readonly quick?: boolean } = {},
  ) {
    const me = local(callerThreadId);
    const views = options.views ?? (yield* callerViews(callerThreadId));
    const remote = views.flatMap((view) =>
      view.members.filter((member) => !isLocal(member) && !sameThread(member, me)),
    );
    // A turn does not wait long on fwai Connect; an unknown answer keeps the last status.
    const askPresence = (request: Parameters<typeof relay.presence>[0]) =>
      options.quick === true
        ? relay
            .presence(request)
            .pipe(Effect.timeoutOption("2 seconds"), Effect.map(Option.getOrNull))
        : relay.presence(request);
    const presence =
      remote.length === 0
        ? null
        : yield* askPresence({
            sender: me,
            targets: [
              ...new Map(
                remote.map((member) => [
                  refKey(member),
                  { environmentId: member.environmentId, threadId: member.threadId },
                ]),
              ).values(),
            ].slice(0, RELAY_LINK_PRESENCE_MAX_TARGETS),
          });
    const result: Array<{
      readonly linkId: LinkGroupId;
      readonly ref: LinkThreadRef;
      readonly peer: LinkPeer;
      /** Local peers only: a run is active. */
      readonly working: boolean;
      /** Whether the relay sees the peer; null when it did not answer. */
      readonly reachable: boolean | null;
    }> = [];
    for (const view of views) {
      for (const member of view.members) {
        if (sameThread(member, me)) continue;
        const ref = { environmentId: member.environmentId, threadId: member.threadId };
        const base = {
          peerId: linkPeerId(member.threadId),
          linkName: view.name,
          purpose: member.purpose,
          paused: view.status === "paused",
        };
        if (isLocal(member)) {
          const shell = yield* threadShell(member.threadId);
          if (shell === null) continue;
          const project = yield* projects
            .get(shell.projectId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          result.push({
            linkId: view.linkId,
            ref,
            working: shell.activeRunId !== null,
            reachable: true,
            peer: {
              ...base,
              title: shell.title,
              location: "local",
              project: Option.match(project, { onNone: () => "", onSome: (row) => row.title }),
              online: true,
            },
          });
          continue;
        }
        const seen = presence?.peers.find((peer) => sameThread(peer, member));
        result.push({
          linkId: view.linkId,
          ref,
          working: false,
          reachable: presence === null ? null : seen?.online === true,
          peer: {
            ...base,
            title: member.title ?? "",
            location: "remote",
            project: "",
            online: seen?.online === true,
            environment: member.environmentId,
            owner: member.owner ?? null,
            requiresApproval:
              seen?.relation === "same_account" ? false : (approvals.get(refKey(member)) ?? true),
          },
        });
      }
    }
    return result;
  });

  const peers = Effect.fn("LinkService.peers")(function* (callerThreadId: ThreadId) {
    return (yield* peerRows(callerThreadId)).map((row) => row.peer);
  });

  // A peer in several of the caller's groups has one id; assign through a group that is not paused.
  const findPeer = (views: ReadonlyArray<GroupView>, callerThreadId: ThreadId, peerId: string) => {
    const me = local(callerThreadId);
    const wanted = peerId.trim();
    const matches = views.flatMap((view) =>
      view.members
        .filter((member) => !sameThread(member, me) && linkPeerId(member.threadId) === wanted)
        .map((member) => ({ view, member })),
    );
    return matches.find(({ view }) => view.status !== "paused") ?? matches[0];
  };

  const unknownPeer = (
    views: ReadonlyArray<GroupView>,
    callerThreadId: ThreadId,
    peerId: string,
  ) => {
    const me = local(callerThreadId);
    const peers = [
      ...new Set(
        views.flatMap((view) =>
          view.members
            .filter((member) => !sameThread(member, me))
            .map((member) => linkPeerId(member.threadId)),
        ),
      ),
    ];
    return notAPeer(
      peers.length === 0
        ? "This thread is in no link group."
        : `No peer "${peerId}" here. Use a peerId exactly as listed: ${peers.join(", ")}.`,
    );
  };

  const resolvePeer = Effect.fn("LinkService.resolvePeer")(function* (
    callerThreadId: ThreadId,
    peerId: string,
  ) {
    const views = yield* callerViews(callerThreadId);
    const found = findPeer(views, callerThreadId, peerId);
    if (found === undefined) return yield* unknownPeer(views, callerThreadId, peerId);
    return { environmentId: found.member.environmentId, threadId: found.member.threadId };
  });

  // A remote requester's record lives in its own environment; reading it here finds nothing.
  const taskRecord = (row: LinkStore.LinkTaskIndexRow) =>
    orchestrator.getThreadRecords(row.requester.threadId, ["subagents"]).pipe(
      Effect.map(({ subagents }) =>
        isLocal(row.requester) ? subagents.find((task) => task.id === row.taskId) : undefined,
      ),
      Effect.orElseSucceed(() => undefined),
    );

  const assigneeRun = (row: LinkStore.LinkTaskIndexRow) =>
    orchestrator.getThreadRecords(row.assignee.threadId, ["runs"]).pipe(
      Effect.map(({ runs }) => runs.filter((run) => run.linkTask?.taskId === row.taskId)),
      Effect.map((runs) => runs.toSorted((left, right) => right.ordinal - left.ordinal)[0]),
      Effect.mapError(orchestrationFailure),
    );

  /** Whether a task is unfinished: by the requester's record, or by the run when that is remote. */
  const rowOpen = Effect.fn("LinkService.rowOpen")(function* (row: LinkStore.LinkTaskIndexRow) {
    if (isLocal(row.requester)) {
      const task = yield* taskRecord(row);
      return task !== undefined && isOpen(task);
    }
    const run = yield* assigneeRun(row).pipe(Effect.orElseSucceed(() => undefined));
    return run !== undefined && !isTerminalRun(run);
  });

  /** Threads with unfinished work on the chain: they wait on it, so assigning to one is a cycle. */
  const waitingThreads = Effect.fn("LinkService.waitingThreads")(function* (chainId: LinkChainId) {
    const waiting = new Set<ThreadId>();
    const tasks = yield* store.chainTasks(chainId).pipe(Effect.mapError(storeFailure));
    for (const row of tasks) {
      if (!(yield* rowOpen(row))) continue;
      waiting.add(row.requester.threadId);
      waiting.add(row.assignee.threadId);
    }
    return waiting;
  });

  const assign = Effect.fn("LinkService.assign")(function* (input: {
    readonly callerThreadId: ThreadId;
    readonly peerId: string;
    readonly task: string;
  }) {
    return yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const views = yield* callerViews(input.callerThreadId);
        const found = findPeer(views, input.callerThreadId, input.peerId);
        if (found === undefined)
          return yield* unknownPeer(views, input.callerThreadId, input.peerId);
        if (isLocal(found.member) && (yield* threadShell(found.member.threadId)) === null) {
          return yield* notAPeer("That peer's thread is archived or deleted.");
        }
        const caller = yield* orchestrator
          .getThreadRecords(input.callerThreadId, ["runs", "subagents", "messages"], {
            messageRoles: ["user"],
          })
          .pipe(Effect.mapError(orchestrationFailure));
        const run = caller.runs
          .filter(isActiveRun)
          .toSorted((left, right) => right.ordinal - left.ordinal)[0];
        if (run === undefined || run.rootNodeId === null) {
          return yield* new LinkError({
            code: "not_active",
            message: "Assigning work needs an active turn in the calling thread.",
          });
        }
        const chain = resolveCallerChain({
          threadId: input.callerThreadId,
          run,
          runs: caller.runs,
          subagents: caller.subagents,
          messages: caller.messages,
        });
        const createdAtMs = yield* nowMs;
        const decided = decideLinkAssignment({
          group: found.view,
          caller: local(input.callerThreadId),
          target: found.member,
          chain,
          chainStopped: yield* store
            .isChainStopped(chain.chainId)
            .pipe(Effect.mapError(storeFailure)),
          waitingThreads: yield* waitingThreads(chain.chainId),
          recentGroupTasks: (yield* store
            .tasksSince(createdAtMs - LINK_RATE_LIMIT.windowMs, found.view.linkId)
            .pipe(Effect.mapError(storeFailure))).length,
        });
        if (Result.isFailure(decided)) return yield* decided.failure;
        const callerMember = found.view.members.find((member) =>
          sameThread(member, local(input.callerThreadId)),
        );
        const callerProject = yield* projects
          .get(caller.thread.projectId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        const assignee = {
          environmentId: found.member.environmentId,
          threadId: found.member.threadId,
        };
        const taskId = yield* delivery.assign({
          commandId: yield* newCommandId("assign"),
          requester: local(input.callerThreadId),
          requesterRunId: run.id,
          requesterNodeId: run.rootNodeId,
          requesterRuntimeMode: narrowerRuntimeMode(
            caller.thread.runtimeMode,
            run.runtimeModeCeiling,
          ),
          ...(run.actingAccountId === undefined
            ? {}
            : { requesterActingAccountId: run.actingAccountId }),
          assignee,
          task: input.task,
          link: decided.success,
          sender: {
            threadTitle: caller.thread.title,
            projectTitle: Option.match(callerProject, {
              onNone: () => "unknown",
              onSome: (row) => row.title,
            }),
            purpose: callerMember?.purpose ?? "",
          },
        });
        yield* store
          .recordTask({
            taskId,
            linkId: found.view.linkId,
            chainId: decided.success.chainId,
            parentTaskId: decided.success.parentTaskId,
            hop: decided.success.hop,
            requester: local(input.callerThreadId),
            assignee,
            createdAtMs,
          })
          .pipe(Effect.mapError(storeFailure));
        return { taskId, peerId: input.peerId };
      }),
    );
  });

  const assignLocal = (envelope: LinkAssignEnvelope) =>
    orchestrator
      .dispatch({
        type: "link_task.assign",
        commandId: envelope.commandId,
        requester: envelope.requester,
        requesterRunId: envelope.requesterRunId,
        requesterNodeId: envelope.requesterNodeId,
        assignee: envelope.assignee,
        task: envelope.task,
        link: envelope.link,
        sender: envelope.sender,
        ...(envelope.requesterActingAccountId === undefined
          ? {}
          : { actingAccountId: envelope.requesterActingAccountId }),
      })
      .pipe(
        Effect.mapError(orchestrationFailure),
        Effect.flatMap((result) => {
          const created = result.storedEvents.find(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.threadId === envelope.requester.threadId,
          );
          return created === undefined
            ? Effect.fail(orchestrationFailure("The task was not recorded."))
            : Effect.succeed(created.event.nodeId as NodeId);
        }),
      );

  /** The other environment decides first; the task is recorded here only once it took it. */
  const assignRemote = Effect.fn("LinkService.assignRemote")(function* (
    envelope: LinkAssignEnvelope,
  ) {
    const taskId = NodeId.make(yield* newId("link-task"));
    // A membership view still waiting to be delivered must land before the task does.
    yield* flushOutbox;
    const response = yield* relay.send({
      id: `task:${taskId}`,
      linkId: envelope.link.linkId,
      sender: envelope.requester,
      target: envelope.assignee,
      body: {
        kind: "task",
        taskId,
        chainId: envelope.link.chainId,
        hop: envelope.link.hop,
        parentTaskId: envelope.link.parentTaskId,
        text: envelope.task,
        sender: envelope.sender,
        requesterRuntimeMode: envelope.requesterRuntimeMode,
      },
    });
    if (response === null) {
      return yield* new LinkError({
        code: "peer_offline",
        message:
          "This environment is not linked to fwai Connect, or cannot reach it, so it cannot reach other environments.",
      });
    }
    if (response.outcome === "peer_offline") {
      return yield* new LinkError({
        code: "peer_offline",
        message: "That peer's environment is offline. Try later, or do the work yourself.",
      });
    }
    if (response.outcome === "not_authorized") {
      return yield* notAuthorized(
        "Neither one account nor a share in both directions links these threads. Ask your user to share them.",
      );
    }
    if (response.outcome === "rate_limited") {
      return yield* new LinkError({
        code: "rate_limited",
        message: "Too many tasks crossed to other environments just now. Wait, or ask your user.",
      });
    }
    const receipt = response.receipt;
    if (receipt === undefined || !receipt.accepted) {
      return yield* new LinkError({
        code:
          (receipt?.code === undefined ? undefined : LINK_ERROR_CODES[receipt.code]) ??
          "invalid_request",
        message: receipt?.message ?? "The peer's environment refused the task.",
      });
    }
    if (receipt.requiresApproval !== undefined) {
      approvals.set(refKey(envelope.assignee), receipt.requiresApproval);
    }
    yield* orchestrator
      .dispatch({
        type: "link_task.assign",
        commandId: envelope.commandId,
        remote: "assignee",
        taskId,
        requester: envelope.requester,
        requesterRunId: envelope.requesterRunId,
        requesterNodeId: envelope.requesterNodeId,
        assignee: envelope.assignee,
        task: envelope.task,
        link: envelope.link,
        sender: envelope.sender,
      })
      .pipe(
        Effect.mapError(orchestrationFailure),
        // The peer already queued it; take it back so nothing runs without a requester.
        Effect.tapError(() =>
          enqueue({
            id: `cancel:${taskId}`,
            linkId: envelope.link.linkId,
            sender: envelope.requester,
            target: envelope.assignee,
            body: { kind: "cancel", taskId, stoppedBy: "the requester, which could not record it" },
          }).pipe(Effect.ignore),
        ),
      );
    return taskId;
  });

  const cancelLocal = Effect.fn("LinkDelivery.cancelLocal")(
    function* (row: LinkStore.LinkTaskIndexRow) {
      const run = yield* assigneeRun(row);
      if (run === undefined) return;
      const commandId = CommandId.make(`link:cancel:${row.taskId}:${run.id}`);
      if (run.status === "queued") {
        yield* orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId,
          threadId: row.assignee.threadId,
          runId: run.id,
        });
      } else if (isActiveRun(run)) {
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId,
          threadId: row.assignee.threadId,
          runId: run.id,
          reason: "Linked task stopped",
        });
      }
    },
    (effect) => effect.pipe(Effect.mapError(orchestrationFailure), Effect.asVoid),
  );

  const delivery: LinkDelivery = {
    assign: (envelope) =>
      isLocal(envelope.assignee) ? assignLocal(envelope) : assignRemote(envelope),
    result: (row) =>
      isLocal(row.requester) && isLocal(row.assignee)
        ? assigneeRun(row).pipe(
            Effect.flatMap((run) =>
              run === undefined
                ? Effect.void
                : orchestrator
                    .finalizeLinkTask(row.requester.threadId, row.assignee.threadId, run.id)
                    .pipe(Effect.mapError(orchestrationFailure)),
            ),
          )
        : !isLocal(row.requester)
          ? assigneeRun(row).pipe(
              Effect.flatMap((run) =>
                run === undefined ? Effect.void : returnRemoteResult(row.assignee.threadId, run.id),
              ),
            )
          : Effect.void,
    cancel: (row, stoppedBy) =>
      isLocal(row.assignee)
        ? cancelLocal(row)
        : Effect.gen(function* () {
            yield* enqueue({
              id: `cancel:${row.taskId}`,
              linkId: row.linkId,
              sender: row.requester,
              target: row.assignee,
              body: { kind: "cancel", taskId: row.taskId, stoppedBy },
            });
            // The requester learns at once; whatever the peer reports later is ignored.
            if (isLocal(row.requester)) {
              yield* orchestrator
                .applyRemoteLinkUpdate(row.requester.threadId, row.taskId, {
                  type: "result",
                  outcome: "stopped",
                  text: "",
                  stoppedBy,
                })
                .pipe(Effect.mapError(orchestrationFailure));
            }
          }),
  };

  /** Stops a task here and every task derived from it, wherever they run. */
  const stopSubtree = Effect.fn("LinkService.stopSubtree")(function* (
    root: LinkStore.LinkTaskIndexRow,
    stoppedBy: string,
  ) {
    yield* store
      .stopChain({
        chainId: root.chainId,
        stoppedBy,
        stoppedAt: DateTime.formatIso(yield* DateTime.now),
      })
      .pipe(Effect.mapError(storeFailure));
    const chain = yield* store.chainTasks(root.chainId).pipe(Effect.mapError(storeFailure));
    // Top-down, so each assignee is interrupted before its own tasks' results could wake it.
    const subtree: Array<LinkStore.LinkTaskIndexRow> = [root];
    for (let index = 0; index < subtree.length; index++) {
      const parent = subtree[index]!;
      subtree.push(...chain.filter((row) => row.parentTaskId === parent.taskId));
    }
    for (const row of subtree) {
      if (!isLocal(row.requester)) continue;
      yield* orchestrator
        .dispatch({
          type: "link_task.mark-stopped",
          commandId: CommandId.make(`link:mark-stopped:${row.taskId}`),
          requesterThreadId: row.requester.threadId,
          taskId: row.taskId,
          stoppedBy,
        })
        .pipe(Effect.ignore);
    }
    for (const row of subtree) yield* delivery.cancel(row, stoppedBy);
  });

  const stopTask = Effect.fn("LinkService.stopTask")(function* (input: {
    readonly requesterThreadId: ThreadId;
    readonly taskId: NodeId;
    readonly stoppedBy: string;
  }) {
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const root = yield* store.getTask(input.taskId).pipe(Effect.mapError(storeFailure));
        if (root === null || root.requester.threadId !== input.requesterThreadId) {
          return yield* new LinkError({
            code: "not_found",
            message: `Link task ${input.taskId} does not belong to thread ${input.requesterThreadId}.`,
          });
        }
        yield* stopSubtree(root, input.stoppedBy);
      }),
    );
  });

  const stopTaskIfLinked = Effect.fn("LinkService.stopTaskIfLinked")(function* (input: {
    readonly requesterThreadId: ThreadId;
    readonly taskId: NodeId;
    readonly stoppedBy: string;
  }) {
    const row = yield* store.getTask(input.taskId).pipe(Effect.mapError(storeFailure));
    if (row === null || row.requester.threadId !== input.requesterThreadId) return null;
    const before = yield* taskRecord(row);
    yield* stopTask(input);
    return before === undefined || isOpen(before) ? "running" : before.status;
  });

  const getChain = Effect.fn("LinkService.getChain")(function* (chainId: LinkChainId) {
    const rows = yield* store.chainTasks(chainId).pipe(Effect.mapError(storeFailure));
    const tasks: Array<LinkChainTask> = [];
    for (const row of rows) {
      const task = yield* taskRecord(row);
      // A task from another environment has no record here; its run tells how it goes.
      const run =
        task === undefined && isLocal(row.assignee)
          ? yield* assigneeRun(row).pipe(Effect.orElseSucceed(() => undefined))
          : undefined;
      tasks.push({
        taskId: row.taskId,
        linkId: row.linkId,
        hop: row.hop,
        parentTaskId: row.parentTaskId,
        requester: row.requester,
        assignee: row.assignee,
        prompt: task?.prompt ?? "",
        status:
          task === undefined && run !== undefined ? runTaskStatus(run) : chainTaskStatus(task),
        stoppedBy: task?.link?.stoppedBy ?? null,
        result: chainTaskResult(task?.result),
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(row.createdAtMs)),
      });
    }
    return {
      chainId,
      stopped: yield* store.isChainStopped(chainId).pipe(Effect.mapError(storeFailure)),
      tasks,
    };
  });

  const principalOf = (delivery: RelayLinkDelivery): AuthAccountPrincipal => ({
    accountId: delivery.actingAccountId,
    organization: delivery.actingOrganization,
    shareIds: [],
  });

  /**
   * Across accounts the acting account must reach the thread through this environment's own
   * shares, as a collaborator session would (#20). The broadest matching share decides approval.
   */
  const remoteAccess = Effect.fn("LinkService.remoteAccess")(function* (
    delivery: RelayLinkDelivery,
    threadId: ThreadId,
    need: "collaborator" | "any",
  ) {
    if (delivery.relation === "same_account") return { requiresApproval: false };
    const { thread } = yield* orchestrator
      .getThreadRecords(threadId, [])
      .pipe(Effect.mapError(orchestrationFailure));
    const principal = principalOf(delivery);
    const access = threadAccessFor(principal, thread);
    if (access === null || (need === "collaborator" && access !== "collaborator")) {
      return yield* notAuthorized("This thread is not shared with that account as a collaborator.");
    }
    return { requiresApproval: collaboratorRunNeedsApproval(principal, thread.shares) };
  });

  /** The group as this environment knows it, if both threads are in it. */
  const viewWith = Effect.fn("LinkService.viewWith")(function* (
    linkId: LinkGroupId,
    target: LinkThreadRef,
    other: LinkThreadRef,
  ) {
    const home = (yield* listGroups).find((group) => group.linkId === linkId);
    const views: Array<GroupView> =
      home === undefined
        ? (yield* listMemberships)
            .filter(
              (membership) =>
                membership.linkId === linkId && membership.threadId === target.threadId,
            )
            .map(viewOfMembership)
        : [home];
    return views.find(
      (view) =>
        view.members.some((member) => sameThread(member, target)) &&
        view.members.some((member) => sameThread(member, other)),
    );
  });

  const receiveTask = Effect.fn("LinkService.receiveTask")(function* (
    delivery: RelayLinkDelivery,
    body: Extract<RelayLinkEnvelopeBody, { readonly kind: "task" }>,
  ) {
    const targetThreadId = delivery.target.threadId;
    const shell = yield* threadShell(targetThreadId);
    if (shell === null || shell.lineage.relationshipToParent === "subagent") {
      return yield* notAPeer("That thread cannot take tasks.");
    }
    const access = yield* remoteAccess(delivery, targetThreadId, "collaborator");
    const view = yield* viewWith(delivery.linkId, local(targetThreadId), delivery.sender);
    if (view === undefined) return yield* notAPeer();
    if (view.status === "paused") {
      return yield* new LinkError({
        code: "link_paused",
        message: `Link group "${view.name}" is paused and accepts no new tasks.`,
      });
    }
    if (body.hop > LINK_MAX_HOPS) {
      return yield* new LinkError({
        code: "hop_limit",
        message: `This chain may cross at most ${LINK_MAX_HOPS} threads.`,
      });
    }
    if (yield* store.isChainStopped(body.chainId).pipe(Effect.mapError(storeFailure))) {
      return yield* new LinkError({
        code: "chain_stopped",
        message: "This work was stopped by a person here. Do not reassign it.",
      });
    }
    if ((yield* waitingThreads(body.chainId)).has(targetThreadId)) {
      return yield* new LinkError({
        code: "cycle",
        message: "That thread is already waiting on this chain of work.",
      });
    }
    const ceiling = access.requiresApproval
      ? narrowerRuntimeMode(body.requesterRuntimeMode, "approval-required")
      : body.requesterRuntimeMode;
    yield* orchestrator
      .dispatch({
        type: "link_task.assign",
        commandId: CommandId.make(`link:remote-task:${body.taskId}`),
        remote: "requester",
        taskId: body.taskId,
        requester: delivery.sender,
        assignee: local(targetThreadId),
        task: body.text,
        link: {
          linkId: delivery.linkId,
          chainId: body.chainId,
          hop: body.hop,
          parentTaskId: body.parentTaskId,
        },
        // Who is asking is the relay's word, never the sender's.
        sender: {
          threadTitle: body.sender.threadTitle,
          projectTitle: body.sender.projectTitle,
          purpose: body.sender.purpose,
          remote: {
            environmentId: delivery.sender.environmentId,
            accountId: delivery.actingAccountId,
            owner:
              view.members.find((member) => sameThread(member, delivery.sender))?.owner ?? null,
          },
        },
        runtimeModeCeiling: ceiling,
        // The same account's other environment is the owner here.
        ...(delivery.relation === "shared" ? { actingAccountId: delivery.actingAccountId } : {}),
      })
      .pipe(Effect.mapError(orchestrationFailure));
    yield* store
      .recordTask({
        taskId: body.taskId,
        linkId: delivery.linkId,
        chainId: body.chainId,
        parentTaskId: body.parentTaskId,
        hop: body.hop,
        requester: delivery.sender,
        assignee: local(targetThreadId),
        createdAtMs: yield* nowMs,
      })
      .pipe(Effect.mapError(storeFailure));
    return { accepted: true, requiresApproval: access.requiresApproval } satisfies RelayLinkReceipt;
  });

  /** A task this environment's thread assigned, answered by the thread it went to. */
  const requestedTask = Effect.fn("LinkService.requestedTask")(function* (
    delivery: RelayLinkDelivery,
    taskId: NodeId,
  ) {
    const row = yield* store.getTask(taskId).pipe(Effect.mapError(storeFailure));
    if (row === null || !isLocal(row.requester) || !sameThread(row.assignee, delivery.sender)) {
      return yield* notAPeer("No such task went to that thread.");
    }
    return row;
  });

  const removeFromHome = Effect.fn("LinkService.removeFromHome")(function* (
    group: LinkGroup,
    member: LinkThreadRef,
    reason: LinkMemberRemovalReason,
  ) {
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        yield* runCommand(
          {
            type: "link.member.remove",
            commandId: yield* newCommandId("member-left"),
            linkId: group.linkId,
            member,
            reason,
          },
          yield* listGroups,
        );
      }),
    );
  });

  const receiveKind = Effect.fn("LinkService.receiveKind")(function* (
    delivery: RelayLinkDelivery,
  ): Effect.fn.Return<RelayLinkReceipt, LinkError> {
    const body = delivery.body;
    switch (body.kind) {
      case "task":
        return yield* writes.withPermits(1)(receiveTask(delivery, body));
      case "status": {
        const row = yield* requestedTask(delivery, body.taskId);
        yield* orchestrator
          .applyRemoteLinkUpdate(row.requester.threadId, row.taskId, {
            type: "state",
            state: body.state,
          })
          .pipe(Effect.mapError(orchestrationFailure));
        return { accepted: true };
      }
      case "result": {
        const row = yield* requestedTask(delivery, body.taskId);
        yield* orchestrator
          .applyRemoteLinkUpdate(row.requester.threadId, row.taskId, {
            type: "result",
            outcome: body.outcome,
            text: body.text,
            stoppedBy:
              body.stoppedBy === undefined ? undefined : `${body.stoppedBy} on the other side`,
          })
          .pipe(Effect.mapError(orchestrationFailure));
        return { accepted: true };
      }
      case "cancel": {
        const row = yield* store.getTask(body.taskId).pipe(Effect.mapError(storeFailure));
        if (row === null || !isLocal(row.assignee) || !sameThread(row.requester, delivery.sender)) {
          return yield* notAPeer("No such task came from that thread.");
        }
        yield* writes.withPermits(1)(stopSubtree(row, `${body.stoppedBy} on the other side`));
        return { accepted: true };
      }
      case "member-joined": {
        const targetThreadId = delivery.target.threadId;
        const shell = yield* threadShell(targetThreadId);
        if (shell === null || shell.lineage.relationshipToParent === "subagent") {
          return yield* notAPeer("That thread cannot join a link group.");
        }
        if (!body.members.some((member) => sameThread(member, local(targetThreadId)))) {
          return yield* notAPeer("The group does not list this thread.");
        }
        const access = yield* remoteAccess(delivery, targetThreadId, "any");
        const held = (yield* listMemberships).find(
          (membership) =>
            membership.linkId === delivery.linkId && membership.threadId === targetThreadId,
        );
        // A replayed or reordered delivery must not roll the group back.
        if (isStaleView(held?.version, body.version)) {
          return { accepted: true, requiresApproval: access.requiresApproval };
        }
        yield* store
          .putRemoteMembership({
            linkId: delivery.linkId,
            threadId: targetThreadId,
            home: delivery.sender,
            name: body.linkName,
            status: body.status,
            members: body.members,
            homeAccountId: delivery.actingAccountId,
            homeOrganization: delivery.actingOrganization,
            relation: delivery.relation,
            ...(body.version === undefined ? {} : { version: body.version }),
          })
          .pipe(Effect.mapError(storeFailure));
        return { accepted: true, requiresApproval: access.requiresApproval };
      }
      case "member-left": {
        const home = (yield* listGroups).find((group) => group.linkId === delivery.linkId);
        if (home !== undefined) {
          if (home.members.some((member) => sameThread(member, delivery.sender))) {
            yield* removeFromHome(home, delivery.sender, body.reason ?? "share-ended");
          }
          return { accepted: true };
        }
        const membership = (yield* listMemberships).find(
          (candidate) =>
            candidate.linkId === delivery.linkId &&
            candidate.threadId === delivery.target.threadId &&
            candidate.home.environmentId === delivery.sender.environmentId,
        );
        if (membership !== undefined) {
          yield* store
            .deleteRemoteMembership({ linkId: membership.linkId, threadId: membership.threadId })
            .pipe(Effect.mapError(storeFailure));
        }
        return { accepted: true };
      }
      case "activity": {
        const targetThreadId = delivery.target.threadId;
        if ((yield* threadShell(targetThreadId)) === null) {
          return yield* notAPeer("That thread is archived, deleted or missing.");
        }
        yield* remoteAccess(delivery, targetThreadId, "any");
        const view = yield* viewWith(delivery.linkId, local(targetThreadId), delivery.sender);
        if (view === undefined) return yield* notAPeer();
        yield* store
          .putActivity({ linkId: delivery.linkId, member: delivery.sender, entry: body.entry })
          .pipe(Effect.mapError(storeFailure));
        return { accepted: true };
      }
    }
  });

  const receive = (delivery: RelayLinkDelivery) =>
    receiveKind(delivery).pipe(
      Effect.catch((error: LinkError) =>
        Effect.succeed({
          accepted: false,
          code: RECEIPT_CODES[error.code] ?? "unavailable",
          message: error.message.slice(0, 500),
        } satisfies RelayLinkReceipt),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to take a linked-thread envelope", { cause }).pipe(
          Effect.as({ accepted: false, code: "unavailable" } satisfies RelayLinkReceipt),
        ),
      ),
      Effect.withSpan("LinkService.receive", {
        attributes: { "link.envelope.kind": delivery.body.kind },
      }),
    );

  /** A run here for a requester elsewhere: report its progress, then return its result. */
  const returnRemoteResult = Effect.fn("LinkService.returnRemoteResult")(
    function* (threadId: ThreadId, runId: OrchestrationV2Run["id"]) {
      const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      const run = runs.find((candidate) => candidate.id === runId);
      const linkTask = run?.linkTask;
      if (run === undefined || linkTask === undefined || linkTask.sender.remote === undefined) {
        return;
      }
      const envelope = (body: RelayLinkEnvelopeBody, id: string): RelayLinkEnvelope => ({
        id,
        linkId: linkTask.linkId,
        sender: local(threadId),
        target: linkTask.requester,
        body,
      });
      if (!isTerminalRun(run)) {
        const state =
          run.status === "waiting"
            ? "waiting_for_owner_approval"
            : run.status === "running" || run.status === "starting"
              ? "running"
              : null;
        if (state === null || reportedStates.get(linkTask.taskId) === state) return;
        reportedStates.set(linkTask.taskId, state);
        yield* enqueue(
          envelope({ kind: "status", taskId: linkTask.taskId, state }, `status:${linkTask.taskId}`),
        );
        return;
      }
      // A restart continues the task in a new run, which carries the same link task.
      if (yield* orchestrator.restartContinuationPending(run)) return;
      reportedStates.delete(linkTask.taskId);
      const stoppedBy = yield* store.chainStoppedBy(linkTask.chainId);
      const records = yield* orchestrator.getThreadRecords(threadId, ["messages", "turnItems"], {
        messageRoles: ["assistant"],
        messageRunIds: [run.id],
        turnItemRunId: run.id,
        turnItemTypes: ["assistant_message", "error"],
      });
      yield* store.dequeue(`status:${linkTask.taskId}`).pipe(Effect.ignore);
      yield* enqueue(
        envelope(
          stoppedBy !== null && run.status !== "completed"
            ? { kind: "result", taskId: linkTask.taskId, outcome: "stopped", text: "", stoppedBy }
            : {
                kind: "result",
                taskId: linkTask.taskId,
                outcome:
                  run.status === "completed"
                    ? "completed"
                    : run.status === "failed"
                      ? "failed"
                      : "interrupted",
                text: subagentResultForRun(records, run).text.slice(0, RELAY_LINK_TEXT_MAX_LENGTH),
              },
          `result:${linkTask.taskId}`,
        ),
      );
    },
    (effect, threadId, runId) =>
      effect.pipe(
        reportLock.withPermits(1),
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to return a linked task's result", { threadId, runId, cause }),
        ),
      ),
  );

  const activity = Effect.fn("LinkService.activity")(function* (
    callerThreadId: ThreadId,
    peerId?: string,
  ) {
    const views = yield* callerViews(callerThreadId);
    const only = peerId === undefined ? undefined : findPeer(views, callerThreadId, peerId);
    if (peerId !== undefined && only === undefined) {
      return yield* unknownPeer(views, callerThreadId, peerId);
    }
    const rows = yield* store
      .listActivity(views.map((view) => view.linkId))
      .pipe(Effect.mapError(storeFailure));
    const me = local(callerThreadId);
    const result: Array<LinkPeerActivity> = [];
    for (const row of rows) {
      const view = views.find((candidate) => candidate.linkId === row.linkId);
      // Entries stay inside the group, and only for members it still has.
      const member = view?.members.find((candidate) => sameThread(candidate, row.member));
      if (view === undefined || member === undefined || sameThread(member, me)) continue;
      if (only !== undefined && !sameThread(only.member, member)) {
        continue;
      }
      const title = isLocal(member)
        ? ((yield* threadShell(member.threadId))?.title ?? member.title ?? "")
        : (member.title ?? "");
      result.push({
        ...row.entry,
        peerId: linkPeerId(member.threadId),
        peerTitle: title,
        linkName: view.name,
      });
    }
    return result;
  });

  /** The first sentence of the run's last reply, or the thread title; no model call. */
  const summaryOf = (text: string | undefined, fallback: string) => {
    const firstLine =
      (text ?? "")
        .split("\n")
        .map((line) => line.replace(/^[\s#>*-]+/, "").trim())
        .find((line) => line !== "") ?? "";
    const sentence = /^.*?[.!?](?=\s|$)/.exec(firstLine)?.[0] ?? firstLine;
    const summary = sentence === "" ? fallback : sentence;
    return summary.length <= LINK_ACTIVITY_SUMMARY_MAX_LENGTH
      ? summary
      : `${summary.slice(0, LINK_ACTIVITY_SUMMARY_MAX_LENGTH - 1).trimEnd()}…`;
  };

  const recordActivity = Effect.fn("LinkService.recordActivity")(
    function* (threadId: ThreadId, runId: OrchestrationV2Run["id"]) {
      const views = yield* callerViews(threadId);
      if (views.length === 0) return;
      const records = yield* orchestrator.getThreadRecords(threadId, ["runs", "messages"], {
        messageRoles: ["assistant"],
        messageRunIds: [runId],
      });
      const run = records.runs.find((candidate) => candidate.id === runId);
      if (run === undefined || !isTerminalRun(run) || run.status === "rolled_back") return;
      if (yield* orchestrator.restartContinuationPending(run)) return;
      const reply = records.messages
        .filter((message) => message.role === "assistant" && message.text.trim() !== "")
        .at(-1);
      const entry: LinkActivityEntry = {
        id: `run:${run.id}`,
        askedBy:
          run.linkTask === undefined
            ? "the user"
            : `peer "${run.linkTask.sender.threadTitle}"`.slice(0, 200),
        summary: summaryOf(reply?.text, records.thread.title),
        outcome:
          run.status === "completed" ? "completed" : run.status === "failed" ? "failed" : "stopped",
        at: DateTime.formatIso(run.completedAt ?? (yield* DateTime.now)),
      };
      const me = local(threadId);
      let queued = false;
      for (const view of views) {
        const added = yield* store
          .putActivity({ linkId: view.linkId, member: me, entry })
          .pipe(Effect.mapError(storeFailure));
        if (!added) continue;
        for (const member of view.members) {
          if (isLocal(member)) continue;
          yield* enqueue(
            {
              id: `activity:${view.linkId}:${entry.id}:${refKey(member)}`,
              linkId: view.linkId,
              sender: me,
              target: { environmentId: member.environmentId, threadId: member.threadId },
              body: { kind: "activity", entry },
            },
            { flush: false },
          );
          queued = true;
        }
      }
      if (queued) yield* flushOutbox;
    },
    (effect, threadId, runId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to record a linked thread's activity", {
            threadId,
            runId,
            cause,
          }),
        ),
      ),
  );

  // What each thread's provider last received, so a turn sends only what changed. Held in memory:
  // after a restart a thread gets the whole block once more.
  const sentContext = new Map<
    ThreadId,
    { readonly state: LinkContextState; readonly compactions: number }
  >();

  const contextState = Effect.fn("LinkService.contextState")(function* (
    threadId: ThreadId,
    views: ReadonlyArray<GroupView>,
    previous: LinkContextState | undefined,
  ) {
    const rows = yield* peerRows(threadId, { views, quick: true });
    const activities = yield* store
      .listActivity(views.map((view) => view.linkId))
      .pipe(Effect.mapError(storeFailure));
    const previousStatus = (linkId: LinkGroupId, peerId: string) =>
      previous?.groups
        .find((group) => group.linkId === linkId)
        ?.peers.find((peer) => peer.peerId === peerId)?.status;
    return {
      groups: views.map((view) => ({
        linkId: view.linkId,
        name: view.name,
        paused: view.status === "paused",
        peers: rows
          .filter((row) => row.linkId === view.linkId)
          .map((row): LinkContextPeer => {
            const { peer } = row;
            const where =
              peer.location === "local"
                ? `local${peer.project === "" ? "" : `, project ${peer.project}`}`
                : `remote${peer.owner == null ? "" : `, owner ${peer.owner}`}`;
            const status =
              peer.location === "local"
                ? row.working
                  ? "working"
                  : "idle"
                : row.reachable === null
                  ? (previousStatus(view.linkId, peer.peerId) ?? "offline")
                  : row.reachable
                    ? "online"
                    : "offline";
            return {
              peerId: peer.peerId,
              name: peer.title === "" ? "untitled thread" : peer.title,
              purpose: peer.purpose,
              where,
              status,
              activities: activities
                .filter(
                  (entry) => entry.linkId === view.linkId && sameThread(entry.member, row.ref),
                )
                .map((entry) => entry.entry),
            };
          }),
      })),
    } satisfies LinkContextState;
  });

  const contextForTurn = Effect.fn("LinkService.contextForTurn")(
    function* (input: { readonly threadId: ThreadId; readonly fresh: boolean }) {
      const { threadId } = input;
      const views = yield* callerViews(threadId);
      const held = sentContext.get(threadId);
      if (views.length === 0 && held === undefined) return null;
      const { turnItems } = yield* orchestrator.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["compaction"],
      });
      const compactions = turnItems.length;
      const state = yield* contextState(threadId, views, held?.state);
      const whole = input.fresh || held === undefined || held.compactions !== compactions;
      if (whole && state.groups.length === 0) {
        sentContext.delete(threadId);
        return null;
      }
      const text = whole ? renderLinkContext(state) : renderLinkContextUpdate(held.state, state);
      if (text === null) return null;
      return {
        text,
        commit: Effect.sync(() => {
          if (state.groups.length === 0) sentContext.delete(threadId);
          else sentContext.set(threadId, { state, compactions });
        }),
      } satisfies LinkTurnContext.LinkTurnContextBlock;
    },
    (effect, input) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to build the link context for a turn", {
            threadId: input.threadId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      ),
  );
  yield* (yield* LinkTurnContext.LinkTurnContext).bind({ forTurn: contextForTurn });

  const leaveRemoteGroups = Effect.fn("LinkService.leaveRemoteGroups")(function* (
    threadId: ThreadId,
    reason: LinkMemberRemovalReason,
    stillShared: (membership: LinkStore.LinkRemoteMembership) => Effect.Effect<boolean>,
  ) {
    for (const membership of yield* listMemberships) {
      if (membership.threadId !== threadId || (yield* stillShared(membership))) continue;
      yield* store
        .deleteRemoteMembership({ linkId: membership.linkId, threadId })
        .pipe(Effect.mapError(storeFailure));
      yield* enqueue({
        id: `left:${membership.linkId}:${refKey(local(threadId))}`,
        linkId: membership.linkId,
        sender: local(threadId),
        target: membership.home,
        body: { kind: "member-left", reason },
      });
    }
  });

  /** Whether the home's owner still reaches this thread through a share here (#20). */
  const homeStillShared = (threadId: ThreadId) => (membership: LinkStore.LinkRemoteMembership) =>
    membership.relation === "same_account"
      ? Effect.succeed(true)
      : orchestrator.getThreadRecords(threadId, []).pipe(
          Effect.map(
            ({ thread }) =>
              threadAccessFor(
                {
                  accountId: membership.homeAccountId,
                  organization: membership.homeOrganization,
                  shareIds: [],
                },
                thread,
              ) !== null,
          ),
          Effect.orElseSucceed(() => false),
        );

  /** Archiving or deleting a thread takes it out of its groups; settling does not. */
  const removeThread = Effect.fn("LinkService.removeThread")(function* (
    threadId: ThreadId,
    reason: "thread-archived" | "thread-deleted",
  ) {
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const groups = yield* listGroups;
        for (const group of groups.filter((candidate) =>
          candidate.members.some((member) => sameThread(member, local(threadId))),
        )) {
          yield* runCommand(
            {
              type: "link.member.remove",
              commandId: yield* newCommandId("thread-removed"),
              linkId: group.linkId,
              member: local(threadId),
              reason,
            },
            yield* listGroups,
          );
        }
      }),
    );
    yield* leaveRemoteGroups(threadId, reason, () => Effect.succeed(false));
  });

  const logged =
    (message: string, threadId: ThreadId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => Effect.logWarning(message, { threadId, cause })),
      );

  const afterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);
  yield* Stream.merge(
    eventSink.stream({ afterSequence, eventType: "thread.archived" }),
    eventSink.stream({ afterSequence, eventType: "thread.deleted" }),
  ).pipe(
    Stream.runForEach((stored) =>
      removeThread(
        stored.event.threadId,
        stored.event.type === "thread.deleted" ? "thread-deleted" : "thread-archived",
      ).pipe(logged("Failed to remove a thread from its link groups", stored.event.threadId)),
    ),
    Effect.forkScoped,
  );
  // Settling ends every share, so a colleague's group loses this thread (#20, #21).
  yield* Stream.merge(
    eventSink.stream({ afterSequence, eventType: "thread.settled" }),
    eventSink.stream({ afterSequence, eventType: "thread.shares-updated" }),
  ).pipe(
    Stream.runForEach((stored) =>
      leaveRemoteGroups(
        stored.event.threadId,
        "share-ended",
        homeStillShared(stored.event.threadId),
      ).pipe(logged("Failed to leave a link group whose share ended", stored.event.threadId)),
    ),
    Effect.forkScoped,
  );
  yield* eventSink.stream({ afterSequence, eventType: "run.updated" }).pipe(
    Stream.runForEach((stored) =>
      stored.event.type !== "run.updated"
        ? Effect.void
        : Effect.andThen(
            stored.event.payload.linkTask?.sender.remote !== undefined
              ? returnRemoteResult(stored.event.threadId, stored.event.payload.id)
              : Effect.void,
            isTerminalRun(stored.event.payload)
              ? recordActivity(stored.event.threadId, stored.event.payload.id)
              : Effect.void,
          ),
    ),
    Effect.forkScoped,
  );

  /** Marks remote tasks whose environment went away, and clears the mark when it is back. */
  const checkRemoteTasks = Effect.gen(function* () {
    const recent = yield* store
      .tasksSince((yield* nowMs) - OUTBOX_MAX_AGE_MS)
      .pipe(Effect.mapError(storeFailure));
    for (const row of recent) {
      if (!isLocal(row.requester) || isLocal(row.assignee)) continue;
      const task = yield* taskRecord(row);
      if (task === undefined || !isOpen(task)) continue;
      const presence = yield* relay.presence({ sender: row.requester, targets: [row.assignee] });
      if (presence === null) continue;
      const online = presence.peers[0]?.online === true;
      if (online && task.link?.remoteState !== "peer_offline") continue;
      if (!online && task.link?.remoteState === "peer_offline") continue;
      yield* orchestrator
        .applyRemoteLinkUpdate(row.requester.threadId, row.taskId, {
          type: "state",
          state: online ? "running" : "peer_offline",
        })
        .pipe(Effect.ignore);
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Failed to check remote link tasks", { cause })),
  );

  // Catch up on threads archived or deleted while the server was down, and on link tasks whose
  // run ended before its result was returned.
  yield* Effect.gen(function* () {
    for (const group of yield* listGroups) {
      for (const member of group.members) {
        if (!isLocal(member)) continue;
        const shell = yield* orchestrator
          .getThreadShell(member.threadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) {
          yield* removeThread(
            member.threadId,
            shell?.archivedAt != null ? "thread-archived" : "thread-deleted",
          );
        }
      }
    }
    const recent = yield* store
      .tasksSince((yield* nowMs) - OUTBOX_MAX_AGE_MS)
      .pipe(Effect.mapError(storeFailure));
    for (const row of recent) yield* delivery.result(row).pipe(Effect.ignore);
    yield* flushOutbox;
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Failed to reconcile link groups", { cause })),
    Effect.forkScoped,
  );
  yield* flushOutbox.pipe(
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.delay("1 minute"),
    Effect.forkScoped,
  );
  yield* checkRemoteTasks.pipe(
    Effect.repeat(Schedule.spaced("3 minutes")),
    Effect.delay("3 minutes"),
    Effect.forkScoped,
  );

  return LinkService.of({
    snapshot,
    subscribe: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(snapshot),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => snapshot)),
        );
      }),
    ),
    create,
    setMember,
    removeMember,
    pause: groupCommand("link.pause"),
    resume: groupCommand("link.resume"),
    end: groupCommand("link.end"),
    peers,
    activity,
    recordActivity,
    resolvePeer,
    assign,
    stopTask,
    stopTaskIfLinked,
    getChain,
    receive,
    returnRemoteResult,
    flushOutbox,
  });
});

export const layer = Layer.effect(LinkService, make);

export const userStopper = "the user";
export const agentStopper = (threadTitle: string) => `the agent in "${threadTitle}"`;
