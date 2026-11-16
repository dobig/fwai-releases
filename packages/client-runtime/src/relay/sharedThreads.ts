import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayOrgShareRequest, RelaySharedThread } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ManagedRelay from "./managedRelay.ts";
import * as SharedThreadEvents from "./sharedThreadEvents.ts";
import { RelayConnectionRegistration, isSharedEnvironmentEntry } from "../connection/catalog.ts";
import * as Connectivity from "../connection/connectivity.ts";
import { mapManagedRelayError } from "../connection/errors.ts";
import type { ConnectionAttemptError } from "../connection/model.ts";
import { RelayConnectionTarget } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import type * as Persistence from "../platform/persistence.ts";

export interface RelaySharedThreadsState {
  readonly threads: ReadonlyArray<RelaySharedThread>;
  /** A list has arrived for the current account, so an empty one means nothing is shared. */
  readonly loaded: boolean;
  readonly refreshing: boolean;
  readonly error: Option.Option<ConnectionAttemptError>;
}

export const EMPTY_RELAY_SHARED_THREADS_STATE: RelaySharedThreadsState = {
  threads: [],
  loaded: false,
  refreshing: false,
  error: Option.none(),
};

export interface OrgShareRequestsState {
  /** Null when the relay says the account decides none (not an org owner); undefined until read. */
  readonly requests: ReadonlyArray<RelayOrgShareRequest> | null | undefined;
  /**
   * Requests the latest read listed for the first time since sign-in. The first read announces
   * none, so reopening the app or reconnecting never repeats an alert.
   */
  readonly arrived: ReadonlyArray<RelayOrgShareRequest>;
}

export const EMPTY_ORG_SHARE_REQUESTS_STATE: OrgShareRequestsState = {
  requests: undefined,
  arrived: [],
};

function isOrgShareNotAuthorized(error: ManagedRelay.ManagedRelayClientError): boolean {
  if (error._tag !== "ManagedRelayRequestFailedError") return false;
  const cause = error.cause as { readonly _tag?: unknown } | undefined;
  return cause?._tag === "RelayOrgShareNotAuthorizedError" || error.status === 403;
}

/**
 * Threads colleagues shared with this account (#20), from `GET /v1/shared-threads`, and for org
 * owners the members' pending whole-organization requests. Opening a thread registers its owner's
 * environment as shared; a refresh that no longer lists an environment removes it again.
 */
export class RelaySharedThreads extends Context.Service<
  RelaySharedThreads,
  {
    readonly state: SubscriptionRef.SubscriptionRef<RelaySharedThreadsState>;
    readonly refresh: Effect.Effect<void>;
    readonly orgRequests: SubscriptionRef.SubscriptionRef<OrgShareRequestsState>;
    /** Re-reads the pending requests, also for an account the relay last refused. */
    readonly refreshOrgRequests: Effect.Effect<void, ManagedRelay.ManagedRelayClientError>;
    /** Grows when the push channel opens or hints that agent requests changed (#22). */
    readonly agentRevision: SubscriptionRef.SubscriptionRef<number>;
    readonly open: (input: {
      readonly environmentId: EnvironmentId;
      readonly label: string;
    }) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/relay/sharedThreads/RelaySharedThreads") {}

/** @public */
export const make = Effect.fn("RelaySharedThreads.make")(function* () {
  const relay = yield* ManagedRelay.ManagedRelayClient;
  const session = yield* ClientCapabilities.CloudSession;
  const connectivity = yield* Connectivity.Connectivity;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const state = yield* SubscriptionRef.make(EMPTY_RELAY_SHARED_THREADS_STATE);
  const refreshLock = yield* Semaphore.make(1);
  const generation = yield* Ref.make(0);
  const orgRequests = yield* SubscriptionRef.make(EMPTY_ORG_SHARE_REQUESTS_STATE);
  const orgRequestsLock = yield* Semaphore.make(1);
  const seenRequestIds = yield* Ref.make<ReadonlySet<string>>(new Set());
  const agentRevision = yield* SubscriptionRef.make(0);
  const bumpAgentRevision = SubscriptionRef.update(agentRevision, (value) => value + 1);

  const removeEndedEnvironments = Effect.fn("RelaySharedThreads.removeEndedEnvironments")(
    function* (threads: ReadonlyArray<RelaySharedThread>) {
      const listed = new Set<string>(threads.map((thread) => thread.environmentId));
      const ended = [...(yield* SubscriptionRef.get(registry.entries)).values()]
        .filter(
          (entry) => isSharedEnvironmentEntry(entry) && !listed.has(entry.target.environmentId),
        )
        .map((entry) => entry.target.environmentId);
      yield* Effect.forEach(
        ended,
        (environmentId) =>
          registry.remove(environmentId).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not remove an environment whose shares ended.", {
                environmentId,
                error,
              }),
            ),
          ),
        { discard: true },
      );
    },
  );

  const refresh = refreshLock
    .withPermits(1)(
      Effect.gen(function* () {
        if ((yield* connectivity.status) === "offline") return;
        const current = yield* Ref.get(generation);
        yield* SubscriptionRef.update(state, (previous) => ({ ...previous, refreshing: true }));
        const token = yield* Effect.result(session.accountToken);
        if (token._tag === "Failure") {
          // Signed out: nothing is shared with nobody.
          if ((yield* Ref.get(generation)) !== current) return;
          yield* SubscriptionRef.set(state, EMPTY_RELAY_SHARED_THREADS_STATE);
          return;
        }
        const result = yield* relay
          .listSharedThreads({ accountToken: token.success })
          .pipe(Effect.mapError(mapManagedRelayError), Effect.result);
        if ((yield* Ref.get(generation)) !== current) return;
        if (result._tag === "Failure") {
          yield* SubscriptionRef.update(state, (previous) => ({
            ...previous,
            refreshing: false,
            error: Option.some(result.failure),
          }));
          return;
        }
        yield* SubscriptionRef.set(state, {
          threads: result.success,
          loaded: true,
          refreshing: false,
          error: Option.none(),
        });
        yield* removeEndedEnvironments(result.success);
      }),
    )
    .pipe(Effect.withSpan("RelaySharedThreads.refresh"));

  /** `whenRefused`: also ask for an account the relay refused before (a hint says it is an owner). */
  const readOrgRequests = (whenRefused: boolean) =>
    orgRequestsLock.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* connectivity.status) === "offline") return;
        const previous = yield* SubscriptionRef.get(orgRequests);
        if (previous.requests === null && !whenRefused) return;
        const current = yield* Ref.get(generation);
        const token = yield* Effect.result(session.accountToken);
        if (token._tag === "Failure") return;
        const requests = yield* relay.listOrgShareRequests({ accountToken: token.success }).pipe(
          Effect.map((list): ReadonlyArray<RelayOrgShareRequest> | null => list),
          Effect.catchIf(isOrgShareNotAuthorized, () => Effect.succeed(null)),
        );
        if ((yield* Ref.get(generation)) !== current) return;
        const seen = yield* Ref.get(seenRequestIds);
        const arrived =
          previous.requests === undefined || requests === null
            ? []
            : requests.filter((request) => !seen.has(request.id));
        yield* Ref.set(
          seenRequestIds,
          new Set([...seen, ...(requests ?? []).map((request) => request.id)]),
        );
        yield* SubscriptionRef.set(orgRequests, { requests, arrived });
      }),
    );
  const refreshOrgRequests = readOrgRequests(true).pipe(
    Effect.withSpan("RelaySharedThreads.refreshOrgRequests"),
  );
  const readOrgRequestsQuietly = (whenRefused: boolean) =>
    readOrgRequests(whenRefused).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not read organization share requests.", { error }),
      ),
    );
  const refreshAll = Effect.all([refresh, readOrgRequestsQuietly(false)], {
    concurrency: "unbounded",
    discard: true,
  });

  const open = Effect.fn("RelaySharedThreads.open")(function* (input: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }) {
    if ((yield* SubscriptionRef.get(registry.entries)).has(input.environmentId)) return;
    yield* registry.register(
      new RelayConnectionRegistration({
        target: new RelayConnectionTarget({
          environmentId: input.environmentId,
          label: input.label,
          shared: true,
        }),
      }),
    );
  });

  // While signed in, the relay's share push channel says when to refresh; a poll backs it up.
  const kicks = yield* Queue.sliding<void>(1);
  const authorizeEvents = Effect.gen(function* () {
    if ((yield* connectivity.status) === "offline") return Option.none<string>();
    const token = yield* Effect.result(session.accountToken);
    if (token._tag === "Failure") return Option.none<string>();
    return Option.some(yield* relay.authorizeSharedThreadEvents({ accountToken: token.success }));
  });
  const scope = yield* Effect.scope;
  const startEvents = SharedThreadEvents.runSharedThreadEvents({
    authorize: authorizeEvents,
    refresh: Effect.andThen(refreshAll, bumpAgentRevision),
    onHint: (type) => {
      switch (type) {
        case "org-share-requests-changed":
          return readOrgRequestsQuietly(true);
        case "agent-requests-changed":
          return bumpAgentRevision;
        case "shares-changed":
          return refresh;
      }
    },
    kicks,
  }).pipe(Effect.forkIn(scope));
  let events = yield* startEvents;

  yield* wakeups.changes.pipe(
    Stream.runForEach((reason) =>
      Effect.gen(function* () {
        if (reason === "credentials-changed") {
          yield* Ref.update(generation, (value) => value + 1);
          yield* SubscriptionRef.set(state, EMPTY_RELAY_SHARED_THREADS_STATE);
          yield* SubscriptionRef.set(orgRequests, EMPTY_ORG_SHARE_REQUESTS_STATE);
          yield* Ref.set(seenRequestIds, new Set());
        }
        // A new account needs its own socket, and one left in the background may be dead.
        if (reason === "credentials-changed" || reason === "application-active-reconnect") {
          yield* Fiber.interrupt(events);
          events = yield* startEvents;
        } else {
          yield* Queue.offer(kicks, undefined);
        }
        if (reason !== "network-changed") {
          yield* refreshAll.pipe(Effect.forkScoped);
          // Agent requests catch up with shares: a hint missed while away is never resent.
          yield* bumpAgentRevision;
        }
      }),
    ),
    Effect.forkScoped,
  );
  yield* connectivity.changes.pipe(
    Stream.filter((status) => status !== "offline"),
    Stream.runForEach(() => Queue.offer(kicks, undefined)),
    Effect.forkScoped,
  );
  yield* Effect.sleep(SharedThreadEvents.FALLBACK_POLL_INTERVAL).pipe(
    Effect.andThen(refreshAll),
    Effect.andThen(bumpAgentRevision),
    Effect.forever,
    Effect.forkScoped,
  );

  return RelaySharedThreads.of({
    state,
    refresh,
    orgRequests,
    refreshOrgRequests,
    agentRevision,
    open,
  });
});

export const layer = Layer.effect(RelaySharedThreads, make());
