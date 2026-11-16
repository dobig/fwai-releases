import { useAtomValue } from "@effect/atom-react";
import { parseAskCommand } from "@t3tools/client-runtime/sharing/personal-agent";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PersonalAgentAskOrigin, ThreadId } from "@t3tools/contracts";
import type { FwaiGatewayOrganizationMember } from "@t3tools/shared/fwaiGateway";
import { useEffect, useRef, useState } from "react";

import type { ComposerTrigger } from "../../composer-logic";
import { useDebouncedValue } from "~/state/queries";
import { personalAgent } from "~/state/personalAgent";
import { serverEnvironment } from "~/state/server";
import { isSharedEnvironmentAtom } from "~/state/sharing";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  useOrganizationDirectory,
  useOrganizationState,
  useSignedInUserId,
} from "../sharing/colleagues";
import { toastManager } from "../ui/toast";
import type { ComposerCommandItem } from "./ComposerCommandMenu";

const SEARCH_DELAY_MS = 150;
const SEARCH_LIMIT = 20;
const NO_MEMBERS: ReadonlyArray<FwaiGatewayOrganizationMember> = [];

type AskTargetItem = Extract<ComposerCommandItem, { type: "ask-target" }>;

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * `/ask <username> <request>` (#22): a people picker from the organization directory, and sending
 * the request to that person's agent instead of to this thread's provider.
 */
export function useComposerAskCommand(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly trigger: ComposerTrigger | null;
  /** Where a reply opens a new thread if this one never starts or is gone. */
  readonly origin: PersonalAgentAskOrigin | null;
}) {
  const { environmentId, threadId, trigger, origin } = input;
  const isShared = useAtomValue(isSharedEnvironmentAtom(environmentId));
  const canAsk = useAtomValue(serverEnvironment.askPersonalAgent.permissionAtom(environmentId));
  const directory = useOrganizationDirectory();
  const organization = useOrganizationState();
  const signedInUserId = useSignedInUserId();
  const available =
    threadId !== null &&
    !isShared &&
    canAsk &&
    directory !== null &&
    organization.status === "ready";
  const active = available && trigger?.kind === "ask-target";

  const query = active ? trigger.query.trim().replace(/^@/u, "") : null;
  const debouncedQuery = useDebouncedValue(query, SEARCH_DELAY_MS);
  const [search, setSearch] = useState<{
    readonly query: string | null;
    readonly members: ReadonlyArray<FwaiGatewayOrganizationMember>;
    readonly askable: ReadonlySet<string>;
  }>({ query: null, members: NO_MEMBERS, askable: new Set() });
  const availability = useAtomCommand(personalAgent.availability, { reportFailure: false });
  // oxlint-disable-next-line t3code/react-effect-budget -- prefix search in the gateway's directory, then ask the relay who has an agent
  useEffect(() => {
    if (directory === null || debouncedQuery === null) return;
    let live = true;
    void (async () => {
      const page = await directory
        .searchMembers({
          ...(debouncedQuery === "" ? {} : { q: debouncedQuery }),
          limit: SEARCH_LIMIT,
        })
        .catch(() => null);
      const members = (page?.members ?? NO_MEMBERS).filter(
        (member) => member.user_id !== signedInUserId,
      );
      const result = await availability(members.map((member) => member.user_id));
      if (!live) return;
      setSearch({
        query: debouncedQuery,
        members,
        askable: new Set(result._tag === "Success" ? result.value : []),
      });
    })();
    return () => {
      live = false;
    };
  }, [directory, debouncedQuery, signedInUserId, availability]);

  const pickedRef = useRef<AskTargetItem | null>(null);
  const items: ComposerCommandItem[] = active
    ? search.members.map((member): AskTargetItem => ({
        id: `ask-target:${member.user_id}`,
        type: "ask-target",
        accountId: member.user_id,
        label: member.username,
        description: search.askable.has(member.user_id)
          ? "Has a personal agent"
          : "Unavailable: no agent",
      }))
    : [];

  const ask = useAtomCommand(serverEnvironment.askPersonalAgent, { reportFailure: false });

  const runAsk = async (username: string, body: string): Promise<boolean> => {
    if (threadId === null || directory === null) return false;
    if (username === "" || body === "") {
      toastManager.add({
        type: "error",
        title: username === "" ? "Name a colleague to ask" : `What do you want to ask ${username}?`,
        description: "Type /ask, a colleague's username, then your request.",
      });
      return false;
    }
    const picked = pickedRef.current;
    let accountId = picked !== null && picked.label === username ? picked.accountId : null;
    if (accountId === null) {
      const page = await directory
        .searchMembers({ q: username, limit: SEARCH_LIMIT })
        .catch(() => null);
      accountId =
        page?.members.find((member) => member.username.toLowerCase() === username.toLowerCase())
          ?.user_id ?? null;
    }
    if (accountId === null) {
      toastManager.add({ type: "error", title: `No one named "${username}" in your organization` });
      return false;
    }
    const result = await ask({
      environmentId,
      input: {
        threadId,
        toAccountId: accountId,
        body,
        ...(origin === null ? {} : { origin }),
      },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return false;
      toastManager.add({
        type: "error",
        title: `Could not ask ${username}'s agent`,
        description: errorMessage(squashAtomCommandFailure(result), "Try again."),
      });
      return false;
    }
    toastManager.add({
      type: "success",
      title: `Asked ${username}'s agent`,
      description: "They approve the answer first. It will show here and wake this thread.",
    });
    return true;
  };

  return {
    available,
    allowsTrigger: (candidate: ComposerTrigger | null) =>
      candidate === null || candidate.kind !== "ask-target" || available,
    items,
    isLoading: active && search.query !== query,
    emptyState: active ? `No one in your organization matches "${trigger.query.trim()}".` : null,
    rememberPick: (item: AskTargetItem) => {
      pickedRef.current = item;
    },
    /** Sends `/ask …` to the colleague's agent; null when the message is not one. */
    run: (prompt: string): Promise<boolean> | null => {
      if (!available) return null;
      const command = parseAskCommand(prompt);
      return command === null ? null : runAsk(command.username, command.body);
    },
  };
}
