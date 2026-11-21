import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  LINK_MAX_MEMBERS,
  type LinkChainTask,
  type LinkGroupId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon, SquareIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useProjects, useQuietThreadProjection, useQuietThreadShells } from "~/state/entities";
import { useRelayEnvironmentDiscovery } from "~/state/environments";
import { relayEnvironmentDiscovery } from "~/state/relay";
import { sharedThreads } from "~/state/sharing";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { ExpandableText } from "../settings/ExpandableText";
import { Colleague, useOrganizationDirectory } from "../sharing/colleagues";
import {
  type AccountEnvironment,
  defaultLinkGroupName,
  defaultLinkPurpose,
  defaultOwnLinkPurpose,
  flattenLinkChain,
  isLiveLinkChainTask,
  type LinkCandidate,
  type LinkCommandInput,
  linkCandidateKey,
  linkCandidates,
  linkConfirmPlan,
  type LinkGroupChoice,
  linkGroupChoices,
  LINK_NAME_MAX_LENGTH,
  LINK_PURPOSE_MAX_LENGTH,
} from "@t3tools/client-runtime/link-groups";
import {
  type LinkChainDialogTarget,
  linkChainDialogAtom,
  type LinkGroupChoiceDialogTarget,
  linkGroupChoiceDialogAtom,
  linkThreadsDialogAtom,
} from "./linkGroupsDialogState";
import { useLinkThreadsSubmit, useRunLinkCommand } from "./useLinkThreadsSubmit";

export function LinkGroupsDialogHost() {
  const target = useAtomValue(linkThreadsDialogAtom);
  const choice = useAtomValue(linkGroupChoiceDialogAtom);
  const chain = useAtomValue(linkChainDialogAtom);
  return (
    <>
      {choice === null ? null : (
        <LinkGroupChoiceDialog
          key={`${choice.threadRef.environmentId}:${choice.threadRef.threadId}:${linkCandidateKey(choice.candidate.ref)}`}
          target={choice}
          onClose={() => appAtomRegistry.set(linkGroupChoiceDialogAtom, null)}
        />
      )}
      {target === null ? null : (
        <LinkThreadsDialog
          key={`${target.threadRef.environmentId}:${target.threadRef.threadId}:${target.linkId}`}
          threadRef={target.threadRef}
          initialLinkId={target.linkId}
          preselect={target.preselect}
          command={target.command}
          onClose={() => appAtomRegistry.set(linkThreadsDialogAtom, null)}
        />
      )}
      {chain === null ? null : (
        <LinkChainDialog
          key={`${chain.environmentId}:${chain.chainId}`}
          target={chain}
          onClose={() => appAtomRegistry.set(linkChainDialogAtom, null)}
        />
      )}
    </>
  );
}

type Selection = ReadonlyMap<
  string,
  { readonly candidate: LinkCandidate; readonly purpose: string | null }
>;

const NEW_GROUP = "new";

export function useAccountEnvironments(): ReadonlyMap<string, AccountEnvironment> {
  const discovered = useRelayEnvironmentDiscovery().environments;
  const environments = new Map<string, AccountEnvironment>();
  for (const [environmentId, entry] of discovered) {
    environments.set(environmentId, {
      label: entry.environment.label,
      online: entry.availability === "online",
    });
  }
  return environments;
}

/** `/link` when the two threads' groups are several: the person picks one, or a new group. */
function LinkGroupChoiceDialog({
  target,
  onClose,
}: {
  readonly target: LinkGroupChoiceDialogTarget;
  readonly onClose: () => void;
}) {
  const { threadRef, candidate, command } = target;
  const shells = useQuietThreadShells();
  const projects = useProjects();
  const projection = useQuietThreadProjection(threadRef)?.projection ?? null;
  const snapshot = useEnvironmentQuery(
    serverEnvironment.linkGroupsLive({ environmentId: threadRef.environmentId, input: {} }),
  ).data;
  const directory = useOrganizationDirectory();
  const runLinkCommand = useRunLinkCommand();
  const [choice, setChoice] = useState<LinkGroupChoice | null>(null);
  const [running, setRunning] = useState(false);

  const groups = snapshot?.groups ?? [];
  const titleOf = (environmentId: string, threadId: string, fallback?: string) =>
    shells
      .find((thread) => thread.environmentId === environmentId && thread.id === threadId)
      ?.title.trim() ||
    fallback?.trim() ||
    "Unknown thread";
  const current = titleOf(threadRef.environmentId, threadRef.threadId);
  const choices = linkGroupChoices({
    groups,
    current: threadRef,
    candidate: candidate.ref,
    setsPurpose: command.purpose !== null || command.ownPurpose !== null,
    memberTitle: (member) => titleOf(member.environmentId, member.threadId, member.title),
  });

  const confirm = async () => {
    if (choice === null || running) return;
    setRunning(true);
    const done = await runLinkCommand(threadRef, {
      candidate,
      currentTitle: current,
      currentPurpose: defaultOwnLinkPurpose(
        shells.find(
          (thread) =>
            thread.environmentId === threadRef.environmentId && thread.id === threadRef.threadId,
        ),
        projects,
      ),
      currentShares: projection?.thread.shares ?? [],
      groups,
      ownerName: (ownerSub) => directory?.usernames.get(ownerSub) ?? null,
      command,
      choice,
    });
    setRunning(false);
    if (done) onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !running) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Link {candidate.title} with…</DialogTitle>
          <DialogDescription>
            {current} and {candidate.title} belong to several groups.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <RadioGroup
            aria-label="Group"
            value={choice}
            onValueChange={(value) => setChoice(value as LinkGroupChoice)}
          >
            {choices.map((group) => (
              <label
                key={group.linkId}
                className="flex cursor-pointer items-start gap-2 text-sm has-data-disabled:cursor-not-allowed has-data-disabled:opacity-64"
              >
                <Radio value={group.linkId} disabled={group.unavailable !== null} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{group.name}</span>
                  <span className="truncate text-muted-foreground text-xs">
                    {group.unavailable === "member"
                      ? "Already linked"
                      : group.unavailable === "full"
                        ? "Full"
                        : `With ${group.memberTitles.join(", ") || "no other threads"}`}
                  </span>
                </span>
              </label>
            ))}
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <Radio value={NEW_GROUP} />
              <span className="font-medium">New group</span>
            </label>
          </RadioGroup>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={running}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void confirm()} disabled={choice === null || running}>
            {running ? "Linking..." : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function LinkThreadsDialog({
  threadRef,
  initialLinkId,
  preselect,
  command,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly initialLinkId: LinkGroupId | null;
  /** Checked when the picker opens, e.g. by `/link` on a colleague's thread. */
  readonly preselect: LinkCandidate | null;
  readonly command: LinkCommandInput;
  readonly onClose: () => void;
}) {
  const shells = useQuietThreadShells();
  const projects = useProjects();
  const projection = useQuietThreadProjection(threadRef)?.projection ?? null;
  const snapshot = useEnvironmentQuery(
    serverEnvironment.linkGroupsLive({ environmentId: threadRef.environmentId, input: {} }),
  ).data;
  const accountEnvironments = useAccountEnvironments();
  const shared = useAtomValue(sharedThreads.stateValueAtom).threads;
  const directory = useOrganizationDirectory();
  const canCreate = useAtomValue(
    serverEnvironment.createLinkGroup.permissionAtom(threadRef.environmentId),
  );
  const canAddMember = useAtomValue(
    serverEnvironment.setLinkMember.permissionAtom(threadRef.environmentId),
  );
  const canShare = useAtomValue(
    serverEnvironment.grantThreadShare.permissionAtom(threadRef.environmentId),
  );
  const submitLink = useLinkThreadsSubmit();
  const refreshShared = useAtomCommand(sharedThreads.refresh, { reportFailure: false });
  const refreshEnvironments = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- remote candidates come from the relay; read them fresh when the picker opens
  useEffect(() => {
    void refreshShared();
    void refreshEnvironments();
  }, [refreshShared, refreshEnvironments]);

  const current = shells.find(
    (thread) =>
      thread.environmentId === threadRef.environmentId && thread.id === threadRef.threadId,
  );
  const currentRef = { environmentId: threadRef.environmentId, threadId: threadRef.threadId };
  const currentKey = linkCandidateKey(currentRef);
  const [groupChoice, setGroupChoice] = useState<string>(initialLinkId ?? NEW_GROUP);
  // Purpose null: not edited, so a member keeps its own and a new one gets the default.
  const [selected, setSelected] = useState<Selection>(() =>
    preselect === null
      ? new Map()
      : new Map([
          [linkCandidateKey(preselect.ref), { candidate: preselect, purpose: command.purpose }],
        ]),
  );
  const allGroups = snapshot?.groups ?? [];
  const targetGroup = allGroups.find((group) => group.linkId === groupChoice) ?? null;
  const memberPurposes = new Map(
    (targetGroup?.members ?? []).map((member) => [linkCandidateKey(member), member.purpose]),
  );
  // The current thread's groups, and those of the threads picked, so it can join theirs too.
  const groups = allGroups
    .filter(
      (group) =>
        group.linkId === groupChoice ||
        group.members.some(
          (member) =>
            linkCandidateKey(member) === currentKey || selected.has(linkCandidateKey(member)),
        ),
    )
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  const joining = targetGroup !== null && !memberPurposes.has(currentKey);
  const candidates = linkCandidates({
    current: currentRef,
    shells,
    accountEnvironments,
    sharedThreads: shared,
    projects,
    ...(targetGroup === null
      ? {}
      : {
          exclude: targetGroup.members.filter((member) => !selected.has(linkCandidateKey(member))),
        }),
  });
  const [name, setName] = useState<string | null>(command.groupName);
  const [editedOwnPurpose, setOwnPurpose] = useState<string | null>(command.ownPurpose);
  const ownPurpose =
    editedOwnPurpose ?? memberPurposes.get(currentKey) ?? defaultOwnLinkPurpose(current, projects);
  const editsOwnPurpose = targetGroup === null || joining || editedOwnPurpose !== null;
  const [requireApproval, setRequireApproval] = useState(true);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultName = defaultLinkGroupName(current?.title);
  const groupName = name ?? defaultName;
  const normalizedQuery = query.trim().toLowerCase();
  const visible = candidates.filter(
    (candidate) =>
      selected.has(linkCandidateKey(candidate.ref)) ||
      normalizedQuery === "" ||
      candidate.title.toLowerCase().includes(normalizedQuery),
  );
  const purposeOf = (candidate: LinkCandidate, purpose: string | null) =>
    purpose ?? memberPurposes.get(linkCandidateKey(candidate.ref)) ?? defaultLinkPurpose(candidate);
  const adding = [...selected.keys()].filter((key) => !memberPurposes.has(key)).length;
  const capacity = LINK_MAX_MEMBERS - (targetGroup?.members.length ?? 1) - (joining ? 1 : 0);
  const full = adding >= capacity;
  const ownerName = (ownerSub: string) => directory?.usernames.get(ownerSub) ?? null;
  const confirmPlan = linkConfirmPlan({
    current: currentRef,
    currentShares: projection?.thread.shares ?? [],
    selected: [...selected.values()].map(({ candidate, purpose }) => ({
      candidate,
      purpose: purposeOf(candidate, purpose),
    })),
    requireApproval,
    ownerName,
  });
  // A member left as it was is only selected for its share back; setting it again changes nothing.
  const unchanged = new Set(
    [...selected]
      .filter(([key, entry]) => entry.purpose === null && memberPurposes.has(key))
      .map(([key]) => key),
  );
  const plan = {
    grants: confirmPlan.grants,
    members: [
      ...(targetGroup !== null && editsOwnPurpose
        ? [{ threadId: threadRef.threadId, purpose: ownPurpose }]
        : []),
      ...confirmPlan.members.filter(
        (member) =>
          !unchanged.has(
            linkCandidateKey({
              environmentId: member.environmentId ?? threadRef.environmentId,
              threadId: member.threadId,
            }),
          ),
      ),
    ],
  };
  const needsShare = plan.grants.length > 0;
  const allowed = targetGroup === null ? canCreate : canAddMember;
  const action = targetGroup === null ? "link" : adding > 0 ? "add" : joining ? "join" : "save";
  const canSubmit =
    allowed &&
    (!needsShare || canShare) &&
    !creating &&
    adding <= capacity &&
    (targetGroup === null
      ? selected.size > 0 && groupName.trim() !== ""
      : plan.members.length > 0 || needsShare);

  const toggle = (candidate: LinkCandidate, checked: boolean) => {
    setSelected((previous) => {
      const next = new Map(previous);
      const key = linkCandidateKey(candidate.ref);
      if (checked) next.set(key, { candidate, purpose: null });
      else next.delete(key);
      return next;
    });
  };
  const setPurpose = (candidate: LinkCandidate, purpose: string) => {
    setSelected((previous) =>
      new Map(previous).set(linkCandidateKey(candidate.ref), { candidate, purpose }),
    );
  };

  const confirm = async () => {
    if (!canSubmit) return;
    setCreating(true);
    setError(null);
    // The person confirmed sharing back; a colleague's tasks to this thread need it.
    const result = await submitLink(threadRef, {
      plan,
      linkId: targetGroup?.linkId ?? null,
      name: groupName,
      ownPurpose,
    });
    setCreating(false);
    if (result._tag === "Interrupted") return;
    if (result._tag === "Failure") {
      setError(result.message);
      return;
    }
    toastManager.add({
      type: "success",
      title: {
        link: "Threads linked",
        add: "Threads added",
        join: "Added this thread",
        save: "Purpose updated",
      }[action],
      description: targetGroup?.name ?? groupName,
    });
    onClose();
  };

  const sharedNames = [...new Set(plan.grants.map((grant) => grant.target.label))].join(", ");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !creating) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Link with…</DialogTitle>
          <DialogDescription>
            Agents in linked threads hand each other tasks. Say what each thread owns, so its peers
            know what to send it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {groups.length === 0 ? null : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="link-group-choice">Group</Label>
              <Select
                value={groupChoice}
                onValueChange={(value) => {
                  if (value === null) return;
                  setGroupChoice(value);
                  setSelected(new Map());
                }}
              >
                <SelectTrigger id="link-group-choice" size="sm">
                  <SelectValue>{targetGroup?.name ?? "New group"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={NEW_GROUP}>New group</SelectItem>
                  {groups.map((group) => (
                    <SelectItem key={group.linkId} value={group.linkId}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          )}
          {targetGroup !== null ? null : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="link-group-name">Group name</Label>
              <Input
                id="link-group-name"
                value={groupName}
                maxLength={LINK_NAME_MAX_LENGTH}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          )}
          {editsOwnPurpose ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="link-own-purpose">
                What does {current?.title.trim() || "this thread"} own?
              </Label>
              <Input
                id="link-own-purpose"
                value={ownPurpose}
                placeholder="The repo, area or job it owns"
                maxLength={LINK_PURPOSE_MAX_LENGTH}
                onChange={(event) => setOwnPurpose(event.target.value)}
              />
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="link-thread-search">
              Threads to link ({adding}/{Math.max(capacity, 0)})
            </Label>
            <Input
              id="link-thread-search"
              type="search"
              value={query}
              placeholder="Search threads"
              onChange={(event) => setQuery(event.target.value)}
            />
            {visible.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {candidates.length === 0 ? "There are no threads to link." : "No threads match."}
              </p>
            ) : (
              <ul className="m-0 flex max-h-72 list-none flex-col overflow-y-auto rounded-lg border p-0">
                {visible.map((candidate) => {
                  const key = linkCandidateKey(candidate.ref);
                  const entry = selected.get(key);
                  const checked = entry !== undefined;
                  return (
                    <li key={key} className="flex flex-col gap-1.5 px-2.5 py-1.5 not-last:border-b">
                      <label className="flex cursor-pointer items-center gap-2 text-sm has-disabled:cursor-not-allowed has-disabled:opacity-64">
                        <Checkbox
                          checked={checked}
                          disabled={!checked && full}
                          onCheckedChange={(next) => toggle(candidate, next)}
                        />
                        <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                        <LinkCandidateOrigin candidate={candidate} />
                      </label>
                      {checked ? (
                        <Input
                          size="sm"
                          aria-label={`What ${candidate.title} owns`}
                          value={purposeOf(candidate, entry.purpose)}
                          placeholder="The repo, area or job it owns"
                          maxLength={LINK_PURPOSE_MAX_LENGTH}
                          onChange={(event) => setPurpose(candidate, event.target.value)}
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {needsShare ? (
            <div className="flex flex-col gap-2 rounded-lg border p-2.5">
              <p className="text-sm">
                Linking shares {current?.title.trim() || "this thread"} with {sharedNames} as a
                collaborator, so their agents can send it tasks.
              </p>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="link-share-approval">
                  Commands and file changes need my approval
                </Label>
                <Switch
                  id="link-share-approval"
                  checked={requireApproval}
                  onCheckedChange={(checked) => setRequireApproval(Boolean(checked))}
                />
              </div>
              {canShare ? null : (
                <p className="text-destructive text-xs">
                  You cannot share threads in this environment.
                </p>
              )}
            </div>
          ) : null}
          {error === null ? null : (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={creating}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void confirm()} disabled={!canSubmit}>
            {creating
              ? "Linking..."
              : {
                  link: needsShare ? "Share and link" : "Link threads",
                  add: needsShare ? "Share and add" : "Add threads",
                  join: needsShare ? "Share and join" : "Join group",
                  save: "Save",
                }[action]}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Where a candidate runs: nothing for this environment, else the machine or the colleague. */
function LinkCandidateOrigin({ candidate }: { readonly candidate: LinkCandidate }) {
  if (candidate.kind === "local") return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs">
      {candidate.kind === "shared" ? (
        <Colleague userId={candidate.ownerSub} className="max-w-32" />
      ) : (
        <span className="max-w-32 truncate">{candidate.environmentLabel}</span>
      )}
      {candidate.online ? null : <Badge variant="secondary">Offline</Badge>}
    </span>
  );
}

const CHAIN_STATUS: Record<
  LinkChainTask["status"],
  { readonly label: string; readonly variant: "info" | "success" | "error" | "secondary" }
> = {
  queued: { label: "Queued", variant: "info" },
  running: { label: "Running", variant: "info" },
  waiting: { label: "Waiting", variant: "info" },
  waiting_for_owner_approval: { label: "Awaiting approval", variant: "info" },
  peer_offline: { label: "Peer offline", variant: "secondary" },
  completed: { label: "Completed", variant: "success" },
  failed: { label: "Failed", variant: "error" },
  stopped: { label: "Stopped", variant: "secondary" },
  interrupted: { label: "Stopped", variant: "secondary" },
};

function LinkChainDialog({
  target,
  onClose,
}: {
  readonly target: LinkChainDialogTarget;
  readonly onClose: () => void;
}) {
  const chainQuery = useEnvironmentQuery(
    serverEnvironment.linkChain({
      environmentId: target.environmentId,
      input: { chainId: target.chainId },
    }),
  );
  const shells = useQuietThreadShells();
  const canStop = useAtomValue(serverEnvironment.stopLinkTask.permissionAtom(target.environmentId));
  const stopLinkTask = useAtomCommand(serverEnvironment.stopLinkTask, "stop linked task");
  const navigate = useNavigate();
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const titleOf = (threadId: ThreadId) =>
    shells.find((thread) => thread.environmentId === target.environmentId && thread.id === threadId)
      ?.title ?? "Unknown thread";
  const nodes = flattenLinkChain(chainQuery.data?.tasks ?? []);

  const openThread = (threadId: ThreadId) => {
    onClose();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(target.environmentId, threadId)),
    });
  };
  const stop = async (task: LinkChainTask) => {
    if (stoppingId !== null) return;
    setStoppingId(task.taskId);
    await stopLinkTask({
      environmentId: task.requester.environmentId,
      input: { threadId: task.requester.threadId, taskId: task.taskId },
    });
    setStoppingId(null);
    chainQuery.refresh();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Task chain</DialogTitle>
          <DialogDescription>
            Who assigned what to whom. Stopping a task also stops every task derived from it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {chainQuery.error !== null ? (
            <p role="alert" className="text-destructive text-sm">
              Could not load the chain: {chainQuery.error}
            </p>
          ) : chainQuery.data === null ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : (
            <>
              {chainQuery.data.stopped ? (
                <p className="text-muted-foreground text-sm">
                  This chain was stopped. Its agents cannot assign new tasks in it.
                </p>
              ) : null}
              <ol className="m-0 flex list-none flex-col gap-1 p-0">
                {nodes.map(({ task, depth }) => {
                  const status = CHAIN_STATUS[task.status];
                  return (
                    <li
                      key={task.taskId}
                      className="flex min-w-0 flex-col gap-1 rounded-lg border px-2.5 py-2"
                      style={{ marginInlineStart: depth * 20 }}
                    >
                      <div className="flex min-w-0 items-center gap-1.5 text-sm">
                        <InlineButton
                          tone="muted"
                          onClick={() => openThread(task.requester.threadId)}
                        >
                          {titleOf(task.requester.threadId)}
                        </InlineButton>
                        <ArrowRightIcon
                          aria-hidden
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                        <InlineButton onClick={() => openThread(task.assignee.threadId)}>
                          {titleOf(task.assignee.threadId)}
                        </InlineButton>
                        <span className="min-w-0 flex-1" />
                        <Badge variant={status.variant}>{status.label}</Badge>
                        {canStop && isLiveLinkChainTask(task.status) ? (
                          <Button
                            size="xs"
                            variant="ghost-destructive"
                            disabled={stoppingId !== null}
                            aria-label={`Stop task for ${titleOf(task.assignee.threadId)}`}
                            onClick={() => void stop(task)}
                          >
                            <SquareIcon aria-hidden className="fill-current" />
                            Stop
                          </Button>
                        ) : null}
                      </div>
                      <ExpandableText
                        text={task.prompt}
                        className="text-muted-foreground text-xs"
                        collapsedClassName="line-clamp-2"
                        expandLabel="Show full task"
                      />
                      {task.result ? (
                        <div className="flex min-w-0 flex-col gap-0.5 border-t pt-1.5 text-xs">
                          <span className="font-medium text-muted-foreground">Reply</span>
                          <ExpandableText
                            text={task.result}
                            collapsedClassName="line-clamp-4"
                            expandLabel="Show full reply"
                          />
                        </div>
                      ) : null}
                      {task.stoppedBy === null ? null : (
                        <p className="text-muted-foreground text-xs">Stopped by {task.stoppedBy}</p>
                      )}
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={chainQuery.isPending}
            onClick={() => chainQuery.refresh()}
          >
            Refresh
          </Button>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
