import { describe, expect, it, vi } from "vite-plus/test";

import {
  awaitUsername,
  colleagueAvatarColor,
  colleagueInitial,
  createUsernameCache,
  resolveMessageAuthorId,
} from "./colleagues.ts";

function manualSchedule() {
  const pending: Array<() => void> = [];
  return {
    schedule: (flush: () => void) => pending.push(flush),
    flush: () => {
      for (const run of pending.splice(0)) run();
    },
  };
}

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createUsernameCache", () => {
  it("batches ids requested together, splits at the limit, and skips known ids", async () => {
    const scheduler = manualSchedule();
    const lookups: Array<ReadonlyArray<string>> = [];
    const cache = createUsernameCache({
      batchLimit: 2,
      schedule: scheduler.schedule,
      lookup: async (ids) => {
        lookups.push(ids);
        return new Map(ids.filter((id) => id !== "usr_gone").map((id) => [id, `name-${id}`]));
      },
    });

    cache.request(["usr_1", "usr_2"]);
    cache.request(["usr_2", "usr_gone"]);
    scheduler.flush();
    await Promise.resolve();
    await Promise.resolve();

    expect(lookups).toEqual([["usr_1", "usr_2"], ["usr_gone"]]);
    expect(cache.get("usr_1")).toBe("name-usr_1");
    expect(cache.get("usr_gone")).toBeNull();
    expect(cache.get("usr_unasked")).toBeUndefined();

    cache.request(["usr_1", "usr_gone"]);
    scheduler.flush();
    expect(lookups).toHaveLength(2);
  });

  it("does not ask twice for an id in flight, and asks again after a failed lookup", async () => {
    const scheduler = manualSchedule();
    const first = deferred<ReadonlyMap<string, string>>();
    const lookups: Array<ReadonlyArray<string>> = [];
    let calls = 0;
    const retries: Array<{ readonly run: () => void; readonly delayMs: number }> = [];
    const cache = createUsernameCache({
      schedule: scheduler.schedule,
      scheduleRetry: (run, delayMs) => retries.push({ run, delayMs }),
      lookup: (ids) => {
        lookups.push(ids);
        calls += 1;
        return calls === 1 ? first.promise : Promise.resolve(new Map([["usr_1", "ada"]]));
      },
    });
    let notified = 0;
    cache.subscribe(() => {
      notified += 1;
    });

    cache.request(["usr_1"]);
    scheduler.flush();
    cache.request(["usr_1"]);
    scheduler.flush();
    expect(lookups).toEqual([["usr_1"]]);

    first.reject(new Error("gateway down"));
    await first.promise.catch(() => undefined);
    await Promise.resolve();
    expect(cache.get("usr_1")).toBeUndefined();
    expect(notified).toBe(0);

    // The retry wakes the rows still showing the fallback, so they ask again.
    expect(retries).toHaveLength(1);
    retries[0]!.run();
    expect(notified).toBe(1);

    cache.request(["usr_1"]);
    scheduler.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(lookups).toEqual([["usr_1"], ["usr_1"]]);
    expect(cache.get("usr_1")).toBe("ada");
    expect(notified).toBe(2);
    expect(cache.getVersion()).toBe(2);
  });

  it("backs off between retries while lookups keep failing", async () => {
    const scheduler = manualSchedule();
    const delays: number[] = [];
    const pending: Array<() => void> = [];
    const cache = createUsernameCache({
      schedule: scheduler.schedule,
      scheduleRetry: (run, delayMs) => {
        delays.push(delayMs);
        pending.push(run);
      },
      lookup: () => Promise.reject(new Error("refused")),
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      cache.request(["usr_1"]);
      scheduler.flush();
      await Promise.resolve();
      await Promise.resolve();
      pending.shift()?.();
    }
    expect(delays).toEqual([15_000, 30_000, 60_000]);
  });
});

describe("resolveMessageAuthorId", () => {
  it("names a collaborator's message on the owner's side", () => {
    expect(
      resolveMessageAuthorId({
        authorAccountId: "usr_bob",
        sharedOwnerId: null,
        signedInUserId: "usr_ada",
      }),
    ).toBe("usr_bob");
  });

  it("attributes an authorless message in a shared thread to the owner", () => {
    expect(
      resolveMessageAuthorId({
        authorAccountId: undefined,
        sharedOwnerId: "usr_ada",
        signedInUserId: "usr_bob",
      }),
    ).toBe("usr_ada");
  });

  it("shows no name on the viewer's own messages", () => {
    expect(
      resolveMessageAuthorId({
        authorAccountId: "usr_bob",
        sharedOwnerId: "usr_ada",
        signedInUserId: "usr_bob",
      }),
    ).toBeNull();
    expect(
      resolveMessageAuthorId({
        authorAccountId: undefined,
        sharedOwnerId: null,
        signedInUserId: "usr_ada",
      }),
    ).toBeNull();
  });
});

describe("colleague avatars", () => {
  it("uses the first letter, upper-cased, and a stable colour per user id", () => {
    expect(colleagueInitial(" bob")).toBe("B");
    expect(colleagueInitial("")).toBe("?");
    expect(colleagueAvatarColor("usr_1")).toBe(colleagueAvatarColor("usr_1"));
    expect(colleagueAvatarColor("usr_1")).not.toBe(colleagueAvatarColor("usr_2"));
    expect(colleagueAvatarColor("usr_1")).toMatch(
      /^hsl\((\d|[1-9]\d|[12]\d\d|3[0-5]\d), 45%, 45%\)$/,
    );
  });
});

describe("awaitUsername", () => {
  function setup() {
    vi.useFakeTimers();
    const scheduler = manualSchedule();
    const lookups: Array<ReturnType<typeof deferred<ReadonlyMap<string, string>>>> = [];
    const cache = createUsernameCache({
      schedule: scheduler.schedule,
      lookup: () => {
        const lookup = deferred<ReadonlyMap<string, string>>();
        lookups.push(lookup);
        return lookup.promise;
      },
    });
    return {
      cache,
      lookups,
      scheduler,
      [Symbol.dispose]: () => {
        vi.useRealTimers();
      },
    };
  }

  it("waits for a name that arrives before the deadline", async () => {
    using test = setup();
    let result: string | null | undefined;
    void awaitUsername(test.cache, "usr_bob", 2_000).then((name) => {
      result = name;
    });
    test.scheduler.flush();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(result).toBeUndefined();
    test.lookups[0]!.resolve(new Map([["usr_bob", "bob"]]));
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe("bob");
  });

  it("gives up at the deadline when the lookup does not answer", async () => {
    using test = setup();
    let result: string | null | undefined;
    void awaitUsername(test.cache, "usr_bob", 2_000).then((name) => {
      result = name;
    });
    test.scheduler.flush();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeNull();
  });

  it("falls back once a failed lookup leaves the deadline as the only answer", async () => {
    using test = setup();
    let result: string | null | undefined;
    void awaitUsername(test.cache, "usr_bob", 2_000).then((name) => {
      result = name;
    });
    test.scheduler.flush();
    test.lookups[0]!.reject(new Error("offline"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(result).toBeNull();
  });

  it("answers at once from the cache, including an id the gateway does not know", async () => {
    using test = setup();
    test.cache.request(["usr_bob", "usr_gone"]);
    test.scheduler.flush();
    test.lookups[0]!.resolve(new Map([["usr_bob", "bob"]]));
    await vi.advanceTimersByTimeAsync(0);
    await expect(awaitUsername(test.cache, "usr_bob", 2_000)).resolves.toBe("bob");
    await expect(awaitUsername(test.cache, "usr_gone", 2_000)).resolves.toBeNull();
  });
});
