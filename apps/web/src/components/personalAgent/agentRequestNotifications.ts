import { requestsAwaitingDecision } from "@t3tools/client-runtime/sharing/personal-agent";
import type { AnyRouter } from "@tanstack/react-router";
import type { AtomRegistry } from "effect/reactivity";

import { personalAgent } from "../../state/personalAgent";
import { toastManager } from "../ui/toast";
import { openPersonalAgent } from "./openPersonalAgent";

/**
 * Tells the person when a request, or a drafted answer after approved work, waits for them (#22).
 * The first list after start-up is what was already waiting, so it is not announced.
 */
export function startAgentRequestNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  let seen: Set<string> | null = null;
  const review = () => void openPersonalAgent(router);
  return registry.subscribe(
    personalAgent.stateValueAtom,
    (state) => {
      if (!state.loaded) return;
      const waiting = requestsAwaitingDecision(state.inbox);
      const keys = new Set(
        waiting.map((request) => `${request.id}:${request.proposal?.proposedAt ?? ""}`),
      );
      const previous = seen;
      seen = keys;
      if (previous === null) return;
      const fresh = [...keys].filter((key) => !previous.has(key)).length;
      if (fresh === 0) return;
      const title =
        fresh === 1
          ? "A request waits for your approval"
          : `${fresh} requests wait for your approval`;
      toastManager.add({
        type: "info",
        title,
        description: "Your personal agent prepared it; nothing is sent until you decide.",
        actionProps: { children: "Review", onClick: review },
      });
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "granted" &&
        typeof document !== "undefined" &&
        document.hidden
      ) {
        const notification = new Notification(title, { tag: "fwai-agent-requests" });
        notification.addEventListener("click", review);
      }
    },
    { immediate: true },
  );
}
