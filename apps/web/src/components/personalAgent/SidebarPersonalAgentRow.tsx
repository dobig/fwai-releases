import { useAtomValue } from "@effect/atom-react";
import { requestsAwaitingDecision } from "@t3tools/client-runtime/sharing/personal-agent";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRouter } from "@tanstack/react-router";
import { BotMessageSquareIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { personalAgent } from "~/state/personalAgent";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrganizationDirectory } from "../sharing/colleagues";
import { Badge } from "../ui/badge";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { useAgentRequestsCardStore } from "./AgentRequestsCard";
import { openPersonalAgent } from "./openPersonalAgent";

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "Try again.";

/** The signed-in person's own agent, above their threads (#22), with a quick on/off switch. */
export function SidebarPersonalAgentRow({
  routeThreadKey,
}: {
  readonly routeThreadKey: string | null;
}) {
  const router = useRouter();
  const signedIn = useOrganizationDirectory() !== null;
  const state = useAtomValue(personalAgent.stateValueAtom);
  const toggle = usePersonalAgentToggle();
  if (!signedIn) return null;
  const agent = state.agent;
  const waiting = requestsAwaitingDecision(state.inbox).length;
  const active =
    agent !== null &&
    routeThreadKey === scopedThreadKey(scopeThreadRef(agent.environmentId, agent.threadId));
  return (
    <div
      className={cn(
        "group/agent flex min-h-9 w-full items-center gap-2 rounded-md pr-2 text-sm text-sidebar-foreground hover:bg-sidebar-row-hover",
        active && "bg-sidebar-row-hover",
      )}
    >
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => void openPersonalAgent(router)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 self-stretch py-1 pl-2.5 text-left"
      >
        <BotMessageSquareIcon aria-hidden className="size-4 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">Personal agent</span>
          {agent === null ? (
            <span className="truncate text-2xs text-sidebar-muted-foreground">Off</span>
          ) : null}
        </span>
      </button>
      {waiting > 0 ? (
        <button
          type="button"
          className="cursor-pointer"
          aria-label={`${waiting} requests waiting for you`}
          onClick={() => useAgentRequestsCardStore.getState().toggle("received")}
        >
          <Badge size="sm" variant="info">
            {waiting}
          </Badge>
        </button>
      ) : null}
      <Switch
        size="sm"
        aria-label={agent === null ? "Turn the personal agent on" : "Turn the personal agent off"}
        checked={agent !== null}
        disabled={toggle.busy}
        onCheckedChange={(checked) => void toggle.set(checked)}
      />
    </div>
  );
}

/**
 * Off goes through the relay, so it works from any device. On reuses the agent's last provider and
 * thread in the primary environment; one never set up there opens Settings → Agent instead.
 */
function usePersonalAgentToggle() {
  const router = useRouter();
  const environmentId = usePrimaryEnvironmentId();
  const disable = useAtomCommand(personalAgent.disable, { reportFailure: false });
  const refresh = useAtomCommand(personalAgent.refresh, { reportFailure: false });
  const getState = useAtomCommand(serverEnvironment.getPersonalAgent, { reportFailure: false });
  const setEnabled = useAtomCommand(serverEnvironment.setPersonalAgentEnabled, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);

  const openSettings = (title: string, description?: string) => {
    toastManager.add({ type: "info", title, ...(description ? { description } : {}) });
    void router.navigate({ to: "/settings/agent" });
  };

  const set = async (enabled: boolean) => {
    setBusy(true);
    try {
      if (!enabled) {
        const result = await disable();
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          toastManager.add({
            type: "error",
            title: "Could not turn the agent off",
            description: errorMessage(squashAtomCommandFailure(result)),
          });
        }
        return;
      }
      if (environmentId === null) {
        openSettings("Choose where the agent runs");
        return;
      }
      const current = await getState({ environmentId, input: {} });
      if (current._tag === "Failure") {
        if (!isAtomCommandInterrupted(current)) {
          openSettings("Set up the agent first", errorMessage(squashAtomCommandFailure(current)));
        }
        return;
      }
      if (!current.value.relayLinked || current.value.providerInstanceId === null) {
        openSettings(
          "Set up the agent first",
          current.value.relayLinked
            ? "Choose its provider and what it may read."
            : "Link this environment to fwai Connect first.",
        );
        return;
      }
      const result = await setEnabled({ environmentId, input: { enabled: true } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        openSettings("Could not turn the agent on", errorMessage(squashAtomCommandFailure(result)));
      }
    } finally {
      await refresh();
      setBusy(false);
    }
  };

  return { busy, set };
}
