import type { AgentDecision } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import * as RelayPersonalAgent from "../relay/personalAgent.ts";
import { createRuntimeCommand } from "./runtime.ts";

/** Personal agent inbox and requests (#22), shared by web and mobile. */
export function createPersonalAgentAtoms<R, E>(
  runtime: Atom.AtomRuntime<RelayPersonalAgent.RelayPersonalAgent | R, E>,
) {
  const stateAtom = runtime.atom(
    Stream.unwrap(
      RelayPersonalAgent.RelayPersonalAgent.pipe(
        Effect.map((service) => SubscriptionRef.changes(service.state)),
      ),
    ),
    { initialValue: RelayPersonalAgent.EMPTY_RELAY_PERSONAL_AGENT_STATE },
  );
  const stateValueAtom = Atom.make((get) =>
    Option.getOrElse(
      AsyncResult.value(get(stateAtom)),
      () => RelayPersonalAgent.EMPTY_RELAY_PERSONAL_AGENT_STATE,
    ),
  ).pipe(Atom.withLabel("personal-agent-state"));
  const withService = <A, Err>(
    run: (service: RelayPersonalAgent.RelayPersonalAgent["Service"]) => Effect.Effect<A, Err>,
  ) => RelayPersonalAgent.RelayPersonalAgent.pipe(Effect.flatMap(run));

  return {
    stateAtom,
    stateValueAtom,
    refresh: createRuntimeCommand(runtime, {
      label: "personal-agent:refresh",
      concurrency: { mode: "singleFlight", key: () => "refresh" },
      execute: (_input: void) => withService((service) => service.refresh),
    }),
    decide: createRuntimeCommand(runtime, {
      label: "personal-agent:decide",
      concurrency: { mode: "serial", key: (input) => input.requestId },
      execute: (input: { readonly requestId: string; readonly decision: AgentDecision }) =>
        withService((service) => service.decide(input)),
    }),
    cancel: createRuntimeCommand(runtime, {
      label: "personal-agent:cancel",
      execute: (requestId: string) => withService((service) => service.cancel(requestId)),
    }),
    setBlocked: createRuntimeCommand(runtime, {
      label: "personal-agent:set-blocked",
      execute: (input: { readonly accountId: string; readonly blocked: boolean }) =>
        withService((service) => service.setBlocked(input)),
    }),
    disable: createRuntimeCommand(runtime, {
      label: "personal-agent:disable",
      execute: (_input: void) => withService((service) => service.disable),
    }),
    availability: createRuntimeCommand(runtime, {
      label: "personal-agent:availability",
      execute: (accountIds: ReadonlyArray<string>) =>
        withService((service) => service.availability(accountIds)),
    }),
  };
}
