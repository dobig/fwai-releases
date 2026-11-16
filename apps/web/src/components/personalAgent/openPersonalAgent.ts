import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AnyRouter } from "@tanstack/react-router";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { personalAgent } from "~/state/personalAgent";
import { buildThreadRouteParams } from "~/threadRoutes";

/** Opens the agent's thread, wherever it runs; without an agent, the settings that turn it on. */
export function openPersonalAgent(router: Pick<AnyRouter, "navigate">): Promise<void> {
  const agent = appAtomRegistry.get(personalAgent.stateValueAtom).agent;
  if (agent === null) return router.navigate({ to: "/settings/agent" });
  return router.navigate({
    to: "/$environmentId/$threadId",
    params: buildThreadRouteParams(scopeThreadRef(agent.environmentId, agent.threadId)),
  });
}
