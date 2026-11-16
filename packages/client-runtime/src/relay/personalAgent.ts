import type { AgentDecision, AgentEnvironmentRecord, AgentRequest } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ManagedRelay from "./managedRelay.ts";
import * as RelaySharedThreads from "./sharedThreads.ts";
import * as Connectivity from "../connection/connectivity.ts";
import { mapManagedRelayError } from "../connection/errors.ts";
import type { ConnectionAttemptError } from "../connection/model.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";

export interface RelayPersonalAgentState {
  /** Requests to this account's agent, newest first. */
  readonly inbox: ReadonlyArray<AgentRequest>;
  /** Requests this account sent. */
  readonly outbox: ReadonlyArray<AgentRequest>;
  readonly agent: AgentEnvironmentRecord | null;
  readonly blocked: ReadonlyArray<string>;
  readonly loaded: boolean;
  readonly error: Option.Option<ConnectionAttemptError>;
}

export const EMPTY_RELAY_PERSONAL_AGENT_STATE: RelayPersonalAgentState = {
  inbox: [],
  outbox: [],
  agent: null,
  blocked: [],
  loaded: false,
  error: Option.none(),
};

/**
 * The personal agent inbox (#22) as this account sees it, straight from the relay, so a person
 * can read and decide from any client while their agent environment is offline. The share push
 * channel hints when it changes.
 */
export class RelayPersonalAgent extends Context.Service<
  RelayPersonalAgent,
  {
    readonly state: SubscriptionRef.SubscriptionRef<RelayPersonalAgentState>;
    readonly refresh: Effect.Effect<void>;
    readonly decide: (input: {
      readonly requestId: string;
      readonly decision: AgentDecision;
    }) => Effect.Effect<
      AgentRequest,
      ManagedRelay.ManagedRelayClientError | ConnectionAttemptError
    >;
    readonly cancel: (
      requestId: string,
    ) => Effect.Effect<AgentRequest, ManagedRelay.ManagedRelayClientError | ConnectionAttemptError>;
    readonly setBlocked: (input: {
      readonly accountId: string;
      readonly blocked: boolean;
    }) => Effect.Effect<void, ManagedRelay.ManagedRelayClientError | ConnectionAttemptError>;
    readonly disable: Effect.Effect<
      void,
      ManagedRelay.ManagedRelayClientError | ConnectionAttemptError
    >;
    /** Colleagues who can be asked: same organization, an agent, not blocking this account. */
    readonly availability: (
      accountIds: ReadonlyArray<string>,
    ) => Effect.Effect<
      ReadonlyArray<string>,
      ManagedRelay.ManagedRelayClientError | ConnectionAttemptError
    >;
  }
>()("@t3tools/client-runtime/relay/personalAgent/RelayPersonalAgent") {}

/** Replaces one request in the lists it appears in. */
function withRequest(
  state: RelayPersonalAgentState,
  request: AgentRequest,
): RelayPersonalAgentState {
  const swap = (list: ReadonlyArray<AgentRequest>) =>
    list.some((entry) => entry.id === request.id)
      ? list.map((entry) => (entry.id === request.id ? request : entry))
      : list;
  return { ...state, inbox: swap(state.inbox), outbox: swap(state.outbox) };
}

const make = Effect.fn("RelayPersonalAgent.make")(function* () {
  const relay = yield* ManagedRelay.ManagedRelayClient;
  const session = yield* ClientCapabilities.CloudSession;
  const connectivity = yield* Connectivity.Connectivity;
  const shared = yield* RelaySharedThreads.RelaySharedThreads;
  const state = yield* SubscriptionRef.make(EMPTY_RELAY_PERSONAL_AGENT_STATE);
  const lock = yield* Semaphore.make(1);
  const accountToken = session.accountToken;

  const refresh = lock
    .withPermits(1)(
      Effect.gen(function* () {
        if ((yield* connectivity.status) === "offline") return;
        const token = yield* Effect.result(accountToken);
        if (token._tag === "Failure") {
          yield* SubscriptionRef.set(state, EMPTY_RELAY_PERSONAL_AGENT_STATE);
          return;
        }
        const result = yield* Effect.all([
          relay.listAgentRequests({ accountToken: token.success }),
          relay.getAgent({ accountToken: token.success }),
        ]).pipe(Effect.mapError(mapManagedRelayError), Effect.result);
        if (result._tag === "Failure") {
          yield* SubscriptionRef.update(state, (previous) => ({
            ...previous,
            error: Option.some(result.failure),
          }));
          return;
        }
        const [requests, agent] = result.success;
        yield* SubscriptionRef.set(state, {
          inbox: requests.inbox,
          outbox: requests.outbox,
          agent: agent.agent,
          blocked: agent.blocked,
          loaded: true,
          error: Option.none(),
        });
      }),
    )
    .pipe(Effect.withSpan("RelayPersonalAgent.refresh"));

  const decide: RelayPersonalAgent["Service"]["decide"] = Effect.fn("RelayPersonalAgent.decide")(
    function* (input) {
      const request = yield* relay.decideAgentRequest({
        accountToken: yield* accountToken,
        ...input,
      });
      yield* SubscriptionRef.update(state, (current) => withRequest(current, request));
      return request;
    },
  );

  const cancel: RelayPersonalAgent["Service"]["cancel"] = Effect.fn("RelayPersonalAgent.cancel")(
    function* (requestId) {
      const request = yield* relay.cancelAgentRequest({
        accountToken: yield* accountToken,
        requestId,
      });
      yield* SubscriptionRef.update(state, (current) => withRequest(current, request));
      return request;
    },
  );

  const setBlocked: RelayPersonalAgent["Service"]["setBlocked"] = Effect.fn(
    "RelayPersonalAgent.setBlocked",
  )(function* (input) {
    const response = yield* relay.setAgentBlocked({
      accountToken: yield* accountToken,
      ...input,
    });
    yield* SubscriptionRef.update(state, (current) => ({ ...current, blocked: response.blocked }));
  });

  const disable: RelayPersonalAgent["Service"]["disable"] = Effect.gen(function* () {
    const response = yield* relay.disableAgent({ accountToken: yield* accountToken });
    yield* SubscriptionRef.update(state, (current) => ({ ...current, agent: response.agent }));
  }).pipe(Effect.withSpan("RelayPersonalAgent.disable"));

  const availability: RelayPersonalAgent["Service"]["availability"] = Effect.fn(
    "RelayPersonalAgent.availability",
  )(function* (accountIds) {
    if (accountIds.length === 0) return [];
    return yield* relay.agentAvailability({ accountToken: yield* accountToken, accountIds });
  });

  yield* SubscriptionRef.changes(shared.agentRevision).pipe(
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );

  return RelayPersonalAgent.of({
    state,
    refresh,
    decide,
    cancel,
    setBlocked,
    disable,
    availability,
  });
});

export const layer = Layer.effect(RelayPersonalAgent, make());
