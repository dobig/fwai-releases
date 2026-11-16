import { AgentRequestId, type AgentProposal } from "@t3tools/contracts";
import type {
  RelayAgentColleaguesResponse,
  RelayAgentCreateRequest,
  RelayAgentCreateResponse,
  RelayAgentEnableRequest,
  RelayAgentPriorRequestsResponse,
  RelayAgentExecutionRequest,
  RelayAgentRuleDecisionRequest,
  RelayAgentRecordResponse,
  RelayAgentRequestResponse,
  RelayAgentSyncResponse,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { readRelayConnection } from "../cloud/config.ts";
import { makeRelayEnvironmentClient } from "../relay/relayEnvironmentClient.ts";

/**
 * This environment's side of the personal agent inbox (#22), spoken with the environment
 * credential. Every call yields null while fwai Connect is not linked or cannot be reached.
 */
export class PersonalAgentRelay extends Context.Service<
  PersonalAgentRelay,
  {
    readonly setAgent: (
      request: RelayAgentEnableRequest,
    ) => Effect.Effect<RelayAgentRecordResponse | null>;
    readonly create: (
      request: RelayAgentCreateRequest,
    ) => Effect.Effect<RelayAgentCreateResponse | null>;
    readonly sync: Effect.Effect<RelayAgentSyncResponse | null>;
    readonly colleagues: Effect.Effect<RelayAgentColleaguesResponse | null>;
    /** The same sender's earlier, settled requests before `id`; the relay picks them. */
    readonly prior: (id: string) => Effect.Effect<RelayAgentPriorRequestsResponse | null>;
    readonly propose: (
      id: string,
      proposal: AgentProposal,
    ) => Effect.Effect<RelayAgentRequestResponse | null>;
    readonly reportExecution: (
      id: string,
      report: RelayAgentExecutionRequest,
    ) => Effect.Effect<RelayAgentRequestResponse | null>;
    /** Accepts for the owner what their grants set to auto (#45). */
    readonly decideByRules: (
      id: string,
      decision: RelayAgentRuleDecisionRequest,
    ) => Effect.Effect<RelayAgentRequestResponse | null>;
  }
>()("t3/personalAgent/PersonalAgentRelay") {}

export const layer = Layer.effect(
  PersonalAgentRelay,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const client = readRelayConnection.pipe(
      Effect.flatMap((connection) =>
        connection === null ? Effect.succeed(null) : makeRelayEnvironmentClient(connection),
      ),
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    );
    const call = <A, E>(
      operation: string,
      run: (relay: NonNullable<Effect.Success<typeof client>>) => Effect.Effect<A, E>,
    ): Effect.Effect<A | null> =>
      client.pipe(
        Effect.flatMap((relay) => (relay === null ? Effect.succeed(null) : run(relay))),
        Effect.timeout("15 seconds"),
        Effect.catchCause((cause) =>
          Effect.logWarning("fwai Connect did not take a personal agent call", {
            operation,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
    return PersonalAgentRelay.of({
      setAgent: Effect.fn("PersonalAgentRelay.setAgent")((payload) =>
        call("setAgent", (relay) => relay.server.setAgentEnvironment({ payload })),
      ),
      create: Effect.fn("PersonalAgentRelay.create")((payload) =>
        call("create", (relay) => relay.server.createAgentRequest({ payload })),
      ),
      sync: call("sync", (relay) => relay.server.syncAgentRequests()).pipe(
        Effect.withSpan("PersonalAgentRelay.sync"),
      ),
      colleagues: call("colleagues", (relay) => relay.server.listAgentColleagues()).pipe(
        Effect.withSpan("PersonalAgentRelay.colleagues"),
      ),
      prior: Effect.fn("PersonalAgentRelay.prior")((id) =>
        call("prior", (relay) =>
          relay.server.listPriorAgentRequests({ params: { id: AgentRequestId.make(id) } }),
        ),
      ),
      propose: Effect.fn("PersonalAgentRelay.propose")((id, proposal) =>
        call("propose", (relay) =>
          relay.server.proposeAgentRequest({
            params: { id: AgentRequestId.make(id) },
            payload: { proposal },
          }),
        ),
      ),
      decideByRules: Effect.fn("PersonalAgentRelay.decideByRules")((id, payload) =>
        call("decideByRules", (relay) =>
          relay.server.decideAgentRequestByRules({
            params: { id: AgentRequestId.make(id) },
            payload,
          }),
        ),
      ),
      reportExecution: Effect.fn("PersonalAgentRelay.reportExecution")((id, payload) =>
        call("reportExecution", (relay) =>
          relay.server.reportAgentExecution({ params: { id: AgentRequestId.make(id) }, payload }),
        ),
      ),
    });
  }),
);
