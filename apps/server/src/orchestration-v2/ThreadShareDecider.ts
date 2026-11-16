import {
  isThreadShareLinkOpen,
  THREAD_SHARE_LIMIT,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

export type ThreadShareCommand = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "thread.share.grant" | "thread.share.revoke" | "thread.share.status.set" }
>;

/** Failures ThreadShareService maps to `ThreadShareError` reasons. */
export const THREAD_SHARE_FAILURE = {
  unavailable: "thread_unavailable",
  settled: "settled",
  limit: "limit",
  duplicate: "duplicate",
  notFound: "not_found",
  linkClosed: "link_closed",
} as const;

const isSettled = (thread: OrchestrationV2AppThread) =>
  thread.settledOverride === "settled" && thread.settledAt !== null;

/** The thread after a share command, or the same thread when nothing changes. */
export function decideThreadShareCommand(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly command: ThreadShareCommand;
  readonly now: DateTime.Utc;
}): Result.Result<OrchestrationV2AppThread, string> {
  const { thread, command, now } = input;
  const shares = thread.shares ?? [];
  switch (command.type) {
    case "thread.share.grant": {
      if (thread.archivedAt !== null) return Result.fail(THREAD_SHARE_FAILURE.unavailable);
      if (isSettled(thread)) return Result.fail(THREAD_SHARE_FAILURE.settled);
      const { target } = command.share;
      if (
        shares.some(
          (share) =>
            share.id === command.share.id ||
            (share.target.kind === target.kind && share.target.id === target.id),
        )
      ) {
        return Result.fail(THREAD_SHARE_FAILURE.duplicate);
      }
      if (shares.length >= THREAD_SHARE_LIMIT) return Result.fail(THREAD_SHARE_FAILURE.limit);
      const viaShareId = command.share.viaShareId;
      if (viaShareId === undefined) {
        return Result.succeed({ ...thread, shares: [...shares, command.share], updatedAt: now });
      }
      // Judged at the relay's acceptance time, so a claim delivered late still counts.
      const link = shares.find((share) => share.id === viaShareId);
      if (
        link === undefined ||
        target.kind !== "account" ||
        !isThreadShareLinkOpen(link, command.share.grantedAt)
      ) {
        return Result.fail(THREAD_SHARE_FAILURE.linkClosed);
      }
      const closed =
        link.link?.mode === "single"
          ? shares.map((share) =>
              share.id === link.id && share.link !== undefined
                ? { ...share, link: { ...share.link, closedAt: command.share.grantedAt } }
                : share,
            )
          : shares;
      return Result.succeed({ ...thread, shares: [...closed, command.share], updatedAt: now });
    }
    case "thread.share.revoke": {
      if (!shares.some((share) => share.id === command.shareId)) {
        return Result.fail(THREAD_SHARE_FAILURE.notFound);
      }
      return Result.succeed({
        ...thread,
        shares: shares.filter((share) => share.id !== command.shareId),
        updatedAt: now,
      });
    }
    case "thread.share.status.set": {
      const current = shares.find((share) => share.id === command.shareId);
      if (current === undefined) return Result.fail(THREAD_SHARE_FAILURE.notFound);
      if (current.status === command.status) return Result.succeed(thread);
      return Result.succeed({
        ...thread,
        shares: shares.map((share) =>
          share.id === command.shareId ? { ...share, status: command.status } : share,
        ),
        updatedAt: now,
      });
    }
  }
}
