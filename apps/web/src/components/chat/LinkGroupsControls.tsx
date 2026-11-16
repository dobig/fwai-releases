import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  activeLinkTask,
  linkGroupsForThread,
  linkTaskDisplayStatus,
  type LinkTaskDisplayStatus,
} from "@t3tools/client-runtime/state/link-groups";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  LINK_MAX_MEMBERS,
  type LinkGroup,
  type LinkMember,
  type LinkTaskRecord,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type RunId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Link2Icon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useQuietThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { sharedThreads } from "~/state/sharing";
import { environmentThreadDetails } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isLiveLinkRun, linkPeerThreadIds } from "./linkGroups.logic";
import { openLinkChainDialog, openLinkThreadsDialog } from "./linkGroupsDialogState";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { WorkLogRow } from "./WorkLog";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

function useLinkGroupsSnapshot(environmentId: EnvironmentId) {
  return useEnvironmentQuery(serverEnvironment.linkGroupsLive({ environmentId, input: {} })).data;
}

function useThreadTitle(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  /** What the group recorded for a member in another environment, which may not be connected. */
  fallback?: string,
): string {
  const shell = useQuietThreadShell(
    threadId === null ? null : scopeThreadRef(environmentId, threadId),
  );
  return shell?.title.trim() || fallback?.trim() || "Unknown thread";
}

const memberKey = (member: Pick<LinkMember, "environmentId" | "threadId">) =>
  `${member.environmentId}:${member.threadId}`;

const isSelf = (member: LinkMember, environmentId: EnvironmentId, threadId: ThreadId) =>
  member.environmentId === environmentId && member.threadId === threadId;

/** Where a member runs, for one in another environment: its owner, or "Another environment". */
function remoteMemberLabel(member: LinkMember, environmentId: EnvironmentId): string | null {
  if (member.environmentId === environmentId) return null;
  return member.owner === undefined ? "Another environment" : member.owner;
}

/** `environmentId` only for a member in another environment, as the link commands expect. */
const memberTarget = (member: LinkMember, environmentId: EnvironmentId) => ({
  threadId: member.threadId,
  ...(member.environmentId === environmentId ? {} : { environmentId: member.environmentId }),
});

/**
 * Opens a member's thread. A colleague's thread is opened through their share, which connects
 * to their environment; one of my own environments is already connected.
 */
function useOpenLinkMember() {
  const navigate = useNavigate();
  const openShared = useAtomCommand(sharedThreads.open, { reportFailure: false });
  return async (member: LinkMember) => {
    const shared = appAtomRegistry
      .get(sharedThreads.stateValueAtom)
      .threads.some(
        (thread) =>
          thread.environmentId === member.environmentId && thread.threadId === member.threadId,
      );
    if (shared) {
      const result = await openShared({
        environmentId: member.environmentId,
        label:
          member.owner === undefined
            ? "A colleague's environment"
            : `${member.owner}'s environment`,
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not open the linked thread",
          description: error instanceof Error ? error.message : "Try again.",
        });
        return;
      }
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(member.environmentId, member.threadId)),
    });
  };
}

/** Header chip for a thread in at least one link group; its menu opens the other members. */
export function LinkGroupsHeaderChip({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const openMember = useOpenLinkMember();
  const snapshot = useLinkGroupsSnapshot(threadRef.environmentId);
  const groups = linkGroupsForThread(snapshot, threadRef.threadId);
  if (groups.length === 0) return null;
  const peerCount = linkPeerThreadIds(snapshot, threadRef.threadId).length;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label={`Linked with ${peerCount} thread${peerCount === 1 ? "" : "s"}`}
          />
        }
      >
        <Link2Icon aria-hidden />
        <span className="@max-md:sr-only">Linked · </span>
        {peerCount}
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-60 max-w-(--available-width)">
        {groups.map((group) => (
          <MenuGroup key={group.linkId}>
            <MenuGroupLabel>
              {group.name}
              {group.status === "paused" ? " · Paused" : ""}
            </MenuGroupLabel>
            {group.members
              .filter((member) => !isSelf(member, threadRef.environmentId, threadRef.threadId))
              .map((member) => (
                <LinkMemberMenuItem
                  key={memberKey(member)}
                  member={member}
                  location={remoteMemberLabel(member, threadRef.environmentId)}
                  onOpen={() => void openMember(member)}
                />
              ))}
          </MenuGroup>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function LinkMemberMenuItem({
  member,
  location,
  onOpen,
}: {
  readonly member: LinkMember;
  readonly location: string | null;
  readonly onOpen: () => void;
}) {
  const title = useThreadTitle(member.environmentId, member.threadId, member.title);
  const detail = [location, member.purpose].filter((part) => part !== null && part !== "");
  return (
    <MenuItem onClick={onOpen}>
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{title}</span>
        {detail.length === 0 ? null : (
          <span className="truncate text-muted-foreground text-xs">{detail.join(" · ")}</span>
        )}
      </span>
    </MenuItem>
  );
}

interface PurposeEdit {
  readonly linkId: LinkGroup["linkId"];
  readonly member: { readonly threadId: ThreadId; readonly environmentId?: EnvironmentId };
  readonly title: string;
  readonly purpose: string;
}

/** The thread's link groups in its details panel, with every way to change or leave them. */
export function ThreadLinkGroupsSection({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const snapshot = useLinkGroupsSnapshot(environmentId);
  const canCreate = useAtomValue(serverEnvironment.createLinkGroup.permissionAtom(environmentId));
  const canEdit = useAtomValue(serverEnvironment.setLinkMember.permissionAtom(environmentId));
  const setLinkMember = useAtomCommand(serverEnvironment.setLinkMember, "set link purpose");
  const removeLinkMember = useAtomCommand(serverEnvironment.removeLinkMember, "remove link member");
  const pauseLinkGroup = useAtomCommand(serverEnvironment.pauseLinkGroup, "pause link group");
  const resumeLinkGroup = useAtomCommand(serverEnvironment.resumeLinkGroup, "resume link group");
  const endLinkGroup = useAtomCommand(serverEnvironment.endLinkGroup, "dissolve link group");
  const openMember = useOpenLinkMember();
  const [busyLinkId, setBusyLinkId] = useState<string | null>(null);
  const [editing, setEditing] = useState<PurposeEdit | null>(null);
  const groups = linkGroupsForThread(snapshot, threadId);
  if (groups.length === 0) return null;

  const run = async (linkId: string, action: () => Promise<unknown>) => {
    if (busyLinkId !== null) return;
    setBusyLinkId(linkId);
    await action();
    setBusyLinkId(null);
  };
  const dissolve = async (group: LinkGroup) => {
    const api = readLocalApi();
    if (!api) return;
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(
        [
          `Dissolve "${group.name}"?`,
          "Its agents can no longer assign each other tasks. Past tasks keep their history.",
        ].join("\n"),
        { variant: "destructive" },
      ),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;
    await run(group.linkId, () => endLinkGroup({ environmentId, input: { linkId: group.linkId } }));
  };
  const savePurpose = async (edit: PurposeEdit, purpose: string) => {
    setEditing(null);
    await run(edit.linkId, () =>
      setLinkMember({
        environmentId,
        input: { linkId: edit.linkId, ...edit.member, purpose: purpose.trim() },
      }),
    );
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-links-heading"
      title="Linked"
      data-thread-link-groups-panel
      actions={
        canCreate ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  aria-label="Link with…"
                  onClick={() => openLinkThreadsDialog(scopeThreadRef(environmentId, threadId))}
                />
              }
            >
              <PlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup>Link with…</TooltipPopup>
          </Tooltip>
        ) : null
      }
    >
      {groups.map((group) => {
        const self = group.members.find((member) => isSelf(member, environmentId, threadId));
        const busy = busyLinkId === group.linkId;
        return (
          <div key={group.linkId}>
            <div className="flex h-8 min-w-0 items-center gap-2.5 px-2.5">
              <Link2Icon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
                {group.name}
              </span>
              {group.status === "paused" ? <Badge variant="warning">Paused</Badge> : null}
              {canEdit ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <ThreadDetailsControl
                        size="icon-xs"
                        variant="ghost"
                        part="icon"
                        aria-label={`Manage ${group.name}`}
                        disabled={busy}
                      />
                    }
                  >
                    <MoreHorizontalIcon className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    {self ? (
                      <MenuItem
                        onClick={() =>
                          setEditing({
                            linkId: group.linkId,
                            member: { threadId },
                            title: "this thread",
                            purpose: self.purpose,
                          })
                        }
                      >
                        Edit this thread's purpose
                      </MenuItem>
                    ) : null}
                    {canCreate && group.members.length < LINK_MAX_MEMBERS ? (
                      <MenuItem
                        onClick={() =>
                          openLinkThreadsDialog(scopeThreadRef(environmentId, threadId), {
                            linkId: group.linkId,
                          })
                        }
                      >
                        Add threads…
                      </MenuItem>
                    ) : null}
                    {group.status === "active" ? (
                      <MenuItem
                        onClick={() =>
                          void run(group.linkId, () =>
                            pauseLinkGroup({ environmentId, input: { linkId: group.linkId } }),
                          )
                        }
                      >
                        Pause group
                      </MenuItem>
                    ) : (
                      <MenuItem
                        onClick={() =>
                          void run(group.linkId, () =>
                            resumeLinkGroup({ environmentId, input: { linkId: group.linkId } }),
                          )
                        }
                      >
                        Resume group
                      </MenuItem>
                    )}
                    <MenuItem
                      onClick={() =>
                        void run(group.linkId, () =>
                          removeLinkMember({
                            environmentId,
                            input: { linkId: group.linkId, threadId },
                          }),
                        )
                      }
                    >
                      Leave group
                    </MenuItem>
                    <MenuItem variant="destructive" onClick={() => void dissolve(group)}>
                      Dissolve group
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              ) : null}
            </div>
            <ul aria-label={`Members of ${group.name}`} className="m-0 list-none p-0">
              {group.members
                .filter((member) => !isSelf(member, environmentId, threadId))
                .map((member) => (
                  <LinkPeerRow
                    key={memberKey(member)}
                    member={member}
                    location={remoteMemberLabel(member, environmentId)}
                    canEdit={canEdit}
                    disabled={busy}
                    onOpen={() => void openMember(member)}
                    onEditPurpose={(title) =>
                      setEditing({
                        linkId: group.linkId,
                        member: memberTarget(member, environmentId),
                        title,
                        purpose: member.purpose,
                      })
                    }
                    onRemove={() =>
                      void run(group.linkId, () =>
                        removeLinkMember({
                          environmentId,
                          input: { linkId: group.linkId, ...memberTarget(member, environmentId) },
                        }),
                      )
                    }
                  />
                ))}
            </ul>
          </div>
        );
      })}
      {editing === null ? null : (
        <LinkPurposeDialog
          edit={editing}
          onCancel={() => setEditing(null)}
          onSave={(purpose) => void savePurpose(editing, purpose)}
        />
      )}
    </ThreadDetailsSection>
  );
}

function LinkPeerRow({
  member,
  location,
  canEdit,
  disabled,
  onOpen,
  onEditPurpose,
  onRemove,
}: {
  readonly member: LinkMember;
  readonly location: string | null;
  readonly canEdit: boolean;
  readonly disabled: boolean;
  readonly onOpen: () => void;
  readonly onEditPurpose: (title: string) => void;
  readonly onRemove: () => void;
}) {
  const title = useThreadTitle(member.environmentId, member.threadId, member.title);
  const detail = [location, member.purpose].filter((part) => part !== null && part !== "");
  return (
    <li className="flex min-w-0 items-center gap-1 rounded-lg">
      <ThreadDetailsControl
        size="sm"
        variant="ghost"
        part="row"
        multiline
        aria-label={`Open ${title}`}
        className="min-w-0 flex-1"
        onClick={onOpen}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground/85">{title}</span>
          {detail.length === 0 ? null : (
            <span className="truncate text-2xs font-normal text-muted-foreground">
              {detail.join(" · ")}
            </span>
          )}
        </span>
      </ThreadDetailsControl>
      {canEdit ? (
        <Menu>
          <MenuTrigger
            render={
              <ThreadDetailsControl
                size="icon-xs"
                variant="ghost"
                part="icon"
                aria-label={`Manage ${title}`}
                disabled={disabled}
              />
            }
          >
            <MoreHorizontalIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => onEditPurpose(title)}>Edit purpose</MenuItem>
            <MenuItem variant="destructive" onClick={onRemove}>
              Remove from group
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
    </li>
  );
}

function LinkPurposeDialog({
  edit,
  onCancel,
  onSave,
}: {
  readonly edit: PurposeEdit;
  readonly onCancel: () => void;
  readonly onSave: (purpose: string) => void;
}) {
  const [purpose, setPurpose] = useState(edit.purpose);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Purpose of {edit.title}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <Input
            aria-label="Purpose"
            autoFocus
            value={purpose}
            maxLength={300}
            placeholder="What this thread works on"
            onChange={(event) => setPurpose(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSave(purpose);
            }}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => onSave(purpose)}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const LINK_TASK_STATUS_LABEL: Record<LinkTaskDisplayStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

/** A task this thread assigned to a linked thread, in place of the subagent card. */
export function LinkTaskSentRow({
  agent,
  environmentId,
  detail,
  onOpenThread,
}: {
  readonly agent: OrchestrationV2Subagent & { readonly link: LinkTaskRecord };
  readonly environmentId: EnvironmentId;
  /** The peer's reply, flattened to one line. */
  readonly detail: string | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const peerThreadId = agent.assignee?.threadId ?? agent.childThreadId;
  const title = useThreadTitle(agent.assignee?.environmentId ?? environmentId, peerThreadId);
  const canStop = useAtomValue(serverEnvironment.stopLinkTask.permissionAtom(environmentId));
  const stopLinkTask = useAtomCommand(serverEnvironment.stopLinkTask, "stop linked task");
  const [stopping, setStopping] = useState(false);
  const status = linkTaskDisplayStatus(agent);
  const live = status === "queued" || status === "running";

  const stop = async () => {
    setStopping(true);
    await stopLinkTask({ environmentId, input: { threadId: agent.threadId, taskId: agent.id } });
    setStopping(false);
  };

  return (
    <WorkLogRow
      data-v2-item-type="subagent"
      data-link-task="sent"
      icon={<Link2Icon aria-hidden className="size-3.5 text-muted-foreground" />}
      label={
        <>
          Task for {title}
          <span className="text-muted-foreground"> · {LINK_TASK_STATUS_LABEL[status]}</span>
        </>
      }
      trailing={
        <LinkTaskActions
          onOpen={peerThreadId === null ? null : () => onOpenThread(peerThreadId)}
          onViewChain={() => openLinkChainDialog({ environmentId, chainId: agent.link.chainId })}
          onStop={live && canStop ? () => void stop() : null}
          stopping={stopping}
        />
      }
    >
      {detail === null ? null : (
        <p
          className={cn(
            "ms-7 truncate text-2xs leading-relaxed",
            status === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {detail}
        </p>
      )}
    </WorkLogRow>
  );
}

function LinkTaskActions(props: {
  readonly onOpen: (() => void) | null;
  readonly onViewChain: () => void;
  readonly onStop: (() => void) | null;
  readonly stopping: boolean;
}) {
  return (
    <span className="flex shrink-0 items-center gap-2 text-xs">
      {props.onOpen === null ? null : (
        <InlineButton tone="muted" onClick={props.onOpen}>
          Open thread
        </InlineButton>
      )}
      <InlineButton tone="muted" onClick={props.onViewChain}>
        View chain
      </InlineButton>
      {props.onStop === null ? null : (
        <InlineButton tone="destructive" disabled={props.stopping} onClick={props.onStop}>
          Stop
        </InlineButton>
      )}
    </span>
  );
}

/** Above the message that brought a linked thread's task: who sent it, with the way to stop it. */
export function LinkTaskReceivedRow({
  threadRef,
  runId,
  onOpenThread,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly runId: RunId;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const run = useAtomValue(
    environmentThreadDetails.quietThreadAtom(threadRef),
    (thread): OrchestrationV2Run | null =>
      thread?.projection.runs.find((candidate) => candidate.id === runId) ?? null,
  );
  const canStop = useAtomValue(
    serverEnvironment.stopLinkTask.permissionAtom(threadRef.environmentId),
  );
  const stopLinkTask = useAtomCommand(serverEnvironment.stopLinkTask, "stop linked task");
  const [stopping, setStopping] = useState(false);
  const linkTask = run?.linkTask;
  if (run === null || linkTask === undefined) return null;
  const { requester, sender } = linkTask;

  const stop = async () => {
    setStopping(true);
    await stopLinkTask({
      environmentId: requester.environmentId,
      input: { threadId: requester.threadId, taskId: linkTask.taskId },
    });
    setStopping(false);
  };

  return (
    <div className="flex w-full max-w-[80%] justify-end" data-link-task="received">
      <WorkLogRow
        icon={<Link2Icon aria-hidden className="size-3.5 text-muted-foreground" />}
        label={
          <>
            Task from {sender.threadTitle}
            <span className="text-muted-foreground"> ({sender.projectTitle})</span>
          </>
        }
        trailing={
          <LinkTaskActions
            onOpen={() => onOpenThread(requester.threadId)}
            onViewChain={() =>
              openLinkChainDialog({
                environmentId: threadRef.environmentId,
                chainId: linkTask.chainId,
              })
            }
            onStop={isLiveLinkRun(run.status) && canStop ? () => void stop() : null}
            stopping={stopping}
          />
        }
      />
    </div>
  );
}

/**
 * Stops the link task the thread's live turn is handling, so its requester hears "stopped by the
 * user" and the tasks derived from it stop too. Resolves false when there was none or it failed,
 * and the caller interrupts the turn itself.
 */
export function useStopActiveLinkTask() {
  const stopLinkTask = useAtomCommand(serverEnvironment.stopLinkTask, {
    label: "stop linked task",
    reportFailure: false,
  });
  return async (
    environmentId: EnvironmentId,
    runs: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "linkTask">>,
  ): Promise<boolean> => {
    const task = activeLinkTask(runs);
    if (task === null) return false;
    const result = await stopLinkTask({
      environmentId,
      input: { threadId: task.requesterThreadId, taskId: task.taskId },
    });
    return result._tag === "Success";
  };
}
