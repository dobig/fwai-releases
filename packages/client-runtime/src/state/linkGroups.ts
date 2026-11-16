import type {
  LinkGroup,
  LinkGroupsSnapshot,
  LinkMember,
  NodeId,
  OrchestrationV2Run,
  OrchestrationV2Subagent,
  ThreadId,
} from "@t3tools/contracts";

/** Groups that hold the thread, in creation order. */
export function linkGroupsForThread(
  snapshot: LinkGroupsSnapshot | null | undefined,
  threadId: ThreadId,
): ReadonlyArray<LinkGroup> {
  if (snapshot == null) return [];
  return snapshot.groups
    .filter((group) =>
      group.members.some(
        (member) => member.environmentId === snapshot.environmentId && member.threadId === threadId,
      ),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export interface LinkPeerRow {
  readonly group: LinkGroup;
  readonly member: LinkMember;
}

/** Every other member of the thread's groups; a thread in two groups with the same peer lists it twice. */
export function linkPeersForThread(
  snapshot: LinkGroupsSnapshot | null | undefined,
  threadId: ThreadId,
): ReadonlyArray<LinkPeerRow> {
  return linkGroupsForThread(snapshot, threadId).flatMap((group) =>
    group.members
      .filter((member) => member.threadId !== threadId)
      .map((member) => ({ group, member })),
  );
}

export const isLinkTask = (
  task: Pick<OrchestrationV2Subagent, "link">,
): task is Pick<OrchestrationV2Subagent, "link"> & {
  readonly link: NonNullable<OrchestrationV2Subagent["link"]>;
} => task.link !== undefined;

export type LinkTaskDisplayStatus = "queued" | "running" | "completed" | "failed" | "stopped";

/** One label for a link task, from the requester's record. */
export function linkTaskDisplayStatus(
  task: Pick<OrchestrationV2Subagent, "status" | "result" | "link">,
): LinkTaskDisplayStatus {
  if (task.link?.stoppedBy !== undefined) return "stopped";
  switch (task.status) {
    case "idle":
    case "pending":
      return "queued";
    case "running":
    case "waiting":
      return "running";
    case "completed":
      return "completed";
    case "cancelled":
    case "interrupted":
      return "stopped";
    case "failed":
      return "failed";
  }
}

/** The run's task, when a thread's live turn is handling one assigned by a linked thread. */
export function activeLinkTask(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "linkTask">>,
): { readonly requesterThreadId: ThreadId; readonly taskId: NodeId } | null {
  const run = runs.findLast(
    (candidate) =>
      candidate.linkTask !== undefined &&
      (candidate.status === "starting" ||
        candidate.status === "running" ||
        candidate.status === "waiting" ||
        candidate.status === "preparing"),
  );
  return run?.linkTask === undefined
    ? null
    : { requesterThreadId: run.linkTask.requester.threadId, taskId: run.linkTask.taskId };
}
