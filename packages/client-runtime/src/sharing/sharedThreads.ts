import type {
  EnvironmentId,
  OrchestrationV2ThreadProjection,
  RunId,
  ThreadId,
  ThreadShareRole,
} from "@t3tools/contracts";
import type { RelaySharedThread } from "@t3tools/contracts/relay";

export interface SharedThreadGroups {
  /** Shared with this account by name. */
  readonly sharedWithMe: ReadonlyArray<RelaySharedThread>;
  /** Shared with one of this account's projects, or with the whole organization. */
  readonly team: ReadonlyArray<RelaySharedThread>;
}

const byTitle = (left: RelaySharedThread, right: RelaySharedThread) =>
  left.title.localeCompare(right.title) || left.threadId.localeCompare(right.threadId);

/** Splits the relay's shared-thread list into the sidebar's "Shared with me" and "Team" groups. */
export function groupSharedThreads(threads: ReadonlyArray<RelaySharedThread>): SharedThreadGroups {
  const sharedWithMe: RelaySharedThread[] = [];
  const team: RelaySharedThread[] = [];
  for (const thread of threads) {
    (thread.targetKind === "account" ? sharedWithMe : team).push(thread);
  }
  return { sharedWithMe: sharedWithMe.sort(byTitle), team: team.sort(byTitle) };
}

/**
 * Drops threads the owner's environment already reported removed (`thread.removed` on its shell
 * stream), so they leave the list before the relay's next read confirms it. Keeps the array when
 * nothing was removed.
 */
export function withoutRemovedThreads(
  threads: ReadonlyArray<RelaySharedThread>,
  removedIn: (environmentId: EnvironmentId) => ReadonlyMap<ThreadId, number> | undefined,
): ReadonlyArray<RelaySharedThread> {
  const kept = threads.filter(
    (thread) => removedIn(thread.environmentId)?.has(thread.threadId) !== true,
  );
  return kept.length === threads.length ? threads : kept;
}

/** The relay's entry for a thread shared with the account; null when it is not shared with them. */
export function findSharedThread(
  threads: ReadonlyArray<RelaySharedThread>,
  environmentId: EnvironmentId,
  threadId: string,
): RelaySharedThread | null {
  return (
    threads.find(
      (thread) => thread.environmentId === environmentId && thread.threadId === threadId,
    ) ?? null
  );
}

/** The account's role in a thread, read from the relay's list; null when it is not shared with them. */
export function sharedThreadRole(
  threads: ReadonlyArray<RelaySharedThread>,
  environmentId: EnvironmentId,
  threadId: string,
): ThreadShareRole | null {
  return findSharedThread(threads, environmentId, threadId)?.role ?? null;
}

/**
 * What the UI may offer on a thread. A shared environment's server refuses everything but
 * reading its shared threads and, for collaborators, sending messages (ThreadAccessPolicy), so
 * the UI hides the rest instead of letting it fail.
 */
export interface ThreadCapabilities {
  readonly sendMessages: boolean;
  /** Interrupting, steering, resuming a held queue: run control stays the owner's. */
  readonly respondToRuntime: boolean;
  /** The agent's questions (user input requests). */
  readonly answerQuestions: boolean;
  /** Command, file and permission approvals: a collaborator's only when their share skips the owner. */
  readonly answerApprovals: boolean;
  readonly manageThread: boolean;
  readonly terminal: boolean;
  readonly files: boolean;
  readonly git: boolean;
  readonly settings: boolean;
  readonly projects: boolean;
  readonly share: boolean;
}

const OWNER_CAPABILITIES: ThreadCapabilities = Object.freeze({
  sendMessages: true,
  respondToRuntime: true,
  answerQuestions: true,
  answerApprovals: true,
  manageThread: true,
  terminal: true,
  files: true,
  git: true,
  settings: true,
  projects: true,
  share: true,
});

export function threadCapabilities(input: {
  readonly sharedEnvironment: boolean;
  /** The account's role in the thread; null when unknown, which grants only reading. */
  readonly role: ThreadShareRole | null;
  /** From the relay's list; absent (an older relay) means the owner approves. */
  readonly requireApproval?: boolean | undefined;
}): ThreadCapabilities {
  if (!input.sharedEnvironment) return OWNER_CAPABILITIES;
  const collaborator = input.role === "collaborator";
  return {
    sendMessages: collaborator,
    respondToRuntime: false,
    answerQuestions: collaborator,
    answerApprovals: collaborator && input.requireApproval === false,
    manageThread: false,
    terminal: false,
    files: false,
    git: false,
    settings: false,
    projects: false,
    share: false,
  };
}

/**
 * Runs started by the account's own messages: the ones a collaborator may stop, edit or retry in
 * someone else's thread (the environment checks the same through each message's author).
 */
export function runsStartedBy(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages"> | null | undefined,
  accountId: string | null,
): ReadonlySet<RunId> {
  if (!projection || accountId === null) return new Set();
  const ownMessageIds = new Set<string>(
    projection.messages
      .filter((message) => message.authorAccountId === accountId)
      .map((message) => message.id),
  );
  return new Set(
    projection.runs.filter((run) => ownMessageIds.has(run.userMessageId)).map((run) => run.id),
  );
}
