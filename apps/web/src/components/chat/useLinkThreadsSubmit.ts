import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  LINK_MAX_MEMBERS,
  type LinkGroup,
  type LinkGroupId,
  type ScopedThreadRef,
  type ThreadShare,
  ThreadShareError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { AsyncResult } from "effect/reactivity";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";
import {
  type LinkCandidate,
  type LinkCommandInput,
  type LinkConfirmPlan,
  type LinkGroupChoice,
  linkCommandPlan,
} from "./linkGroups.logic";
import { openLinkGroupChoiceDialog, openLinkThreadsDialog } from "./linkGroupsDialogState";

const isThreadShareError = Schema.is(ThreadShareError);
const isDuplicateShare = (error: unknown) =>
  isThreadShareError(error) && error.reason === "duplicate";

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}

export type LinkThreadsSubmitResult =
  | { readonly _tag: "Success" }
  /** The command was interrupted; nothing to report. */
  | { readonly _tag: "Interrupted" }
  /** The server's message, or a fallback when it gave none. */
  | { readonly _tag: "Failure"; readonly message: string };

/**
 * Carries out a link the person confirmed: the reverse shares first (a colleague's tasks to this
 * thread need them), then a new group or the members added to an existing one. The picker and
 * `/link` both go through here.
 */
export function useLinkThreadsSubmit() {
  const createLinkGroup = useAtomCommand(serverEnvironment.createLinkGroup, {
    reportFailure: false,
  });
  const setLinkMember = useAtomCommand(serverEnvironment.setLinkMember, { reportFailure: false });
  const grantThreadShare = useAtomCommand(serverEnvironment.grantThreadShare, {
    reportFailure: false,
  });

  return async (
    threadRef: ScopedThreadRef,
    input: {
      readonly plan: LinkConfirmPlan;
      /** Adds to this group; null creates one named `name` with `ownPurpose` for this thread. */
      readonly linkId: LinkGroupId | null;
      readonly name: string;
      readonly ownPurpose: string;
    },
  ): Promise<LinkThreadsSubmitResult> => {
    const fail = (
      result: AsyncResult.Failure<unknown, unknown>,
      fallback: string,
    ): LinkThreadsSubmitResult =>
      isAtomCommandInterrupted(result)
        ? { _tag: "Interrupted" }
        : { _tag: "Failure", message: failureMessage(squashAtomCommandFailure(result), fallback) };

    for (const grant of input.plan.grants) {
      const shared = await grantThreadShare({
        environmentId: threadRef.environmentId,
        input: grant,
      });
      // A share the caller did not know about (the detail was not loaded) is kept as it is.
      if (shared._tag === "Failure" && !isDuplicateShare(squashAtomCommandFailure(shared))) {
        return fail(shared, `Could not share this thread with ${grant.target.label}.`);
      }
    }
    if (input.linkId === null) {
      const result = await createLinkGroup({
        environmentId: threadRef.environmentId,
        input: {
          name: input.name.trim(),
          members: [
            { threadId: threadRef.threadId, purpose: input.ownPurpose.trim() },
            ...input.plan.members,
          ],
        },
      });
      if (result._tag === "Failure") return fail(result, "Could not link the threads.");
      return { _tag: "Success" };
    }
    for (const member of input.plan.members) {
      const result = await setLinkMember({
        environmentId: threadRef.environmentId,
        input: { linkId: input.linkId, ...member },
      });
      if (result._tag === "Failure") return fail(result, "Could not add the threads.");
    }
    return { _tag: "Success" };
  };
}

/**
 * Runs `/link <thread>` once the candidate is known: asks which group when the two threads' groups
 * are several, hands a share back to the picker, or links directly. Resolves to whether it went
 * through (or handed over to a dialog), so the composer knows to clear.
 */
export function useRunLinkCommand() {
  const submitLink = useLinkThreadsSubmit();
  return async (
    threadRef: ScopedThreadRef,
    input: {
      readonly candidate: LinkCandidate;
      readonly currentTitle: string | undefined;
      readonly currentPurpose?: string;
      readonly currentShares: ReadonlyArray<ThreadShare>;
      /** The environment's groups. */
      readonly groups: ReadonlyArray<LinkGroup>;
      readonly ownerName: (ownerSub: string) => string | null;
      readonly command: LinkCommandInput;
      readonly choice?: LinkGroupChoice;
    },
  ): Promise<boolean> => {
    const { candidate, command } = input;
    const plan = linkCommandPlan({ current: threadRef, ...input });
    switch (plan.kind) {
      case "choose":
        openLinkGroupChoiceDialog({ threadRef, candidate, command });
        return true;
      case "confirm":
        openLinkThreadsDialog(threadRef, { linkId: plan.linkId, preselect: candidate, command });
        return true;
      case "linked":
        toastManager.add({
          type: "info",
          title: `Already linked with ${candidate.title}`,
          description: plan.name,
        });
        return true;
      case "full":
        toastManager.add({
          type: "error",
          title: `${plan.name} is full`,
          description: `A group holds at most ${LINK_MAX_MEMBERS} threads.`,
        });
        return false;
    }
    const result = await submitLink(threadRef, {
      plan: plan.plan,
      linkId: plan.kind === "add" ? plan.linkId : null,
      name: plan.name,
      ownPurpose: plan.kind === "create" ? plan.ownPurpose : "",
    });
    if (result._tag === "Interrupted") return false;
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not link", description: result.message });
      return false;
    }
    toastManager.add({
      type: "success",
      title:
        plan.kind === "create"
          ? "Threads linked"
          : plan.addsCandidate
            ? `Added ${candidate.title}`
            : plan.addsCurrent
              ? "Added this thread"
              : "Purpose updated",
      description: plan.name,
    });
    return true;
  };
}
