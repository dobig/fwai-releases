import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { RuntimePolicyResolveError, RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import {
  isRequestThreadId,
  personalAgentRuntimePolicy,
  requestIdOfThread,
} from "./personalAgentPolicy.ts";
import * as PersonalAgentScope from "./PersonalAgentScope.ts";
import * as PersonalAgentStore from "./PersonalAgentStore.ts";

/**
 * Every turn of the personal agent thread runs read-only (#22): the provider runtime enforces it,
 * whatever the thread's own mode says. A provider that cannot enforce it does not start the turn.
 * The old thread keeps the policy after the agent moves or is turned off.
 */
export const layer = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicyV2;
    const store = yield* PersonalAgentStore.PersonalAgentStore;
    const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const scope = yield* PersonalAgentScope.PersonalAgentScope;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("PersonalAgentRuntimePolicy.resolve")(function* (input) {
        const config = yield* store.get;
        // The agent window has its owner's authority; only a colleague's request runs locked (#45).
        if (!isRequestThreadId(input.thread.id)) return yield* base.resolve(input);
        const instance = yield* registry.getInstance(input.modelSelection.instanceId);
        const policy =
          instance === undefined || config.directory === null
            ? null
            : personalAgentRuntimePolicy({
                driver: instance.driverKind,
                agentDirectory: config.directory,
                readableRoots: yield* scope.readableRoots(
                  config.permissions,
                  config.requestScopes.find(
                    (entry) => entry.requestId === requestIdOfThread(input.thread.id),
                  )?.needs ?? [],
                ),
                homeDirectory: NodeOS.homedir(),
              });
        if (policy === null) {
          return yield* new RuntimePolicyResolveError({
            projectId: input.thread.projectId,
            providerInstanceId: input.modelSelection.instanceId,
            cause:
              "This provider cannot enforce read-only triage, so it cannot run the personal agent.",
          });
        }
        return policy;
      }),
    });
  }),
);
