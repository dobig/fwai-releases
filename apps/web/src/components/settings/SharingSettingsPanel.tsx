import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ThreadShare } from "@t3tools/contracts";
import type { RelayOrgShareRequest } from "@t3tools/contracts/relay";
import { useEffect, useEffectEvent, useState } from "react";

import { useQuietThreadShells } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { sharedThreads } from "~/state/sharing";
import { useAtomCommand } from "~/state/use-atom-command";
import { Colleague, useOrganizationDirectory } from "../sharing/colleagues";
import { ShareRow } from "../sharing/ThreadShareDialog";
import { openThreadShareDialog } from "../sharing/threadShareDialogState";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

export function SharingSettingsPanel() {
  const signedIn = useOrganizationDirectory() !== null;
  const sharedThreadShells = useQuietThreadShells().filter(
    (thread) => (thread.shareCount ?? 0) > 0 && thread.archivedAt === null,
  );
  return (
    <SettingsPageContainer>
      <SettingsSection
        id={searchableSetting("shared-by-me").id}
        title={searchableSetting("shared-by-me").title}
      >
        {sharedThreadShells.length === 0 ? (
          <SettingsRow title="No shared threads" description="Share a thread from its menu." />
        ) : (
          sharedThreadShells.map((thread) => (
            // Keyed by the count so a share added or ended elsewhere reads the list again.
            <SharedByMeRow
              key={`${thread.environmentId}:${thread.id}:${thread.shareCount ?? 0}`}
              thread={thread}
            />
          ))
        )}
      </SettingsSection>
      {signedIn ? <OrganizationShareRequestsSection /> : null}
    </SettingsPageContainer>
  );
}

function SharedByMeRow({ thread }: { readonly thread: EnvironmentThreadShell }) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const listShares = useAtomCommand(serverEnvironment.listThreadShares, { reportFailure: false });
  const revokeShare = useAtomCommand(serverEnvironment.revokeThreadShare, {
    reportFailure: false,
  });
  const decideShare = useAtomCommand(serverEnvironment.decideThreadShare, {
    reportFailure: false,
  });
  const canRevoke = useAtomValue(
    serverEnvironment.revokeThreadShare.permissionAtom(thread.environmentId),
  );
  const [shares, setShares] = useState<ReadonlyArray<ThreadShare> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/react-effect-budget -- the shell carries only a share count, so read the shares from the owner's environment
  useEffect(() => {
    let active = true;
    void listShares({
      environmentId: thread.environmentId,
      input: { threadId: thread.id },
    }).then((result) => {
      if (!active) return;
      if (result._tag === "Success") {
        setShares(result.value.shares);
        setError(null);
      } else if (!isAtomCommandInterrupted(result)) {
        setError(errorMessage(squashAtomCommandFailure(result), "Could not read the shares."));
      }
    });
    return () => {
      active = false;
    };
  }, [listShares, thread.environmentId, thread.id]);

  const decide = async (share: ThreadShare, approve: boolean) => {
    setBusy(true);
    const result = await decideShare({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, shareId: share.id, approve },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setShares(result.value.shares);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError(errorMessage(squashAtomCommandFailure(result), "Could not record the decision."));
    }
  };

  const revoke = async (share: ThreadShare, removeJoined: boolean) => {
    setBusy(true);
    const result = await revokeShare({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, shareId: share.id, ...(removeJoined ? { removeJoined } : {}) },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setShares(result.value.shares);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError(errorMessage(squashAtomCommandFailure(result), "Could not stop sharing."));
    }
  };

  return (
    <SettingsRow
      title={thread.title || "Untitled thread"}
      description={error ?? undefined}
      control={
        <Button size="sm" variant="outline" onClick={() => openThreadShareDialog(threadRef)}>
          Manage
        </Button>
      }
    >
      {shares !== null && shares.length > 0 ? (
        <ul className="flex flex-col gap-1 pt-2" aria-label={`Shares of ${thread.title}`}>
          {shares.map((share) => (
            <ShareRow
              key={share.id}
              share={share}
              joinedCount={shares.filter((item) => item.viaShareId === share.id).length}
              busy={busy}
              canRevoke={canRevoke}
              onRevoke={(removeJoined) => void revoke(share, removeJoined)}
              onDecide={(approve) => void decide(share, approve)}
            />
          ))}
        </ul>
      ) : null}
    </SettingsRow>
  );
}

/** Whole-organization shares members asked for. Only org owners see this; the relay says who. */
function OrganizationShareRequestsSection() {
  const { requests } = useAtomValue(sharedThreads.orgShareRequestsValueAtom);
  const refresh = useAtomCommand(sharedThreads.refreshOrgShareRequests, { reportFailure: false });
  const decide = useAtomCommand(sharedThreads.decideOrgShareRequest, { reportFailure: false });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyLoad = (result: Awaited<ReturnType<typeof refresh>>) => {
    if (result._tag === "Success") setError(null);
    else if (!isAtomCommandInterrupted(result)) {
      setError(errorMessage(squashAtomCommandFailure(result), "Could not load share requests."));
    }
  };
  const load = async () => applyLoad(await refresh());
  const applyOnOpen = useEffectEvent(applyLoad);

  // oxlint-disable-next-line t3code/react-effect-budget -- re-reads the relay's pending requests when the page opens
  useEffect(() => {
    void refresh().then(applyOnOpen);
  }, [refresh]);

  const respond = async (request: RelayOrgShareRequest, decision: "approve" | "reject") => {
    setBusyId(request.id);
    const result = await decide({ requestId: request.id, decision });
    setBusyId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(errorMessage(squashAtomCommandFailure(result), "Could not record the decision."));
    }
    await load();
  };

  // Members get 403 from the relay, which reads as null: nothing for them to decide.
  if (requests === null || (requests === undefined && error === null)) return null;
  return (
    <SettingsSection
      id={searchableSetting("org-share-requests").id}
      title={searchableSetting("org-share-requests").title}
    >
      {error !== null ? (
        <SettingsRow title="Could not load share requests" description={error} />
      ) : null}
      {requests !== undefined && requests.length === 0 ? (
        <SettingsRow
          title="No requests"
          description="When a member shares a thread with the whole organization, it waits here."
        />
      ) : null}
      {requests?.map((request) => (
        <SettingsRow
          key={request.id}
          title={request.title || "Untitled thread"}
          description={
            <span className="inline-flex flex-wrap items-center gap-1">
              <Colleague userId={request.ownerSub} />
              <span>· {request.role === "viewer" ? "can view" : "can send messages"}</span>
            </span>
          }
          control={
            <span className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busyId !== null}
                onClick={() => void respond(request, "reject")}
              >
                Reject
              </Button>
              <Button
                size="sm"
                disabled={busyId !== null}
                onClick={() => void respond(request, "approve")}
              >
                Approve
              </Button>
            </span>
          }
        />
      ))}
    </SettingsSection>
  );
}
