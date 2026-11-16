import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { RelayThreadInvitePreview } from "@t3tools/contracts/relay";
import { promptLinkDeepLink } from "@t3tools/shared/promptLinks";
import { THREAD_INVITE_PATH_PREFIX } from "@t3tools/shared/threadInvites";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState } from "react";

import { isHostedStaticApp } from "~/hostedPairing";
import { sharedThreads } from "~/state/sharing";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";

type InviteState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly preview: RelayThreadInvitePreview };

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "Try again in a moment.";

function describeAccess(preview: RelayThreadInvitePreview) {
  if (preview.role === "viewer") return "You can read it.";
  return preview.requireApproval
    ? "You can send messages. Commands and file changes they lead to wait for the owner."
    : "You can send messages.";
}

/** `/invite/<token>`: someone's invite link (#58), opened after sign-in. */
export function ThreadInvitePage({ token }: { readonly token: string }) {
  const navigate = useNavigate();
  const previewInvite = useAtomCommand(sharedThreads.previewInvite, { reportFailure: false });
  const acceptInvite = useAtomCommand(sharedThreads.acceptInvite, { reportFailure: false });
  const [state, setState] = useState<InviteState>({ status: "loading" });
  const [joining, setJoining] = useState(false);
  // The relay session attaches a moment after sign-in, so a link opened cold must wait for it.
  const accountId = useAtomValue(managedRelaySessionAtom)?.accountId ?? null;

  const load = useEffectEvent((isActive: () => boolean) => {
    void previewInvite({ token }).then((result) => {
      if (!isActive() || isAtomCommandInterrupted(result)) return;
      if (result._tag === "Failure") {
        setState({ status: "failed", message: errorMessage(squashAtomCommandFailure(result)) });
        return;
      }
      setState(
        result.value === null
          ? { status: "unavailable" }
          : { status: "ready", preview: result.value },
      );
    });
  });

  // oxlint-disable-next-line t3code/react-effect-budget -- reads the invite from the relay once the account is signed in
  useEffect(() => {
    if (accountId === null) return;
    let active = true;
    load(() => active);
    return () => {
      active = false;
    };
  }, [accountId]);

  const join = async (preview: RelayThreadInvitePreview) => {
    setJoining(true);
    const result = await acceptInvite({
      token,
      label: preview.ownerUsername
        ? `${preview.ownerUsername}'s environment`
        : "A shared environment",
    });
    setJoining(false);
    if (isAtomCommandInterrupted(result)) return;
    if (result._tag === "Failure") {
      setState({ status: "failed", message: errorMessage(squashAtomCommandFailure(result)) });
      return;
    }
    if (result.value === null) {
      setState({ status: "unavailable" });
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: result.value.environmentId, threadId: result.value.threadId },
      replace: true,
    });
  };

  const deepLink = isHostedStaticApp()
    ? promptLinkDeepLink(`${THREAD_INVITE_PATH_PREFIX}${token}`)
    : null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <Empty className="flex-1">
        {state.status === "loading" ? (
          <EmptyHeader className="max-w-md">
            <EmptyTitle>Opening the invite…</EmptyTitle>
          </EmptyHeader>
        ) : state.status === "unavailable" ? (
          <EmptyHeader className="max-w-md">
            <EmptyTitle>This link no longer works</EmptyTitle>
            <EmptyDescription>Ask the person who sent it for a new one.</EmptyDescription>
          </EmptyHeader>
        ) : state.status === "failed" ? (
          <EmptyHeader className="max-w-md">
            <EmptyTitle>Could not open the invite</EmptyTitle>
            <EmptyDescription>{state.message}</EmptyDescription>
          </EmptyHeader>
        ) : (
          <>
            <EmptyHeader className="max-w-md">
              <EmptyTitle>{state.preview.title || "Untitled thread"}</EmptyTitle>
              <EmptyDescription>
                {state.preview.own
                  ? "This is your thread."
                  : `${state.preview.ownerUsername || "Someone"} shared this thread with you. ${describeAccess(state.preview)} It runs on their computer, so it is unavailable while they are offline.`}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent className="flex-row justify-center">
              <Button disabled={joining} onClick={() => void join(state.preview)}>
                {state.preview.own || state.preview.joined ? "Open thread" : "Join"}
              </Button>
              {deepLink !== null ? (
                <Button variant="outline" render={<a href={deepLink} />}>
                  {/android|iphone|ipad/i.test(navigator.userAgent)
                    ? "Open in app"
                    : "Open in desktop app"}
                </Button>
              ) : null}
            </EmptyContent>
          </>
        )}
      </Empty>
    </SidebarInset>
  );
}
