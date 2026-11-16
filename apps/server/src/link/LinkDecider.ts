import {
  type CommandId,
  EventId,
  LINK_MAX_HOPS,
  LINK_MAX_MEMBERS,
  LINK_RATE_LIMIT,
  LinkChainId,
  LinkError,
  type LinkEvent,
  type LinkGroup,
  type LinkGroupId,
  type LinkMember,
  type LinkMemberRemovalReason,
  type LinkTaskRecord,
  type LinkThreadRef,
  type MessageId,
  type NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type ThreadId,
  type UnsequencedLinkEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

export type LinkCommand =
  | {
      readonly type: "link.create";
      readonly commandId: CommandId;
      readonly linkId: LinkGroupId;
      readonly name: string;
      readonly members: ReadonlyArray<LinkMember>;
    }
  | {
      readonly type: "link.member.set";
      readonly commandId: CommandId;
      readonly linkId: LinkGroupId;
      readonly member: LinkMember;
    }
  | {
      readonly type: "link.member.remove";
      readonly commandId: CommandId;
      readonly linkId: LinkGroupId;
      readonly member: LinkThreadRef;
      readonly reason: LinkMemberRemovalReason;
    }
  | {
      readonly type: "link.pause" | "link.resume" | "link.end";
      readonly commandId: CommandId;
      readonly linkId: LinkGroupId;
    };

const sameThread = (left: LinkThreadRef, right: LinkThreadRef) =>
  left.environmentId === right.environmentId && left.threadId === right.threadId;

const invalid = (message: string) => new LinkError({ code: "invalid_request", message });
const notFound = (linkId: LinkGroupId) =>
  new LinkError({ code: "not_found", message: `Link group ${linkId} does not exist.` });

/**
 * Decides the events for one user command on one group. The service runs commands for a group
 * one at a time, so checking the projection here is enough.
 */
export function decideLinkCommand(input: {
  readonly command: LinkCommand;
  readonly group: LinkGroup | undefined;
  readonly now: DateTime.Utc;
}): Result.Result<ReadonlyArray<UnsequencedLinkEvent>, LinkError> {
  const { command, group } = input;
  const occurredAt = DateTime.formatIso(input.now);
  let index = 0;
  const event = (
    type: UnsequencedLinkEvent["type"],
    payload: UnsequencedLinkEvent["payload"],
  ): UnsequencedLinkEvent =>
    ({
      eventId: EventId.make(`${command.commandId}:${index++}`),
      linkId: command.linkId,
      commandId: command.commandId,
      occurredAt,
      type,
      payload,
    }) as UnsequencedLinkEvent;

  if (command.type === "link.create") {
    if (group !== undefined) return Result.fail(invalid(`Link group ${command.linkId} exists.`));
    if (command.members.length < 2) return Result.fail(invalid("Link at least two threads."));
    if (command.members.length > LINK_MAX_MEMBERS) {
      return Result.fail(invalid(`A link group holds at most ${LINK_MAX_MEMBERS} threads.`));
    }
    const distinct = new Set(command.members.map((member) => member.threadId));
    if (distinct.size !== command.members.length) {
      return Result.fail(invalid("Each thread joins a group once."));
    }
    return Result.succeed([
      event("link.created", { name: command.name, members: [...command.members] }),
    ]);
  }
  if (group === undefined) return Result.fail(notFound(command.linkId));
  switch (command.type) {
    case "link.member.set": {
      const existing = group.members.some((member) => sameThread(member, command.member));
      if (!existing && group.members.length >= LINK_MAX_MEMBERS) {
        return Result.fail(invalid(`A link group holds at most ${LINK_MAX_MEMBERS} threads.`));
      }
      return Result.succeed([event("link.member-added", { member: command.member })]);
    }
    case "link.member.remove": {
      if (!group.members.some((member) => sameThread(member, command.member))) {
        return Result.fail(
          new LinkError({ code: "not_found", message: "That thread is not in the group." }),
        );
      }
      const removed = event("link.member-removed", { ...command.member, reason: command.reason });
      // A group of one has no one to assign to, so it ends with its last peer.
      return Result.succeed(
        group.members.length <= 2 ? [removed, event("link.ended", {})] : [removed],
      );
    }
    case "link.pause":
      return group.status === "paused"
        ? Result.succeed([])
        : Result.succeed([event("link.paused", {})]);
    case "link.resume":
      return group.status === "active"
        ? Result.succeed([])
        : Result.succeed([event("link.resumed", {})]);
    case "link.end":
      return Result.succeed([event("link.ended", {})]);
  }
}

/** Projects one event; `null` means the group is gone. */
export function applyLinkEvent(
  group: LinkGroup | undefined,
  event: UnsequencedLinkEvent | LinkEvent,
): LinkGroup | null {
  if (event.type === "link.created") {
    return {
      linkId: event.linkId,
      name: event.payload.name,
      status: "active",
      members: event.payload.members,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
    };
  }
  if (group === undefined) return null;
  const updatedAt = event.occurredAt;
  switch (event.type) {
    case "link.member-added": {
      const member = event.payload.member;
      const exists = group.members.some((candidate) => sameThread(candidate, member));
      return {
        ...group,
        members: exists
          ? group.members.map((candidate) => (sameThread(candidate, member) ? member : candidate))
          : [...group.members, member],
        updatedAt,
      };
    }
    case "link.member-removed":
      return {
        ...group,
        members: group.members.filter((candidate) => !sameThread(candidate, event.payload)),
        updatedAt,
      };
    case "link.paused":
      return { ...group, status: "paused", updatedAt };
    case "link.resumed":
      return { ...group, status: "active", updatedAt };
    case "link.ended":
      return null;
  }
}

/**
 * Agents copy this id into tool calls, so it is short and stable: it depends only on the peer's
 * thread (UUIDs, so the same in every group and environment), never on group order or size.
 */
export const linkPeerId = (threadId: ThreadId) => {
  // FNV-1a, 32 bits: eight hex digits, plenty for the few peers one thread has.
  let hash = 0x811c9dc5;
  for (let index = 0; index < threadId.length; index += 1) {
    hash ^= threadId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `p-${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

/** Where a caller stands in a chain when it assigns. */
export interface LinkCallerChain {
  readonly chainId: LinkChainId;
  /** Hops already taken to reach the caller; 0 for the thread that started the chain. */
  readonly hop: number;
  readonly parentTaskId: NodeId | null;
}

/**
 * A run handling a link task continues that task's chain. Any other run continues the chain of
 * the caller's latest link activity, unless a person spoke to it since: then it starts a new one.
 * So a requester woken with "stopped" cannot resend the same work, and a person can restart it.
 */
export function resolveCallerChain(input: {
  readonly threadId: ThreadId;
  readonly run: Pick<OrchestrationV2Run, "id" | "linkTask" | "userMessageId">;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "linkTask" | "requestedAt">>;
  readonly subagents: ReadonlyArray<Pick<OrchestrationV2Subagent, "link" | "startedAt">>;
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "id" | "role" | "createdBy" | "createdAt"> & {
      readonly scheduledTaskId?: unknown;
    }
  >;
}): LinkCallerChain {
  const handled = input.run.linkTask;
  if (handled !== undefined) {
    return { chainId: handled.chainId, hop: handled.hop, parentTaskId: handled.taskId };
  }
  type Candidate = { readonly at: DateTime.Utc; readonly chain: LinkCallerChain | MessageId };
  const candidates: Array<Candidate> = [
    ...input.messages.flatMap((message) =>
      message.role === "user" &&
      (message.createdBy === "user" || message.scheduledTaskId !== undefined)
        ? [{ at: message.createdAt, chain: message.id }]
        : [],
    ),
    ...input.runs.flatMap((run) =>
      run.linkTask === undefined
        ? []
        : [
            {
              at: run.requestedAt,
              chain: {
                chainId: run.linkTask.chainId,
                hop: run.linkTask.hop,
                parentTaskId: run.linkTask.taskId,
              },
            },
          ],
    ),
    ...input.subagents.flatMap((task) =>
      task.link === undefined || task.startedAt === null
        ? []
        : [
            {
              at: task.startedAt,
              chain: {
                chainId: task.link.chainId,
                hop: task.link.hop - 1,
                parentTaskId: task.link.parentTaskId,
              },
            },
          ],
    ),
  ];
  const latest = candidates.reduce<Candidate | undefined>(
    (best, candidate) =>
      best === undefined || DateTime.isGreaterThanOrEqualTo(candidate.at, best.at)
        ? candidate
        : best,
    undefined,
  );
  if (latest !== undefined && typeof latest.chain !== "string") return latest.chain;
  const root = typeof latest?.chain === "string" ? latest.chain : input.run.userMessageId;
  return {
    chainId: LinkChainId.make(`chain:${input.threadId}:${root}`),
    hop: 0,
    parentTaskId: null,
  };
}

/**
 * The runaway checks, in the order an agent can act on them. `waitingThreads` holds every thread
 * with unfinished work on this chain, as requester or assignee, plus the chain's root.
 */
export function decideLinkAssignment(input: {
  readonly group: Pick<LinkGroup, "linkId" | "name" | "status">;
  readonly caller: LinkThreadRef;
  readonly target: LinkThreadRef;
  readonly chain: LinkCallerChain;
  readonly chainStopped: boolean;
  readonly waitingThreads: ReadonlySet<ThreadId>;
  readonly recentGroupTasks: number;
}): Result.Result<LinkTaskRecord, LinkError> {
  const { group, chain } = input;
  if (input.chainStopped) {
    return Result.fail(
      new LinkError({
        code: "chain_stopped",
        message:
          "This work was stopped by a person. Do not reassign it; tell your user it was stopped.",
      }),
    );
  }
  if (group.status === "paused") {
    return Result.fail(
      new LinkError({
        code: "link_paused",
        message: `Link group "${group.name}" is paused and accepts no new tasks.`,
      }),
    );
  }
  const hop = chain.hop + 1;
  if (hop > LINK_MAX_HOPS) {
    return Result.fail(
      new LinkError({
        code: "hop_limit",
        message: `This chain already crossed ${chain.hop} threads; it may cross at most ${LINK_MAX_HOPS}. Do the work yourself or report back.`,
      }),
    );
  }
  if (sameThread(input.caller, input.target) || input.waitingThreads.has(input.target.threadId)) {
    return Result.fail(
      new LinkError({
        code: "cycle",
        message:
          "That thread is already waiting on this chain of work, so assigning to it would make a cycle.",
      }),
    );
  }
  if (input.recentGroupTasks >= LINK_RATE_LIMIT.tasks) {
    return Result.fail(
      new LinkError({
        code: "rate_limited",
        message: `Link group "${group.name}" took ${LINK_RATE_LIMIT.tasks} tasks in the last ${LINK_RATE_LIMIT.windowMs / 60_000} minutes. Wait, or ask your user.`,
      }),
    );
  }
  return Result.succeed({
    linkId: group.linkId,
    chainId: chain.chainId,
    hop,
    parentTaskId: chain.parentTaskId,
  });
}
