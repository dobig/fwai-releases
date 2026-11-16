import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, ThreadShareId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A thread share lets people in the owner's gateway organization open the thread from their own
 * fwai (#20). The thread keeps running on the owner's environment, which decides every access;
 * the relay checks who may share with whom and admits connections.
 */
export const THREAD_SHARE_LIMIT = 50;

/**
 * `link` is an invite link (#58): it names nobody, and each account that accepts it gets an
 * `account` share pointing back at it through `viaShareId`.
 */
export const ThreadShareTargetKind = Schema.Literals([
  "account",
  "project",
  "organization",
  "link",
]);
export type ThreadShareTargetKind = typeof ThreadShareTargetKind.Type;

export const ThreadShareTarget = Schema.Struct({
  kind: ThreadShareTargetKind,
  /** A gateway user id, project id or organization id; for a link, the SHA-256 of its token. */
  id: TrimmedNonEmptyString,
  /** Username or project/organization name as the owner saw it when sharing. */
  label: Schema.String,
});
export type ThreadShareTarget = typeof ThreadShareTarget.Type;

export const ThreadShareRole = Schema.Literals(["viewer", "collaborator"]);
export type ThreadShareRole = typeof ThreadShareRole.Type;

/**
 * `proposed`: an agent asked to share; nothing is granted until the owner approves (#23).
 * `pending_approval`: a member's whole-organization share an org owner has not approved yet.
 */
export const ThreadShareStatus = Schema.Literals([
  "proposed",
  "active",
  "pending_approval",
  "rejected",
]);
export type ThreadShareStatus = typeof ThreadShareStatus.Type;

export const ThreadShareLinkMode = Schema.Literals(["single", "multi"]);
export type ThreadShareLinkMode = typeof ThreadShareLinkMode.Type;

export const ThreadShareLink = Schema.Struct({
  /** `single`: the first account to accept it joins and it closes; `multi`: anyone may join. */
  mode: ThreadShareLinkMode,
  /** Nobody new joins after this; people who joined keep their shares. */
  expiresAt: IsoDateTime,
  /** When a `single` link was accepted. */
  closedAt: Schema.optional(IsoDateTime),
});
export type ThreadShareLink = typeof ThreadShareLink.Type;

export const ThreadShare = Schema.Struct({
  id: ThreadShareId,
  target: ThreadShareTarget,
  role: ThreadShareRole,
  /** Commands and file changes a collaborator's messages lead to wait for the owner. */
  requireApproval: Schema.Boolean,
  status: ThreadShareStatus,
  grantedAt: IsoDateTime,
  /** Set only on a `link` share. */
  link: Schema.optional(ThreadShareLink),
  /** The link an `account` share's person joined through. */
  viaShareId: Schema.optional(ThreadShareId),
});
export type ThreadShare = typeof ThreadShare.Type;

/** Whether a link share still lets someone new join. */
export function isThreadShareLinkOpen(share: ThreadShare, now: Date | string): boolean {
  if (share.target.kind !== "link" || share.link === undefined || share.status !== "active") {
    return false;
  }
  if (share.link.closedAt !== undefined) return false;
  return (
    Date.parse(share.link.expiresAt) > (typeof now === "string" ? Date.parse(now) : now.getTime())
  );
}

/** Shares that grant access now. */
export const activeThreadShares = (
  shares: ReadonlyArray<ThreadShare> | null | undefined,
): ReadonlyArray<ThreadShare> => shares?.filter((share) => share.status === "active") ?? [];

export const ThreadShareGrantInput = Schema.Struct({
  threadId: ThreadId,
  target: ThreadShareTarget,
  role: ThreadShareRole,
  requireApproval: Schema.optional(Schema.Boolean),
});
export type ThreadShareGrantInput = typeof ThreadShareGrantInput.Type;

export const ThreadShareRevokeInput = Schema.Struct({
  threadId: ThreadId,
  shareId: ThreadShareId,
  /** Revoking a link also removes everyone who joined through it. */
  removeJoined: Schema.optional(Schema.Boolean),
});
export type ThreadShareRevokeInput = typeof ThreadShareRevokeInput.Type;

/** The owner approves or rejects a share an agent proposed. */
export const ThreadShareDecideInput = Schema.Struct({
  threadId: ThreadId,
  shareId: ThreadShareId,
  approve: Schema.Boolean,
});
export type ThreadShareDecideInput = typeof ThreadShareDecideInput.Type;

export const ThreadShareResult = Schema.Struct({
  shares: Schema.Array(ThreadShare),
});
export type ThreadShareResult = typeof ThreadShareResult.Type;

export const ThreadShareLinkExpiry = Schema.Literals(["1d", "7d", "30d"]);
export type ThreadShareLinkExpiry = typeof ThreadShareLinkExpiry.Type;

export const THREAD_SHARE_LINK_EXPIRY_DAYS: Record<ThreadShareLinkExpiry, number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
};

export const ThreadShareLinkCreateInput = Schema.Struct({
  threadId: ThreadId,
  mode: ThreadShareLinkMode,
  role: ThreadShareRole,
  requireApproval: Schema.optional(Schema.Boolean),
  expiresIn: ThreadShareLinkExpiry,
});
export type ThreadShareLinkCreateInput = typeof ThreadShareLinkCreateInput.Type;

export const ThreadShareLinkCreateResult = Schema.Struct({
  shares: Schema.Array(ThreadShare),
  shareId: ThreadShareId,
  /** Returned only here; the environment keeps just its hash. */
  token: TrimmedNonEmptyString,
});
export type ThreadShareLinkCreateResult = typeof ThreadShareLinkCreateResult.Type;

const THREAD_SHARE_MESSAGES = {
  thread_unavailable: "This thread cannot be shared.",
  settled: "Settled threads cannot be shared. Unsettle the thread first.",
  limit: `A thread can have at most ${THREAD_SHARE_LIMIT} shares.`,
  duplicate: "This thread is already shared with them.",
  not_found: "This share no longer exists.",
  not_proposed: "Only a share an agent proposed waits for your approval.",
  read_failed: "Failed to read the thread.",
  link_closed: "This link no longer works.",
} as const;

export class ThreadShareError extends Schema.TaggedError<ThreadShareError>()("ThreadShareError", {
  reason: Schema.Literals([
    "thread_unavailable",
    "settled",
    "limit",
    "duplicate",
    "not_found",
    "not_proposed",
    "read_failed",
    "link_closed",
  ]),
}) {
  override get message(): string {
    return THREAD_SHARE_MESSAGES[this.reason];
  }
}
