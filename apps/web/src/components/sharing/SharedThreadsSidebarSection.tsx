import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { UNKNOWN_COLLEAGUE_NAME } from "@t3tools/client-runtime/sharing/colleagues";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { RelaySharedThread } from "@t3tools/contracts/relay";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { sharedThreads } from "~/state/sharing";
import { useAtomCommand } from "~/state/use-atom-command";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { toastManager } from "../ui/toast";
import { ColleagueAvatar, useColleagueName, useOrganizationDirectory } from "./colleagues";

// The relay pushes share changes and the runtime polls as a fallback; this catches window focus.
const SHARED_THREADS_REFRESH_INTERVAL_MS = 10 * 60_000;

/**
 * "Shared with me" and "Team": threads colleagues shared with this account, from the relay. They
 * run on the owner's environment, which opening one connects to as a collaborator.
 */
export function SharedThreadsSidebarSection({
  routeThreadKey,
}: {
  /** `scopedThreadKey` of the open thread, to mark its row. */
  readonly routeThreadKey: string | null;
}) {
  const groups = useAtomValue(sharedThreads.groupsAtom);
  const refresh = useAtomCommand(sharedThreads.refresh, { reportFailure: false });
  const signedIn = useOrganizationDirectory() !== null;
  useLiveRefresh(signedIn ? () => void refresh() : null, {
    enabled: signedIn,
    key: "relay-shared-threads",
    intervalMs: SHARED_THREADS_REFRESH_INTERVAL_MS,
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- first read of the relay's shared-thread list; useLiveRefresh only refreshes after that
  useEffect(() => {
    if (signedIn) void refresh();
  }, [signedIn, refresh]);

  if (groups.sharedWithMe.length + groups.team.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-px">
      {groups.sharedWithMe.length > 0 ? (
        <SharedThreadGroup
          storageKey="sidebar:shared-with-me-expanded"
          label="Shared with me"
          threads={groups.sharedWithMe}
          routeThreadKey={routeThreadKey}
        />
      ) : null}
      {groups.team.length > 0 ? (
        <SharedThreadGroup
          storageKey="sidebar:team-expanded"
          label="Team"
          threads={groups.team}
          routeThreadKey={routeThreadKey}
        />
      ) : null}
    </div>
  );
}

function SharedThreadGroup({
  storageKey,
  label,
  threads,
  routeThreadKey,
}: {
  readonly storageKey: string;
  readonly label: string;
  readonly threads: ReadonlyArray<RelaySharedThread>;
  readonly routeThreadKey: string | null;
}) {
  const [expanded, setExpanded] = useLocalStorage(storageKey, true, Schema.Boolean);
  return (
    <section aria-label={label} className="flex flex-col gap-px">
      <div className="mx-0.5">
        <CollapsibleSectionHeader expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {label}
        </CollapsibleSectionHeader>
      </div>
      {expanded ? (
        <ul className="flex flex-col gap-px">
          {threads.map((thread) => (
            <SharedThreadRow
              key={`${thread.environmentId}:${thread.threadId}`}
              thread={thread}
              active={
                routeThreadKey ===
                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.threadId))
              }
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function SharedThreadRow({
  thread,
  active,
}: {
  readonly thread: RelaySharedThread;
  readonly active: boolean;
}) {
  const navigate = useNavigate();
  const ownerName = useColleagueName(thread.ownerSub);
  const open = useAtomCommand(sharedThreads.open, { reportFailure: false });
  const openThread = async () => {
    const result = await open({
      environmentId: thread.environmentId,
      label:
        ownerName === UNKNOWN_COLLEAGUE_NAME
          ? "A colleague's environment"
          : `${ownerName}'s environment`,
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not open the shared thread",
        description: error instanceof Error ? error.message : "Try again.",
      });
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: thread.environmentId, threadId: thread.threadId },
    });
  };
  return (
    <li className="list-none">
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => void openThread()}
        className={cn(
          "flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1 text-left text-sm text-sidebar-foreground hover:bg-sidebar-row-hover",
          active && "bg-sidebar-row-hover",
        )}
      >
        <ColleagueAvatar userId={thread.ownerSub} name={ownerName} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{thread.title || "Untitled thread"}</span>
          <span className="truncate text-2xs text-sidebar-muted-foreground">
            {ownerName}
            {thread.role === "viewer" ? " · view only" : null}
            {thread.online ? null : " · owner offline"}
          </span>
        </span>
      </button>
    </li>
  );
}
