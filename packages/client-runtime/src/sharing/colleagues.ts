/** Shown for a gateway account whose username cannot be resolved. Never fall back to an email. */
export const UNKNOWN_COLLEAGUE_NAME = "A colleague";

export function colleagueInitial(username: string): string {
  const first = username.trim().codePointAt(0);
  return first === undefined ? "?" : String.fromCodePoint(first).toUpperCase();
}

/** A stable colour for a gateway user id, so a colleague's avatar looks the same on every client. */
export function colleagueAvatarColor(userId: string): string {
  // FNV-1a: cheap, and spreads short ids well.
  let hash = 0x811c9dc5;
  for (let index = 0; index < userId.length; index += 1) {
    hash ^= userId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `hsl(${(hash >>> 0) % 360}, 45%, 45%)`;
}

/**
 * Whose name a user message shows: its author, or null when the viewer wrote it. In a shared thread
 * a message without an author came from the owner's own session, so it is the owner's; in the
 * owner's own environment it is the viewer's.
 */
export function resolveMessageAuthorId(input: {
  readonly authorAccountId: string | undefined;
  /** The owner of the shared environment the thread runs in, null in the viewer's own. */
  readonly sharedOwnerId: string | null;
  readonly signedInUserId: string | null;
}): string | null {
  const authorId = input.authorAccountId ?? input.sharedOwnerId;
  return authorId === null || authorId === input.signedInUserId ? null : authorId;
}

const RETRY_DELAY_MS = 15_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;

/**
 * Resolves gateway user ids to usernames in batches of at most `batchLimit`; an id the lookup
 * leaves out is remembered as unknown. A failed lookup forgets its ids and, after a backoff,
 * notifies subscribers: nothing else re-renders a timeline row showing the fallback.
 */
export interface UsernameCache {
  /** The username, null when the gateway does not know the id, undefined while unresolved. */
  readonly get: (userId: string) => string | null | undefined;
  readonly request: (userIds: Iterable<string>) => void;
  /** Bumps whenever a name resolves; for `useSyncExternalStore`. */
  readonly getVersion: () => number;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createUsernameCache(options: {
  readonly lookup: (userIds: ReadonlyArray<string>) => Promise<ReadonlyMap<string, string>>;
  readonly batchLimit?: number;
  /** Defaults to a microtask, so ids requested while rendering one frame share a lookup. */
  readonly schedule?: (flush: () => void) => void;
  /** Runs `retry` after `delayMs`; defaults to `setTimeout`. */
  readonly scheduleRetry?: (retry: () => void, delayMs: number) => void;
}): UsernameCache {
  const batchLimit = options.batchLimit ?? 100;
  const schedule = options.schedule ?? ((flush) => queueMicrotask(flush));
  const scheduleRetry =
    options.scheduleRetry ??
    ((retry, delayMs) => {
      // @effect-diagnostics-next-line globalTimers:off - React-facing cache, outside an Effect runtime.
      setTimeout(retry, delayMs);
    });
  let retryDelayMs = RETRY_DELAY_MS;
  let retryScheduled = false;
  const names = new Map<string, string | null>();
  const inFlight = new Set<string>();
  let queued = new Set<string>();
  let flushScheduled = false;
  let version = 0;
  const listeners = new Set<() => void>();

  const notify = () => {
    version += 1;
    for (const listener of listeners) listener();
  };

  const lookupBatch = async (batch: ReadonlyArray<string>) => {
    try {
      const resolved = await options.lookup(batch);
      for (const userId of batch) names.set(userId, resolved.get(userId) ?? null);
      retryDelayMs = RETRY_DELAY_MS;
      notify();
    } catch {
      // Left unresolved: the caller shows the fallback until the retry asks again.
      if (!retryScheduled) {
        retryScheduled = true;
        const delayMs = retryDelayMs;
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
        scheduleRetry(() => {
          retryScheduled = false;
          notify();
        }, delayMs);
      }
    } finally {
      for (const userId of batch) inFlight.delete(userId);
    }
  };

  const flush = () => {
    flushScheduled = false;
    const pending = [...queued];
    queued = new Set();
    for (let start = 0; start < pending.length; start += batchLimit) {
      void lookupBatch(pending.slice(start, start + batchLimit));
    }
  };

  return {
    get: (userId) => names.get(userId),
    request: (userIds) => {
      for (const userId of userIds) {
        if (userId.length === 0 || names.has(userId) || inFlight.has(userId)) continue;
        inFlight.add(userId);
        queued.add(userId);
      }
      if (queued.size > 0 && !flushScheduled) {
        flushScheduled = true;
        schedule(flush);
      }
    },
    getVersion: () => version,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Waits up to `timeoutMs` for a username, for a surface that cannot change once shown (an OS
 * notification). Resolves to null when the gateway does not know the id or the lookup did not
 * answer in time, which is how a failed lookup shows here.
 */
export function awaitUsername(
  cache: UsernameCache,
  userId: string,
  timeoutMs: number,
): Promise<string | null> {
  const known = cache.get(userId);
  if (known !== undefined) return Promise.resolve(known);
  return new Promise((resolve) => {
    const finish = (name: string | null) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(name);
    };
    // A notification without a name is still a lookup in flight or a retry tick.
    const unsubscribe = cache.subscribe(() => {
      const name = cache.get(userId);
      if (name !== undefined) finish(name);
    });
    // @effect-diagnostics-next-line globalTimers:off - React-facing cache, outside an Effect runtime.
    const timer = setTimeout(() => finish(null), timeoutMs);
    cache.request([userId]);
  });
}
