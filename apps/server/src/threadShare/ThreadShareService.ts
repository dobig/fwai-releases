import {
  CommandId,
  THREAD_SHARE_LINK_EXPIRY_DAYS,
  ThreadShareError,
  ThreadShareId,
  type ThreadShare,
  type ThreadShareDecideInput,
  type ThreadShareGrantInput,
  type ThreadShareLinkCreateInput,
  type ThreadShareLinkCreateResult,
  type ThreadShareResult,
  type ThreadShareRevokeInput,
  type ThreadShareStatus,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { RelayThreadShareClaim } from "@t3tools/contracts/relay";
import { createThreadInviteToken } from "@t3tools/shared/threadInvites";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { THREAD_SHARE_FAILURE } from "../orchestration-v2/ThreadShareDecider.ts";

/** Grants, revokes and lists a thread's shares (#20). Callers check that the caller owns it. */
export class ThreadShareService extends Context.Service<
  ThreadShareService,
  {
    /** A person shares now; an agent only proposes, and the owner decides (#23). */
    readonly grant: (
      input: ThreadShareGrantInput,
      options?: { readonly proposedByAgent?: boolean },
    ) => Effect.Effect<ThreadShareResult, ThreadShareError>;
    /** The owner approves a proposed share, which then takes effect, or rejects it. */
    readonly decide: (
      input: ThreadShareDecideInput,
    ) => Effect.Effect<ThreadShareResult, ThreadShareError>;
    /** Revoking a link with `removeJoined` also removes everyone who joined through it. */
    readonly revoke: (
      input: ThreadShareRevokeInput,
    ) => Effect.Effect<ThreadShareResult, ThreadShareError>;
    /** An invite link (#58); only the owner creates one, never an agent. */
    readonly createLink: (
      input: ThreadShareLinkCreateInput,
    ) => Effect.Effect<ThreadShareLinkCreateResult, ThreadShareError>;
    /**
     * Records that someone accepted an invite link, as the relay reported it. Succeeds when they
     * already have the share; fails with `link_closed` when the link no longer allows it.
     */
    readonly acceptClaim: (claim: RelayThreadShareClaim) => Effect.Effect<void, ThreadShareError>;
    readonly list: (threadId: ThreadId) => Effect.Effect<ThreadShareResult, ThreadShareError>;
    /** Records the relay's decision on a share, such as an org owner approving it. */
    readonly setStatus: (input: {
      readonly threadId: ThreadId;
      readonly shareId: ThreadShareId;
      readonly status: ThreadShareStatus;
    }) => Effect.Effect<void, ThreadShareError>;
  }
>()("t3/threadShare/ThreadShareService") {}

const failureReasons = new Set<string>(Object.values(THREAD_SHARE_FAILURE));

// Until the relay confirms the owner may share with the whole organization.
const grantedStatus = (kind: ThreadShare["target"]["kind"]): ThreadShare["status"] =>
  kind === "organization" ? "pending_approval" : "active";

const toShareError = (error: unknown) => {
  const cause =
    typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  return new ThreadShareError({
    reason:
      typeof cause === "string" && failureReasons.has(cause)
        ? (cause as ThreadShareError["reason"])
        : "thread_unavailable",
  });
};

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const crypto = yield* Crypto.Crypto;

  const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);
  const commandId = (label: string) =>
    Effect.map(uuid, (id) => CommandId.make(`server:thread-share:${label}:${id}`));

  const list = Effect.fn("ThreadShareService.list")(function* (threadId: ThreadId) {
    const { thread } = yield* orchestrator
      .getThreadRecords(threadId, [])
      .pipe(Effect.mapError(() => new ThreadShareError({ reason: "read_failed" })));
    if (thread.deletedAt !== null) {
      return yield* new ThreadShareError({ reason: "thread_unavailable" });
    }
    return { shares: thread.shares ?? [] } satisfies ThreadShareResult;
  });

  const grant = Effect.fn("ThreadShareService.grant")(function* (
    input: ThreadShareGrantInput,
    options?: { readonly proposedByAgent?: boolean },
  ) {
    if (input.target.kind === "link") {
      return yield* new ThreadShareError({ reason: "thread_unavailable" });
    }
    const now = yield* DateTime.now;
    const share: ThreadShare = {
      id: ThreadShareId.make(`share:${yield* uuid}`),
      target: input.target,
      role: input.role,
      requireApproval: input.role === "collaborator" ? (input.requireApproval ?? true) : false,
      status: options?.proposedByAgent === true ? "proposed" : grantedStatus(input.target.kind),
      grantedAt: DateTime.formatIso(now),
    };
    yield* orchestrator
      .dispatch({
        type: "thread.share.grant",
        commandId: yield* commandId("grant"),
        threadId: input.threadId,
        share,
      })
      .pipe(Effect.mapError(toShareError));
    return yield* list(input.threadId);
  });

  const revokeOne = Effect.fn("ThreadShareService.revokeOne")(function* (
    threadId: ThreadId,
    shareId: ThreadShareId,
  ) {
    yield* orchestrator
      .dispatch({
        type: "thread.share.revoke",
        commandId: yield* commandId("revoke"),
        threadId,
        shareId,
      })
      .pipe(Effect.mapError(toShareError));
  });

  const revoke = Effect.fn("ThreadShareService.revoke")(function* (input: ThreadShareRevokeInput) {
    const joined =
      input.removeJoined === true
        ? (yield* list(input.threadId)).shares.filter((share) => share.viaShareId === input.shareId)
        : [];
    yield* revokeOne(input.threadId, input.shareId);
    for (const share of joined) yield* revokeOne(input.threadId, share.id);
    return yield* list(input.threadId);
  });

  const createLink = Effect.fn("ThreadShareService.createLink")(function* (
    input: ThreadShareLinkCreateInput,
  ) {
    const now = yield* DateTime.now;
    const { token, hash } = yield* createThreadInviteToken().pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.orDie,
    );
    const share: ThreadShare = {
      id: ThreadShareId.make(`share:${yield* uuid}`),
      target: { kind: "link", id: hash, label: "" },
      role: input.role,
      requireApproval: input.role === "collaborator" ? (input.requireApproval ?? true) : false,
      status: "active",
      grantedAt: DateTime.formatIso(now),
      link: {
        mode: input.mode,
        expiresAt: DateTime.formatIso(
          DateTime.add(now, { days: THREAD_SHARE_LINK_EXPIRY_DAYS[input.expiresIn] }),
        ),
      },
    };
    yield* orchestrator
      .dispatch({
        type: "thread.share.grant",
        commandId: yield* commandId("link"),
        threadId: input.threadId,
        share,
      })
      .pipe(Effect.mapError(toShareError));
    return { ...(yield* list(input.threadId)), shareId: share.id, token };
  });

  const acceptClaim = Effect.fn("ThreadShareService.acceptClaim")(function* (
    claim: RelayThreadShareClaim,
  ) {
    const { shares } = yield* list(claim.threadId);
    if (shares.some((share) => share.id === claim.shareId)) return;
    const link = shares.find((share) => share.id === claim.linkShareId);
    if (link === undefined) return yield* new ThreadShareError({ reason: "link_closed" });
    yield* orchestrator
      .dispatch({
        type: "thread.share.grant",
        commandId: yield* commandId("claim"),
        threadId: claim.threadId,
        share: {
          id: ThreadShareId.make(claim.shareId),
          target: { kind: "account", id: claim.accountId, label: claim.username },
          role: link.role,
          requireApproval: link.requireApproval,
          status: "active",
          grantedAt: claim.claimedAt,
          viaShareId: link.id,
        },
      })
      .pipe(
        Effect.mapError(toShareError),
        // They already hold a share of their own; it gives them access.
        Effect.catchIf(
          (error) => error.reason === "duplicate",
          () => Effect.void,
        ),
      );
  });

  const decide = Effect.fn("ThreadShareService.decide")(function* (input: ThreadShareDecideInput) {
    const { shares } = yield* list(input.threadId);
    const share = shares.find((candidate) => candidate.id === input.shareId);
    if (share === undefined) return yield* new ThreadShareError({ reason: "not_found" });
    if (share.status !== "proposed") return yield* new ThreadShareError({ reason: "not_proposed" });
    if (!input.approve) return yield* revoke({ threadId: input.threadId, shareId: share.id });
    yield* setStatus({
      threadId: input.threadId,
      shareId: share.id,
      status: grantedStatus(share.target.kind),
    });
    return yield* list(input.threadId);
  });

  const setStatus: ThreadShareService["Service"]["setStatus"] = Effect.fn(
    "ThreadShareService.setStatus",
  )(function* (input) {
    yield* orchestrator
      .dispatch({
        type: "thread.share.status.set",
        commandId: yield* commandId("status"),
        threadId: input.threadId,
        shareId: input.shareId,
        status: input.status,
      })
      .pipe(Effect.mapError(toShareError));
  });

  return ThreadShareService.of({
    grant,
    decide,
    revoke,
    createLink,
    acceptClaim,
    list,
    setStatus,
  });
});

export const layer = Layer.effect(ThreadShareService, make);
