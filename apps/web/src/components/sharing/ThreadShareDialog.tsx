import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isNotOrganizationMemberError } from "@t3tools/client-runtime/sharing/organization-directory";
import {
  describeShareDetail,
  shareQuickPicks,
  shareTargetLabel,
  shareWaitsForOrgOwner,
  type ShareQuickPicks,
} from "@t3tools/client-runtime/sharing/share-targets";
import type { FwaiGatewayOrganizationMember } from "@t3tools/shared/fwaiGateway";
import {
  type ScopedThreadRef,
  type ThreadShare,
  type ThreadShareLinkExpiry,
  type ThreadShareLinkMode,
  type ThreadShareRole,
  type ThreadShareTarget,
} from "@t3tools/contracts";
import { threadInviteUrl } from "@t3tools/shared/threadInvites";
import { Building2Icon, FolderIcon, LinkIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { configuredHostedAppUrl } from "~/hostedPairing";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useQuietThreadProjection } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
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
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ColleagueAvatar, useOrganizationDirectory, useSignedInUserId } from "./colleagues";
import { threadShareDialogThreadAtom } from "./threadShareDialogState";

const SEARCH_DELAY_MS = 200;
const MEMBER_PAGE_SIZE = 20;

export function ThreadShareDialogHost() {
  const threadRef = useAtomValue(threadShareDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <ThreadShareDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(threadShareDialogThreadAtom, null)}
    />
  );
}

type OrganizationState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly picks: ShareQuickPicks }
  | { readonly status: "none" }
  | { readonly status: "failed"; readonly message: string };

type MembersState = {
  readonly query: string;
  readonly members: ReadonlyArray<FwaiGatewayOrganizationMember>;
  readonly loading: boolean;
  readonly error: string | null;
};

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

function sameTarget(share: ThreadShare, target: ThreadShareTarget) {
  return share.target.kind === target.kind && share.target.id === target.id;
}

function ThreadShareDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const projection = useQuietThreadProjection(threadRef)?.projection ?? null;
  const shares = projection?.thread.shares ?? [];
  const directory = useOrganizationDirectory();
  const signedInUserId = useSignedInUserId();
  const canShare = useAtomValue(
    serverEnvironment.grantThreadShare.permissionAtom(threadRef.environmentId),
  );
  const grantShare = useAtomCommand(serverEnvironment.grantThreadShare, { reportFailure: false });
  const revokeShare = useAtomCommand(serverEnvironment.revokeThreadShare, {
    reportFailure: false,
  });
  const decideShare = useAtomCommand(serverEnvironment.decideThreadShare, {
    reportFailure: false,
  });
  const createLink = useAtomCommand(serverEnvironment.createThreadShareLink, {
    reportFailure: false,
  });
  const [linkMode, setLinkMode] = useState<ThreadShareLinkMode>("single");
  const [linkExpiry, setLinkExpiry] = useState<ThreadShareLinkExpiry>("7d");
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const [role, setRole] = useState<ThreadShareRole>("collaborator");
  const [requireApproval, setRequireApproval] = useState(true);
  const [organization, setOrganization] = useState<OrganizationState>({ status: "loading" });
  const [members, setMembers] = useState<MembersState>({
    query: "",
    members: [],
    loading: true,
    error: null,
  });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const searchRequest = useRef(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const searchMembers = async (query: string) => {
    if (directory === null) return;
    const request = ++searchRequest.current;
    setMembers((current) => ({ ...current, loading: true, error: null }));
    try {
      const page = await directory.searchMembers({
        ...(query.trim() ? { q: query.trim() } : {}),
        limit: MEMBER_PAGE_SIZE,
      });
      if (request !== searchRequest.current) return;
      setMembers({ query, members: page.members, loading: false, error: null });
    } catch (error) {
      if (request !== searchRequest.current) return;
      setMembers((current) => ({
        ...current,
        members: [],
        loading: false,
        error: isNotOrganizationMemberError(error)
          ? null
          : errorMessage(error, "Could not search your organization."),
      }));
    }
  };

  // oxlint-disable-next-line t3code/react-effect-budget -- loads the gateway's organization and first members page when the dialog opens
  useEffect(() => {
    if (directory === null) return;
    let active = true;
    directory.getOrganization().then(
      (response) => {
        if (!active) return;
        setOrganization(
          response === null
            ? { status: "none" }
            : { status: "ready", picks: shareQuickPicks(response) },
        );
      },
      (error: unknown) => {
        if (!active) return;
        setOrganization(
          isNotOrganizationMemberError(error)
            ? { status: "none" }
            : {
                status: "failed",
                message: errorMessage(error, "Could not load your organization."),
              },
        );
      },
    );
    const request = ++searchRequest.current;
    directory.searchMembers({ limit: MEMBER_PAGE_SIZE }).then(
      (page) => {
        if (!active || request !== searchRequest.current) return;
        setMembers((current) => ({ ...current, members: page.members, loading: false }));
      },
      (error: unknown) => {
        if (!active || request !== searchRequest.current) return;
        setMembers((current) => ({
          ...current,
          loading: false,
          error: isNotOrganizationMemberError(error)
            ? null
            : errorMessage(error, "Could not search your organization."),
        }));
      },
    );
    return () => {
      active = false;
      clearTimeout(searchTimer.current);
    };
  }, [directory]);

  const grant = async (target: ThreadShareTarget) => {
    const key = `${target.kind}:${target.id}`;
    setBusyKey(key);
    setActionError(null);
    const result = await grantShare({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        target,
        role,
        ...(role === "collaborator" ? { requireApproval } : {}),
      },
    });
    setBusyKey(null);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    setActionError(errorMessage(squashAtomCommandFailure(result), "Could not share the thread."));
  };

  const makeLink = async () => {
    setBusyKey("link");
    setActionError(null);
    const result = await createLink({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        mode: linkMode,
        role,
        expiresIn: linkExpiry,
        ...(role === "collaborator" ? { requireApproval } : {}),
      },
    });
    setBusyKey(null);
    if (isAtomCommandInterrupted(result)) return;
    if (result._tag === "Success") {
      setCreatedLink(threadInviteUrl(configuredHostedAppUrl(), result.value.token));
      return;
    }
    setActionError(errorMessage(squashAtomCommandFailure(result), "Could not create the link."));
  };

  const revoke = async (share: ThreadShare, removeJoined = false) => {
    setBusyKey(share.id);
    setActionError(null);
    const result = await revokeShare({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        shareId: share.id,
        ...(removeJoined ? { removeJoined } : {}),
      },
    });
    setBusyKey(null);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    setActionError(errorMessage(squashAtomCommandFailure(result), "Could not stop sharing."));
  };

  const decide = async (share: ThreadShare, approve: boolean) => {
    setBusyKey(share.id);
    setActionError(null);
    const result = await decideShare({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, shareId: share.id, approve },
    });
    setBusyKey(null);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    setActionError(
      errorMessage(squashAtomCommandFailure(result), "Could not record the decision."),
    );
  };

  const organizationView: OrganizationState =
    directory === null
      ? { status: "failed", message: "Sign in to your fwai account to share." }
      : organization;
  const picks = organizationView.status === "ready" ? organizationView.picks : null;
  const visibleMembers = members.members.filter((member) => member.user_id !== signedInUserId);

  const targetAction = (target: ThreadShareTarget) => {
    const existing = shares.find((share) => sameTarget(share, target));
    return (
      <Button
        size="xs"
        variant="outline"
        className="ml-auto"
        disabled={!canShare || existing !== undefined || busyKey !== null}
        onClick={() => void grant(target)}
      >
        {existing !== undefined ? "Shared" : "Share"}
      </Button>
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && busyKey === null) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share thread</DialogTitle>
          <DialogDescription>
            People you share with open this thread in their own fwai until you settle it. It keeps
            running on this computer, so they cannot use it while this computer is offline.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <ToggleGroup
                aria-label="Access"
                className="w-full *:flex-1"
                value={[role]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "viewer" || value === "collaborator") setRole(value);
                }}
              >
                <Toggle value="collaborator">Can send messages</Toggle>
                <Toggle value="viewer">Can view</Toggle>
              </ToggleGroup>
              {role === "collaborator" ? (
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="thread-share-approval">
                    Commands and file changes need my approval
                  </Label>
                  <Switch
                    id="thread-share-approval"
                    checked={requireApproval}
                    onCheckedChange={(checked) => setRequireApproval(Boolean(checked))}
                  />
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-2">
              <p className="font-medium text-xs text-muted-foreground">Invite link</p>
              <div className="flex flex-wrap gap-2">
                <ToggleGroup
                  aria-label="Who can join"
                  value={[linkMode]}
                  onValueChange={(next) => {
                    const value = next[0];
                    if (value === "single" || value === "multi") setLinkMode(value);
                  }}
                >
                  <Toggle value="single">One person</Toggle>
                  <Toggle value="multi">Anyone with the link</Toggle>
                </ToggleGroup>
                <ToggleGroup
                  aria-label="Expires after"
                  value={[linkExpiry]}
                  onValueChange={(next) => {
                    const value = next[0];
                    if (value === "1d" || value === "7d" || value === "30d") setLinkExpiry(value);
                  }}
                >
                  <Toggle value="1d">1 day</Toggle>
                  <Toggle value="7d">7 days</Toggle>
                  <Toggle value="30d">30 days</Toggle>
                </ToggleGroup>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canShare || busyKey !== null}
                  onClick={() => void makeLink()}
                >
                  Create link
                </Button>
              </div>
              {createdLink !== null ? (
                <div className="flex items-center gap-2">
                  <Input aria-label="Invite link" readOnly value={createdLink} />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => copyToClipboard(createdLink, undefined)}
                  >
                    {isCopied ? "Copied" : "Copy"}
                  </Button>
                </div>
              ) : null}
            </div>

            {organizationView.status === "none" ? null : organizationView.status === "failed" ? (
              <p role="alert" className="text-destructive text-xs">
                {organizationView.message}
              </p>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  <Input
                    aria-label="Search colleagues by username"
                    placeholder="Search colleagues by username"
                    value={members.query}
                    onChange={(event) => {
                      const query = event.target.value;
                      setMembers((current) => ({ ...current, query }));
                      clearTimeout(searchTimer.current);
                      searchTimer.current = setTimeout(
                        () => void searchMembers(query),
                        SEARCH_DELAY_MS,
                      );
                    }}
                  />
                  <ul
                    className="flex max-h-48 flex-col gap-1 overflow-y-auto"
                    aria-label="Colleagues"
                  >
                    {visibleMembers.map((member) => (
                      <li key={member.user_id} className="flex items-center gap-2 text-sm">
                        <ColleagueAvatar userId={member.user_id} name={member.username} />
                        <span className="truncate">{member.username}</span>
                        {targetAction({
                          kind: "account",
                          id: member.user_id,
                          label: member.username,
                        })}
                      </li>
                    ))}
                    {!members.loading && visibleMembers.length === 0 && members.error === null ? (
                      <li className="text-muted-foreground text-xs">No colleagues found.</li>
                    ) : null}
                  </ul>
                  {members.error !== null ? (
                    <p role="alert" className="text-destructive text-xs">
                      {members.error}
                    </p>
                  ) : null}
                </div>

                {picks !== null && (picks.projects.length > 0 || picks.organization !== null) ? (
                  <ul className="flex flex-col gap-1" aria-label="Projects and organization">
                    {picks.projects.map((project) => (
                      <li key={project.id} className="flex items-center gap-2 text-sm">
                        <FolderIcon aria-hidden className="size-4 text-muted-foreground" />
                        <span className="truncate">Project {project.label}</span>
                        {targetAction(project)}
                      </li>
                    ))}
                    {picks.organization !== null ? (
                      <li className="flex items-center gap-2 text-sm">
                        <Building2Icon aria-hidden className="size-4 text-muted-foreground" />
                        <span className="min-w-0 truncate">
                          Everyone in {picks.organization.label}
                          {shareWaitsForOrgOwner(picks.role, "organization") ? (
                            <span className="text-muted-foreground">
                              {" "}
                              · an organization owner approves
                            </span>
                          ) : null}
                        </span>
                        {targetAction(picks.organization)}
                      </li>
                    ) : null}
                  </ul>
                ) : null}
              </>
            )}

            {shares.length > 0 ? (
              <div className="flex flex-col gap-1">
                <p className="font-medium text-xs text-muted-foreground">Shared with</p>
                <ul className="flex flex-col gap-1" aria-label="Current shares">
                  {shares.map((share) => (
                    <ShareRow
                      key={share.id}
                      share={share}
                      joinedCount={shares.filter((item) => item.viaShareId === share.id).length}
                      busy={busyKey !== null}
                      canRevoke={canShare}
                      onRevoke={(removeJoined) => void revoke(share, removeJoined)}
                      onDecide={(approve) => void decide(share, approve)}
                    />
                  ))}
                </ul>
              </div>
            ) : null}

            {actionError !== null ? (
              <p role="alert" className="text-destructive text-xs">
                {actionError}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" onClick={onClose} disabled={busyKey !== null}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const shareDetail = (share: ThreadShare) =>
  describeShareDetail(share, new Date().toISOString(), (expiresAt) =>
    new Date(expiresAt).toLocaleDateString(),
  );

export function ShareRow({
  share,
  joinedCount = 0,
  busy,
  canRevoke,
  onRevoke,
  onDecide,
}: {
  readonly share: ThreadShare;
  /** People who joined through this share, when it is an invite link. */
  readonly joinedCount?: number;
  readonly busy: boolean;
  readonly canRevoke: boolean;
  /** `removeJoined`: also remove everyone who joined through this link. */
  readonly onRevoke: (removeJoined: boolean) => void;
  /** Approves or rejects a share an agent proposed. */
  readonly onDecide: (approve: boolean) => void;
}) {
  return (
    <li className="flex items-center gap-2 text-sm">
      {share.target.kind === "account" ? (
        <ColleagueAvatar userId={share.target.id} name={share.target.label} />
      ) : share.target.kind === "project" ? (
        <FolderIcon aria-hidden className="size-4 text-muted-foreground" />
      ) : share.target.kind === "link" ? (
        <LinkIcon aria-hidden className="size-4 text-muted-foreground" />
      ) : (
        <Building2Icon aria-hidden className="size-4 text-muted-foreground" />
      )}
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{shareTargetLabel(share)}</span>
        <span className="truncate text-muted-foreground text-xs">{shareDetail(share)}</span>
      </span>
      {share.status === "proposed" ? (
        <span className="ml-auto flex gap-1">
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!canRevoke || busy}
            onClick={() => onDecide(false)}
          >
            Reject
          </Button>
          <Button size="xs" disabled={!canRevoke || busy} onClick={() => onDecide(true)}>
            Approve
          </Button>
        </span>
      ) : share.target.kind === "link" && joinedCount > 0 ? (
        <span className="ml-auto flex gap-1">
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!canRevoke || busy}
            onClick={() => onRevoke(false)}
          >
            Revoke link
          </Button>
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!canRevoke || busy}
            onClick={() => onRevoke(true)}
          >
            Revoke and remove {joinedCount}
          </Button>
        </span>
      ) : (
        <Button
          size="xs"
          variant="ghost-muted"
          className="ml-auto"
          disabled={!canRevoke || busy}
          onClick={() => onRevoke(false)}
        >
          {share.status === "pending_approval" ? "Cancel" : "Revoke"}
        </Button>
      )}
    </li>
  );
}
