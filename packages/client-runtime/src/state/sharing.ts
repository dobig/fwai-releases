import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RelaySharedThreads from "../relay/sharedThreads.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import { groupSharedThreads, withoutRemovedThreads } from "../sharing/sharedThreads.ts";
import { createRuntimeCommand } from "./runtime.ts";

export interface SharedThreadAtomsOptions {
  /**
   * Threads the owner's environment removed since its last snapshot, when this client is
   * connected to it; undefined otherwise. Read only for environments opened as shared.
   */
  readonly removedThreads?: (
    get: Atom.AtomContext,
    environmentId: EnvironmentId,
  ) => ReadonlyMap<ThreadId, number> | undefined;
}

export function createSharedThreadAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    | RelaySharedThreads.RelaySharedThreads
    | ManagedRelay.ManagedRelayClient
    | ClientCapabilities.CloudSession
    | R,
    E
  >,
  options: SharedThreadAtomsOptions = {},
) {
  const stateAtom = runtime.atom(
    Stream.unwrap(
      RelaySharedThreads.RelaySharedThreads.pipe(
        Effect.map((service) => SubscriptionRef.changes(service.state)),
      ),
    ),
    { initialValue: RelaySharedThreads.EMPTY_RELAY_SHARED_THREADS_STATE },
  );
  const removedThreads = options.removedThreads;
  const stateValueAtom = Atom.make((get) => {
    const state = Option.getOrElse(
      AsyncResult.value(get(stateAtom)),
      () => RelaySharedThreads.EMPTY_RELAY_SHARED_THREADS_STATE,
    );
    if (removedThreads === undefined) return state;
    const threads = withoutRemovedThreads(state.threads, (environmentId) =>
      removedThreads(get, environmentId),
    );
    return threads === state.threads ? state : { ...state, threads };
  }).pipe(Atom.withLabel("relay-shared-threads-value"));
  const groupsAtom = Atom.map(stateValueAtom, (state) => groupSharedThreads(state.threads)).pipe(
    Atom.withLabel("relay-shared-thread-groups"),
  );
  const refresh = createRuntimeCommand(runtime, {
    label: "relay-shared-threads:refresh",
    concurrency: { mode: "singleFlight", key: () => "refresh" },
    execute: (_input: void) =>
      RelaySharedThreads.RelaySharedThreads.pipe(Effect.flatMap((service) => service.refresh)),
  });
  const open = createRuntimeCommand(runtime, {
    label: "relay-shared-threads:open",
    concurrency: { mode: "serial", key: () => "open" },
    execute: (input: { readonly environmentId: EnvironmentId; readonly label: string }) =>
      RelaySharedThreads.RelaySharedThreads.pipe(Effect.flatMap((service) => service.open(input))),
  });

  const orgShareRequestsAtom = runtime.atom(
    Stream.unwrap(
      RelaySharedThreads.RelaySharedThreads.pipe(
        Effect.map((service) => SubscriptionRef.changes(service.orgRequests)),
      ),
    ),
    { initialValue: RelaySharedThreads.EMPTY_ORG_SHARE_REQUESTS_STATE },
  );
  /** Members' pending whole-organization shares; null for accounts that are not org owners. */
  const orgShareRequestsValueAtom = Atom.make((get) =>
    Option.getOrElse(
      AsyncResult.value(get(orgShareRequestsAtom)),
      () => RelaySharedThreads.EMPTY_ORG_SHARE_REQUESTS_STATE,
    ),
  ).pipe(Atom.withLabel("relay-org-share-requests-value"));
  const pendingOrgShareRequestCountAtom = Atom.map(
    orgShareRequestsValueAtom,
    (state) => state.requests?.length ?? 0,
  ).pipe(Atom.withLabel("relay-org-share-requests-count"));
  const refreshOrgShareRequests = createRuntimeCommand(runtime, {
    label: "relay-org-share-requests:refresh",
    concurrency: { mode: "singleFlight", key: () => "refresh" },
    execute: (_input: void) =>
      RelaySharedThreads.RelaySharedThreads.pipe(
        Effect.flatMap((service) => service.refreshOrgRequests),
      ),
  });

  const accountToken = ClientCapabilities.CloudSession.pipe(
    Effect.flatMap((session) => session.accountToken),
  );
  const decideOrgShareRequest = createRuntimeCommand(runtime, {
    label: "relay-org-share-requests:decide",
    execute: Effect.fn("relayOrgShareRequests.decide")(function* (input: {
      readonly requestId: string;
      readonly decision: "approve" | "reject";
    }) {
      const relay = yield* ManagedRelay.ManagedRelayClient;
      const token = yield* accountToken;
      return yield* relay.decideOrgShareRequest({ accountToken: token, ...input });
    }),
  });

  /** Invite links (#58): null when the link does not work, whatever the reason. */
  const previewInvite = createRuntimeCommand(runtime, {
    label: "relay-thread-invites:preview",
    execute: Effect.fn("relayThreadInvites.preview")(function* (input: { readonly token: string }) {
      const relay = yield* ManagedRelay.ManagedRelayClient;
      return yield* relay.previewThreadInvite({ accountToken: yield* accountToken, ...input });
    }),
  });
  /** Joins through an invite link, then lists and opens the owner's environment. */
  const acceptInvite = createRuntimeCommand(runtime, {
    label: "relay-thread-invites:accept",
    concurrency: { mode: "serial", key: () => "accept" },
    execute: Effect.fn("relayThreadInvites.accept")(function* (input: {
      readonly token: string;
      /** Names the owner's environment in this client. */
      readonly label: string;
    }) {
      const relay = yield* ManagedRelay.ManagedRelayClient;
      const accepted = yield* relay.acceptThreadInvite({
        accountToken: yield* accountToken,
        token: input.token,
      });
      if (accepted === null || accepted.own) return accepted;
      const service = yield* RelaySharedThreads.RelaySharedThreads;
      yield* service.refresh;
      yield* service.open({ environmentId: accepted.environmentId, label: input.label });
      return accepted;
    }),
  });

  return {
    stateAtom,
    stateValueAtom,
    groupsAtom,
    refresh,
    open,
    previewInvite,
    acceptInvite,
    orgShareRequestsValueAtom,
    pendingOrgShareRequestCountAtom,
    refreshOrgShareRequests,
    decideOrgShareRequest,
  };
}
