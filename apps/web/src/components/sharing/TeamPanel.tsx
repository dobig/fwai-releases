import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isNotOrganizationMemberError } from "@t3tools/client-runtime/sharing/organization-directory";
import { describeShareStatus } from "@t3tools/client-runtime/sharing/share-targets";
import {
  groupTeamStructure,
  quickShareBlockReason,
  quickShareGrant,
  shareForTarget,
  type TeamMember,
} from "@t3tools/client-runtime/sharing/team";
import type { FwaiGatewayOrganizationMember } from "@t3tools/shared/fwaiGateway";
import type { ScopedThreadRef, ThreadShare, ThreadShareTarget } from "@t3tools/contracts";
import { Building2Icon, FolderIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { useQuietThreadProjection, useQuietThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { isSharedEnvironmentAtom } from "~/state/sharing";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { useTeamPanelWidthStore } from "./TeamPanelToggle";
import {
  ColleagueAvatar,
  useOrganizationDirectory,
  useOrganizationState,
  useSignedInUserId,
} from "./colleagues";

type MembersResult =
  | { readonly status: "ready"; readonly members: ReadonlyArray<FwaiGatewayOrganizationMember> }
  | { readonly status: "failed"; readonly message: string };
type MembersState = { readonly status: "loading" } | MembersResult;

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/** The current thread's quick-share state, shared by every row of the panel. */
interface QuickShare {
  readonly blockReason: string | null;
  readonly shares: ReadonlyArray<ThreadShare>;
  readonly busyKey: string | null;
  readonly grant: (target: ThreadShareTarget) => void;
  readonly revoke: (share: ThreadShare) => void;
}

function useQuickShare(threadRef: ScopedThreadRef): QuickShare & { readonly error: string | null } {
  const shell = useQuietThreadShell(threadRef);
  const projection = useQuietThreadProjection(shell === null ? null : threadRef)?.projection;
  const isShared = useAtomValue(isSharedEnvironmentAtom(threadRef.environmentId));
  const canGrant = useAtomValue(
    serverEnvironment.grantThreadShare.permissionAtom(threadRef.environmentId),
  );
  const grantShare = useAtomCommand(serverEnvironment.grantThreadShare, { reportFailure: false });
  const revokeShare = useAtomCommand(serverEnvironment.revokeThreadShare, {
    reportFailure: false,
  });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (
    key: string,
    action: () => ReturnType<typeof grantShare>,
    fallback: string,
  ): Promise<void> => {
    setBusyKey(key);
    setError(null);
    const result = await action();
    setBusyKey(null);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    setError(errorMessage(squashAtomCommandFailure(result), fallback));
  };

  return {
    blockReason: quickShareBlockReason({
      hasThread: shell !== null,
      isSharedEnvironment: isShared,
      canGrant,
    }),
    shares: projection?.thread.shares ?? [],
    busyKey,
    error,
    grant: (target) =>
      void run(
        `${target.kind}:${target.id}`,
        () =>
          grantShare({
            environmentId: threadRef.environmentId,
            input: quickShareGrant(threadRef.threadId, target),
          }),
        `Could not share the thread with ${target.label}.`,
      ),
    revoke: (share) =>
      void run(
        share.id,
        () =>
          revokeShare({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, shareId: share.id },
          }),
        "Could not stop sharing.",
      ),
  };
}

/**
 * The organization, its projects and their members, with a quick share of the current thread for
 * each. Reads the gateway directory with the account's token, never emails.
 */
export function TeamPanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const directory = useOrganizationDirectory();
  const organization = useOrganizationState();
  const signedInUserId = useSignedInUserId();
  const quickShare = useQuickShare(threadRef);
  const [reload, setReload] = useState(0);
  // Tagged with the load it answers, so a reload reads as loading until its answer arrives.
  const [loaded, setLoaded] = useState<{
    readonly reload: number;
    readonly result: MembersResult;
  } | null>(null);
  const members: MembersState =
    loaded !== null && loaded.reload === reload ? loaded.result : { status: "loading" };
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const organizationReady = organization.status === "ready";

  // oxlint-disable-next-line t3code/react-effect-budget -- reads the gateway's members directory when the panel opens or reloads
  useEffect(() => {
    if (directory === null || !organizationReady) return;
    let active = true;
    const request = reload;
    directory.listAllMembers().then(
      (list) => {
        if (active) setLoaded({ reload: request, result: { status: "ready", members: list } });
      },
      (error: unknown) => {
        if (!active) return;
        setLoaded({
          reload: request,
          result: isNotOrganizationMemberError(error)
            ? { status: "ready", members: [] }
            : { status: "failed", message: errorMessage(error, "Could not load your team.") },
        });
      },
    );
    return () => {
      active = false;
    };
  }, [directory, organizationReady, reload]);

  const refresh = () => {
    void directory?.organization.load({ force: true });
    setReload((value) => value + 1);
  };

  if (directory === null) {
    return <TeamPanelMessage title="Sign in to see your team" />;
  }
  if (organization.status === "loading" || (organizationReady && members.status === "loading")) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner aria-label="Loading your team" />
      </div>
    );
  }
  if (organization.status === "none") {
    return (
      <TeamPanelMessage
        title="Not in an organization"
        description="Your fwai account is not in an organization, so there is no team to show."
      />
    );
  }
  if (organization.status === "failed" || members.status === "failed") {
    const message = organization.status === "failed" ? organization.message : null;
    return (
      <TeamPanelMessage
        title="Could not load your team"
        description={message ?? (members.status === "failed" ? members.message : "")}
        action={
          <Button size="sm" variant="outline" onClick={refresh}>
            Try again
          </Button>
        }
      />
    );
  }
  if (members.status !== "ready") return null;
  const structure = groupTeamStructure({
    response: organization.response,
    members: members.members,
    signedInUserId,
  });
  if (structure === null) return null;

  const toggleSection = (id: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div ref={measureTeamPanelWidth} className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Building2Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span data-team-fit className="min-w-0 flex-1 truncate font-medium text-sm">
          {structure.organization.name}
        </span>
        {structure.role === "owner" ? <Badge variant="secondary">Owner</Badge> : null}
        <Button size="xs" variant="ghost-muted" onClick={refresh}>
          Refresh
        </Button>
      </div>
      <div className="flex flex-col gap-1 p-2">
        {quickShare.blockReason !== null ? (
          <p className="px-2 text-muted-foreground text-xs">{quickShare.blockReason}</p>
        ) : null}
        {quickShare.error !== null ? (
          <p role="alert" className="px-2 text-destructive text-xs">
            {quickShare.error}
          </p>
        ) : null}
        <ul className="m-0 flex list-none flex-col p-0" aria-label="Whole organization">
          <TargetRow
            icon={<Building2Icon aria-hidden className="size-4 text-muted-foreground" />}
            label={`Everyone in ${structure.organization.name}`}
            target={{
              kind: "organization",
              id: structure.organization.id,
              label: structure.organization.name,
            }}
            quickShare={quickShare}
          />
        </ul>
        {structure.projects.map((project) => {
          const expanded = !collapsed.has(project.id);
          return (
            <section key={project.id} className="flex flex-col">
              <CollapsibleSectionHeader
                variant="panel"
                expanded={expanded}
                onClick={() => toggleSection(project.id)}
              >
                {project.name}
              </CollapsibleSectionHeader>
              {expanded ? (
                <ul className="m-0 flex list-none flex-col p-0" aria-label={project.name}>
                  <TargetRow
                    icon={<FolderIcon aria-hidden className="size-4 text-muted-foreground" />}
                    label={`Project ${project.name}`}
                    target={{ kind: "project", id: project.id, label: project.name }}
                    quickShare={quickShare}
                  />
                  {project.members.map((member) => (
                    <MemberRow key={member.userId} member={member} quickShare={quickShare} />
                  ))}
                  {project.members.length === 0 ? (
                    <li className="px-2 py-1 text-muted-foreground text-xs">No members.</li>
                  ) : null}
                </ul>
              ) : null}
            </section>
          );
        })}
        {structure.unassigned.length > 0 ? (
          <section className="flex flex-col">
            <CollapsibleSectionHeader
              variant="panel"
              expanded={!collapsed.has("unassigned")}
              onClick={() => toggleSection("unassigned")}
            >
              Not in a project
            </CollapsibleSectionHeader>
            {collapsed.has("unassigned") ? null : (
              <ul className="m-0 flex list-none flex-col p-0" aria-label="Not in a project">
                {structure.unassigned.map((member) => (
                  <MemberRow key={member.userId} member={member} quickShare={quickShare} />
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The width at which no name is cut off and no row stretches: each name's own width plus what
 * the rest of its row and the panel take up beside it.
 */
function measureTeamPanelWidth(panel: HTMLDivElement | null) {
  if (panel === null) return;
  let fit = 0;
  for (const name of panel.querySelectorAll<HTMLElement>("[data-team-fit]")) {
    const box = name.closest<HTMLElement>("[data-team-fit-box]") ?? name;
    fit = Math.max(fit, panel.offsetWidth - box.offsetWidth + name.scrollWidth);
  }
  if (fit > 0) useTeamPanelWidthStore.getState().setWidth(Math.ceil(fit));
}

function TeamPanelMessage(props: {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        {props.description ? <EmptyDescription>{props.description}</EmptyDescription> : null}
      </EmptyHeader>
      {props.action}
    </Empty>
  );
}

function MemberRow({
  member,
  quickShare,
}: {
  readonly member: TeamMember;
  readonly quickShare: QuickShare;
}) {
  return (
    <TargetRow
      icon={<ColleagueAvatar userId={member.userId} name={member.username} />}
      label={member.username}
      badge={
        member.isOwner ? <Badge variant="secondary">Owner</Badge> : member.isSelf ? "You" : null
      }
      target={member.isSelf ? null : { kind: "account", id: member.userId, label: member.username }}
      quickShare={quickShare}
    />
  );
}

/** One person, project or the organization, with Share, or its share's state and Revoke. */
function TargetRow({
  icon,
  label,
  badge = null,
  target,
  quickShare,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly badge?: ReactNode;
  /** Null for the signed-in account, which is never a share target. */
  readonly target: ThreadShareTarget | null;
  readonly quickShare: QuickShare;
}) {
  const share = target === null ? undefined : shareForTarget(quickShare.shares, target);
  const status = share === undefined ? null : describeShareStatus(share);
  const disabled = quickShare.blockReason !== null || quickShare.busyKey !== null;
  return (
    <li className="flex min-h-8 items-center gap-2 rounded-md px-2 text-sm">
      {icon}
      <span data-team-fit-box className="flex min-w-0 flex-1 flex-col">
        <span data-team-fit className="truncate">
          {label}
        </span>
        {share !== undefined ? (
          <span className="truncate text-muted-foreground text-xs">{status ?? "Shared"}</span>
        ) : null}
      </span>
      {typeof badge === "string" ? (
        <span className="text-muted-foreground text-xs">{badge}</span>
      ) : (
        badge
      )}
      {target === null ? null : share !== undefined ? (
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={disabled}
          aria-label={`Stop sharing with ${label}`}
          onClick={() => quickShare.revoke(share)}
        >
          Revoke
        </Button>
      ) : (
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          aria-label={`Share this thread with ${label}`}
          {...(quickShare.blockReason === null ? {} : { title: quickShare.blockReason })}
          onClick={() => quickShare.grant(target)}
        >
          Share
        </Button>
      )}
    </li>
  );
}
