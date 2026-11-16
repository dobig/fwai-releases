import type { EnvironmentId, ThreadId, ThreadShareRole } from "@t3tools/contracts";
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

/** The account's role in a thread, read from the relay's list; null when it is not shared with them. */
export function sharedThreadRole(
  threads: ReadonlyArray<RelaySharedThread>,
  environmentId: EnvironmentId,
  threadId: string,
): ThreadShareRole | null {
  return (
    threads.find((thread) => thread.environmentId === environmentId && thread.threadId === threadId)
      ?.role ?? null
  );
}

/**
 * What the UI may offer on a thread. A shared environment's server refuses everything but
 * reading its shared threads and, for collaborators, sending messages (ThreadAccessPolicy), so
 * the UI hides the rest instead of letting it fail.
 */
export interface ThreadCapabilities {
  readonly sendMessages: boolean;
  /** Approvals, user input answers, interrupting, steering: runtime responses are the owner's. */
  readonly respondToRuntime: boolean;
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
}): ThreadCapabilities {
  if (!input.sharedEnvironment) return OWNER_CAPABILITIES;
  return {
    sendMessages: input.role === "collaborator",
    respondToRuntime: false,
    manageThread: false,
    terminal: false,
    files: false,
    git: false,
    settings: false,
    projects: false,
    share: false,
  };
}
