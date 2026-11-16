import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { shareQuickPicks } from "@t3tools/client-runtime/sharing/share-targets";
import { quickShareGrant, shareForTarget } from "@t3tools/client-runtime/sharing/team";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { linkCommandStage, parseLinkCommand } from "@t3tools/client-runtime/link-command";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { FwaiGatewayOrganizationMember } from "@t3tools/shared/fwaiGateway";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { ComposerTrigger } from "../../composer-logic";
import { parseComposerTeamCommand } from "../../composer-logic";
import { useProjects, useQuietThreadProjection, useQuietThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useDebouncedValue } from "~/state/queries";
import { relayEnvironmentDiscovery } from "~/state/relay";
import { serverEnvironment } from "~/state/server";
import { isSharedEnvironmentAtom, sharedThreads } from "~/state/sharing";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  useOrganizationDirectory,
  useOrganizationState,
  useSignedInUserId,
} from "../sharing/colleagues";
import { toastManager } from "../ui/toast";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import {
  linkGroupSuggestions,
  linkSuggestions,
  resolveShareTarget,
  shareSuggestions,
} from "./composerTeamCommands";
import { useAccountEnvironments } from "./LinkGroupsDialogs";
import {
  defaultOwnLinkPurpose,
  linkCandidateKey,
  linkCandidates,
  linkGroupsOfEither,
} from "./linkGroups.logic";
import { useRunLinkCommand } from "./useLinkThreadsSubmit";

const MEMBER_SEARCH_DELAY_MS = 150;
const MEMBER_SEARCH_LIMIT = 20;
const NO_MEMBERS: ReadonlyArray<FwaiGatewayOrganizationMember> = [];
const subscribeToNothing = () => () => undefined;
const noVersion = () => 0;

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

type ShareTargetItem = Extract<ComposerCommandItem, { type: "share-target" }>;
type LinkTargetItem = Extract<ComposerCommandItem, { type: "link-target" }>;
type LinkGroupItem = Extract<ComposerCommandItem, { type: "link-group" }>;

/**
 * `/share <name>` and `/link <thread>`: their suggestions, whether the composer offers them, and
 * running one instead of sending it to the agent. Both are for the thread's owner: a collaborator
 * session or a session without the grant or link scopes gets neither.
 */
export function useComposerTeamCommands(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly trigger: ComposerTrigger | null;
}) {
  const { environmentId, threadId, trigger } = input;
  const threadRef = threadId === null ? null : scopeThreadRef(environmentId, threadId);
  const shells = useQuietThreadShells();
  const projects = useProjects();
  const current = threadRef
    ? (shells.find(
        (thread) => thread.environmentId === environmentId && thread.id === threadRef.threadId,
      ) ?? null)
    : null;
  const isShared = useAtomValue(isSharedEnvironmentAtom(environmentId));
  const canGrant = useAtomValue(serverEnvironment.grantThreadShare.permissionAtom(environmentId));
  const canCreateLink = useAtomValue(
    serverEnvironment.createLinkGroup.permissionAtom(environmentId),
  );
  const canAddLinkMember = useAtomValue(
    serverEnvironment.setLinkMember.permissionAtom(environmentId),
  );
  const directory = useOrganizationDirectory();
  const organization = useOrganizationState();
  const signedInUserId = useSignedInUserId();

  const shareAvailable =
    current !== null &&
    !isShared &&
    canGrant &&
    directory !== null &&
    organization.status === "ready";
  const linkAvailable =
    current !== null &&
    !isShared &&
    current.lineage.relationshipToParent !== "subagent" &&
    (canCreateLink || canAddLinkMember);
  const shareActive = shareAvailable && trigger?.kind === "share-target";
  const linkActive = linkAvailable && trigger?.kind === "link-target";

  // The thread's shares and groups are only read while a command is typed.
  const commandTyped = shareActive || linkActive;
  const projection = useQuietThreadProjection(commandTyped ? threadRef : null)?.projection ?? null;
  const shares = projection?.thread.shares ?? [];
  const snapshot = useEnvironmentQuery(
    linkActive ? serverEnvironment.linkGroupsLive({ environmentId, input: {} }) : null,
  ).data;
  const groups = snapshot?.groups ?? [];
  const accountEnvironments = useAccountEnvironments();
  const shared = useAtomValue(sharedThreads.stateValueAtom).threads;
  const candidates =
    threadRef === null
      ? []
      : linkCandidates({
          current: threadRef,
          shells,
          accountEnvironments,
          sharedThreads: shared,
          projects,
        });
  const usernames = directory?.usernames ?? null;
  useSyncExternalStore(
    usernames?.subscribe ?? subscribeToNothing,
    usernames?.getVersion ?? noVersion,
  );
  const ownerName = (ownerSub: string) => usernames?.get(ownerSub) ?? null;

  const refreshShared = useAtomCommand(sharedThreads.refresh, { reportFailure: false });
  const refreshEnvironments = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- remote link candidates come from the relay; read them fresh when /link is typed, as the picker does
  useEffect(() => {
    if (!linkActive) return;
    void refreshShared();
    void refreshEnvironments();
  }, [linkActive, refreshShared, refreshEnvironments]);

  const shareQuery = shareActive ? trigger.query.trim() : null;
  const debouncedShareQuery = useDebouncedValue(shareQuery, MEMBER_SEARCH_DELAY_MS);
  const [memberSearch, setMemberSearch] = useState<{
    readonly query: string | null;
    readonly members: ReadonlyArray<FwaiGatewayOrganizationMember>;
  }>({ query: null, members: NO_MEMBERS });
  // oxlint-disable-next-line t3code/react-effect-budget -- prefix search in the gateway's members directory as the name is typed
  useEffect(() => {
    if (directory === null || debouncedShareQuery === null) return;
    let active = true;
    directory
      .searchMembers({
        ...(debouncedShareQuery === "" ? {} : { q: debouncedShareQuery }),
        limit: MEMBER_SEARCH_LIMIT,
      })
      .then(
        (page) => {
          if (active) setMemberSearch({ query: debouncedShareQuery, members: page.members });
        },
        () => {
          if (active) setMemberSearch({ query: debouncedShareQuery, members: NO_MEMBERS });
        },
      );
    return () => {
      active = false;
    };
  }, [directory, debouncedShareQuery]);

  const picks = shareQuickPicks(organization.status === "ready" ? organization.response : null);
  // The last suggestion picked, so `/link` on one of two same-titled threads keeps the one chosen.
  const pickedRef = useRef<ShareTargetItem | LinkTargetItem | null>(null);
  const isPicked = (candidate: (typeof candidates)[number]) => {
    const picked = pickedRef.current;
    return (
      picked?.type === "link-target" &&
      linkCandidateKey(picked.candidate.ref) === linkCandidateKey(candidate.ref)
    );
  };

  const linkStage = linkActive ? linkCommandStage(trigger.query, candidates) : null;
  const linkTarget =
    linkActive && linkStage?.kind === "group"
      ? parseLinkCommand(trigger.query, candidates).target
      : null;
  const sharedGroupName = (candidate: (typeof candidates)[number]) =>
    threadRef === null
      ? undefined
      : groups.find(
          (group) =>
            group.members.some(
              (member) => linkCandidateKey(member) === linkCandidateKey(threadRef),
            ) &&
            group.members.some(
              (member) => linkCandidateKey(member) === linkCandidateKey(candidate.ref),
            ),
        )?.name;

  const items: ComposerCommandItem[] = shareActive
    ? shareSuggestions({
        query: trigger.query,
        members: memberSearch.members,
        picks,
        signedInUserId,
      }).map((suggestion): ShareTargetItem => ({
        id: `share-target:${suggestion.target.kind}:${suggestion.target.id}`,
        type: "share-target",
        target: suggestion.target,
        label: suggestion.target.label,
        description: shareForTarget(shares, suggestion.target)
          ? `${suggestion.description} · already shared`
          : suggestion.description,
      }))
    : linkStage?.kind === "thread"
      ? linkSuggestions(candidates, linkStage.query).map((candidate): LinkTargetItem => ({
          id: `link-target:${linkCandidateKey(candidate.ref)}`,
          type: "link-target",
          candidate,
          label: candidate.title,
          description:
            sharedGroupName(candidate) ??
            (candidate.kind === "local"
              ? "This environment"
              : `${
                  candidate.kind === "shared"
                    ? (ownerName(candidate.ownerSub) ?? "A colleague")
                    : candidate.environmentLabel
                }${candidate.online ? "" : " · offline"}`),
        }))
      : linkStage?.kind === "group" && threadRef !== null && trigger !== null
        ? linkGroupSuggestions(
            linkTarget === null ? [] : linkGroupsOfEither(groups, threadRef, linkTarget.ref),
            linkStage.query,
          ).map((group): LinkGroupItem => ({
            id: `link-group:${group.linkId}`,
            type: "link-group",
            label: group.name,
            description: `${group.members.length} threads`,
            replaceFrom: trigger.rangeStart + linkStage.start,
          }))
        : [];
  const isLoading = shareActive && memberSearch.query !== shareQuery;
  const emptyState = shareActive
    ? `No one in your organization matches "${trigger.query.trim()}".`
    : linkStage?.kind === "details"
      ? "Optional: its purpose, own: this thread's purpose, group: a group name"
      : linkStage?.kind === "group"
        ? linkStage.query.trim() === ""
          ? "Type a group name"
          : `New group "${linkStage.query.trim()}"`
        : linkActive
          ? candidates.length === 0
            ? "There are no threads to link."
            : "No threads match."
          : null;

  const grantShare = useAtomCommand(serverEnvironment.grantThreadShare, { reportFailure: false });
  const runLinkCommand = useRunLinkCommand();

  const runShare = async (name: string): Promise<boolean> => {
    if (threadRef === null || directory === null) return false;
    const picked = pickedRef.current;
    let target = picked?.type === "share-target" && picked.label === name ? picked.target : null;
    if (target === null) {
      let members = NO_MEMBERS;
      try {
        members = (await directory.searchMembers({ q: name, limit: MEMBER_SEARCH_LIMIT })).members;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not search your organization",
          description: errorMessage(error, "Try again."),
        });
        return false;
      }
      target = resolveShareTarget({ name, members, picks, signedInUserId });
    }
    if (target === null) {
      toastManager.add({
        type: "error",
        title: name === "" ? "Name someone to share with" : `No one named "${name}"`,
        description: "Type /share and pick a colleague, a project, or the whole organization.",
      });
      return false;
    }
    if (shareForTarget(shares, target)) {
      toastManager.add({ type: "info", title: `Already shared with ${target.label}` });
      return true;
    }
    const result = await grantShare({
      environmentId,
      input: quickShareGrant(threadRef.threadId, target),
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return false;
      toastManager.add({
        type: "error",
        title: `Could not share with ${target.label}`,
        description: errorMessage(squashAtomCommandFailure(result), "Try again."),
      });
      return false;
    }
    toastManager.add({
      type: "success",
      title: `Shared with ${target.label}`,
      description:
        target.kind === "organization" && picks.role !== "owner"
          ? "An organization owner approves it first."
          : "As a collaborator; you approve their commands and file changes.",
    });
    return true;
  };

  const runLink = async (args: string): Promise<boolean> => {
    if (threadRef === null) return false;
    const command = parseLinkCommand(args, candidates, isPicked);
    const candidate = command.target;
    if (candidate === null) {
      const name = command.targetName;
      toastManager.add({
        type: "error",
        title: name === "" ? "Name a thread to link" : `No thread named "${name}" to link`,
        description: "Type /link and pick one of the suggested threads.",
      });
      return false;
    }
    return runLinkCommand(threadRef, {
      candidate,
      currentTitle: current?.title,
      currentPurpose: defaultOwnLinkPurpose(current, projects),
      currentShares: shares,
      groups,
      ownerName,
      command: {
        purpose: command.purpose,
        ownPurpose: command.ownPurpose,
        groupName: command.group,
      },
    });
  };

  return {
    shareAvailable,
    linkAvailable,
    /** Drops a `/share` or `/link` trigger the composer does not offer here. */
    allowsTrigger: (candidate: ComposerTrigger | null) =>
      candidate === null ||
      ((candidate.kind !== "share-target" || shareAvailable) &&
        (candidate.kind !== "link-target" || linkAvailable)),
    items,
    isLoading,
    emptyState,
    rememberPick: (item: ShareTargetItem | LinkTargetItem) => {
      pickedRef.current = item;
    },
    /**
     * Runs the message as a team command, or returns null when it is not one (or not offered).
     * Resolves to whether the composer should clear: errors keep the text to correct.
     */
    run: (prompt: string): Promise<boolean> | null => {
      const command = parseComposerTeamCommand(prompt);
      if (command === null) return null;
      if (command.command === "share" && shareAvailable) return runShare(command.name);
      if (command.command === "link" && linkAvailable) return runLink(command.name);
      return null;
    },
  };
}
