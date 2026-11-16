import {
  ThreadId,
  type OrchestrationV2DomainEvent,
  type ThreadShare,
  type ThreadShareId,
  type ThreadShareStatus,
} from "@t3tools/contracts";
import type {
  RelayThreadGrantListResponse,
  RelayThreadGrantStatus,
  RelayThreadGrantSyncRequest,
  RelayThreadGrantSyncResponse,
  RelayThreadShareClaim,
} from "@t3tools/contracts/relay";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { readRelayConnection } from "../cloud/config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { makeRelayEnvironmentClient } from "../relay/relayEnvironmentClient.ts";
import { forkParked } from "../serverActivation.ts";
import * as ThreadShareService from "./ThreadShareService.ts";

/** The relay counts an environment online for six minutes after it last reported in. */
const RELAY_GRANT_POLL_INTERVAL = "3 minutes";
const RELAY_TITLE_MAX_LENGTH = 512;

export class RelayGrantSyncError extends Schema.TaggedError<RelayGrantSyncError>()(
  "RelayGrantSyncError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Thread grant sync step '${this.operation}' failed`;
  }
}

const failedTo =
  (operation: string) =>
  (cause: unknown): RelayGrantSyncError =>
    new RelayGrantSyncError({ operation, cause });

export interface RelayGrantClient {
  /** Identifies the link; a new credential means a new link to reconcile from scratch. */
  readonly key: string;
  readonly sync: (
    threadId: ThreadId,
    payload: RelayThreadGrantSyncRequest,
  ) => Effect.Effect<RelayThreadGrantSyncResponse, RelayGrantSyncError>;
  readonly list: Effect.Effect<RelayThreadGrantListResponse, RelayGrantSyncError>;
}

export interface RelayGrantSyncDeps {
  /** Null while fwai Connect is not linked. */
  readonly connect: Effect.Effect<RelayGrantClient | null>;
  /** Threads that have shares here, so a new link learns about shares made while unlinked. */
  readonly listSharedThreadIds: Effect.Effect<ReadonlyArray<ThreadId>>;
  /** Null when the thread is gone, so its grants are removed; fails when it cannot be read. */
  readonly readThread: (
    threadId: ThreadId,
  ) => Effect.Effect<
    { readonly title: string; readonly shares: ReadonlyArray<ThreadShare> } | null,
    RelayGrantSyncError
  >;
  readonly setStatus: (input: {
    readonly threadId: ThreadId;
    readonly shareId: ThreadShareId;
    readonly status: ThreadShareStatus;
  }) => Effect.Effect<void, RelayGrantSyncError>;
  /** Records an invite link acceptance (#58); fails when the link no longer allows it. */
  readonly acceptClaim: (claim: RelayThreadShareClaim) => Effect.Effect<void, RelayGrantSyncError>;
}

/**
 * Keeps the relay's copy of this environment's thread shares (#20) current and applies the
 * statuses the relay decides, such as an org owner approving a whole-organization share.
 * Not safe for concurrent use; the layer runs it through one worker.
 */
export function makeRelayGrantSync(deps: RelayGrantSyncDeps) {
  // Threads the relay holds grants for, and threads whose last push failed.
  const known = new Set<ThreadId>();
  const dirty = new Set<ThreadId>();
  let reconciledKey: string | null = null;

  const apply = Effect.fnUntraced(function* (
    threadId: ThreadId,
    shares: ReadonlyArray<ThreadShare>,
    statuses: ReadonlyArray<RelayThreadGrantStatus>,
  ) {
    for (const { id, status } of statuses) {
      const share = shares.find((candidate) => candidate.id === id);
      if (share === undefined || share.status === status) continue;
      yield* deps.setStatus({ threadId, shareId: id, status }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not record a share status from fwai Connect", {
            threadId,
            cause,
          }),
        ),
      );
    }
  });

  const acceptClaims = Effect.fnUntraced(function* (
    claims: ReadonlyArray<RelayThreadShareClaim> | undefined,
  ) {
    for (const claim of claims ?? []) {
      yield* deps.acceptClaim(claim).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not record an invite link acceptance", {
            threadId: claim.threadId,
            cause,
          }),
        ),
      );
    }
  });

  const pushWith = Effect.fnUntraced(function* (client: RelayGrantClient, threadId: ThreadId) {
    const read = yield* deps.readThread(threadId).pipe(Effect.option);
    if (read._tag === "None") {
      dirty.add(threadId);
      return;
    }
    const thread = read.value;
    // A proposal grants nothing until the owner approves it, so the relay never sees one.
    const shares = (thread?.shares ?? []).filter((share) => share.status !== "proposed");
    const response = yield* client
      .sync(threadId, {
        title: (thread?.title ?? "").slice(0, RELAY_TITLE_MAX_LENGTH),
        shares,
      })
      .pipe(Effect.option);
    if (response._tag === "None") {
      dirty.add(threadId);
      return;
    }
    dirty.delete(threadId);
    if (shares.length > 0) known.add(threadId);
    else known.delete(threadId);
    yield* apply(threadId, shares, response.value.shares);
    yield* acceptClaims(response.value.claims);
  });

  const push = Effect.fn("RelayGrantSync.push")(function* (threadId: ThreadId) {
    const client = yield* deps.connect;
    if (client !== null) yield* pushWith(client, threadId);
  });

  const poll = Effect.fn("RelayGrantSync.poll")(function* () {
    const client = yield* deps.connect;
    if (client === null) return;
    const reconcile = client.key !== reconciledKey;
    // Nothing to learn; the next share change pushes and starts polling again.
    if (!reconcile && known.size === 0 && dirty.size === 0) return;
    const listed = yield* client.list.pipe(Effect.option);
    if (listed._tag === "None") return;
    const byThread = new Map<ThreadId, Array<RelayThreadGrantStatus>>();
    for (const grant of listed.value.grants) {
      byThread.set(grant.threadId, [...(byThread.get(grant.threadId) ?? []), grant]);
    }
    if (reconcile) {
      // Shares may have changed while the relay could not be told; push local state for every
      // thread it holds grants for.
      known.clear();
      const local = yield* deps.listSharedThreadIds;
      for (const threadId of new Set([...byThread.keys(), ...local])) {
        yield* pushWith(client, threadId);
      }
      reconciledKey = client.key;
    } else {
      for (const [threadId, statuses] of byThread) {
        known.add(threadId);
        const thread = yield* deps.readThread(threadId).pipe(Effect.orElseSucceed(() => null));
        yield* apply(threadId, thread?.shares ?? [], statuses);
      }
    }
    yield* acceptClaims(listed.value.claims);
    // A copy: a failed retry re-adds its thread, which would revisit it within this loop.
    for (const threadId of Array.from(dirty)) yield* pushWith(client, threadId);
  });

  /** Whether an event can change what the relay holds for its thread. */
  const affects = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "thread.shares-updated":
        return true;
      case "thread.settled":
      case "thread.archived":
      case "thread.deleted":
      case "thread.metadata-updated":
        return known.has(event.threadId);
      default:
        return false;
    }
  };

  return { push, poll, affects };
}

const connectToRelay = readRelayConnection.pipe(
  Effect.flatMap((connection) =>
    connection === null
      ? Effect.succeed(null)
      : makeRelayEnvironmentClient(connection).pipe(
          Effect.map((client): RelayGrantClient => ({
            key: `${connection.url}\u0000${connection.environmentCredential}`,
            sync: (threadId, payload) =>
              client.server
                .syncThreadGrants({ params: { threadId }, payload })
                .pipe(Effect.timeout("10 seconds"), Effect.mapError(failedTo("sync"))),
            list: client.server
              .listThreadGrants()
              .pipe(Effect.timeout("10 seconds"), Effect.mapError(failedTo("list"))),
          })),
        ),
  ),
);

type SyncItem = { readonly type: "push"; readonly threadId: ThreadId } | { readonly type: "poll" };

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadShares = yield* ThreadShareService.ThreadShareService;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const sql = yield* SqlClient.SqlClient;
    const sync = makeRelayGrantSync({
      listSharedThreadIds: sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE json_array_length(payload_json, '$.shares') > 0
      `.pipe(
        Effect.map((rows) => rows.map((row) => ThreadId.make(row.thread_id))),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not list shared threads", { cause }).pipe(Effect.as([])),
        ),
      ),
      connect: connectToRelay.pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not reach fwai Connect for thread grants", { cause }).pipe(
            Effect.as(null),
          ),
        ),
      ),
      readThread: (threadId) =>
        Effect.all([
          threadShares.list(threadId).pipe(
            Effect.map((listed): ReadonlyArray<ThreadShare> | null => listed.shares),
            Effect.catch((error) =>
              error.reason === "thread_unavailable"
                ? Effect.succeed(null)
                : Effect.fail(failedTo("read_thread")(error)),
            ),
          ),
          threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null)),
        ]).pipe(
          Effect.map(([shares, shell]) =>
            shares === null ? null : { title: shell?.title ?? "", shares },
          ),
        ),
      setStatus: (input) =>
        threadShares.setStatus(input).pipe(Effect.mapError(failedTo("set_status"))),
      acceptClaim: (claim) =>
        threadShares.acceptClaim(claim).pipe(Effect.mapError(failedTo("accept_claim"))),
    });
    const worker = yield* makeDrainableWorker((item: SyncItem) =>
      item.type === "push" ? sync.push(item.threadId) : sync.poll(),
    );
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event) =>
        sync.affects(event)
          ? worker.enqueue({ type: "push", threadId: event.threadId })
          : Effect.void,
      ),
    );
    yield* forkParked(
      worker
        .enqueue({ type: "poll" })
        .pipe(Effect.repeat(Schedule.spaced(RELAY_GRANT_POLL_INTERVAL))),
    );
  }),
);
