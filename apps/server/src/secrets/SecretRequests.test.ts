import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  NodeId,
  ProjectId,
  RunId,
  VaultEntryId,
  type VaultScope,
  type OrchestrationV2SecretRequestVault,
  type OrchestrationV2ServerCommand,
  SecretRef,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Tracer from "effect/Tracer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as VaultService from "../vault/VaultService.ts";
import * as SecretRequests from "./SecretRequests.ts";

const threadId = ThreadId.make("thread-orchestrator");
const turnItemId = TurnItemId.make("turn-item:secret-request:1");
const projectId = ProjectId.make("project-1");

const withService = <A, E>(
  body: (input: {
    readonly service: SecretRequests.SecretRequests["Service"];
    readonly stored: Map<string, Uint8Array>;
    readonly dispatched: Array<OrchestrationV2ServerCommand>;
    readonly vault: VaultService.VaultService["Service"];
  }) => Effect.Effect<A, E>,
  options: {
    readonly threadId?: ThreadId;
    readonly delivery?: "file";
    readonly directory?: string;
    readonly runStatus?: string;
    readonly removeFails?: boolean;
    readonly closedFirst?: boolean;
    readonly failedRecords?: number;
    readonly vault?: OrchestrationV2SecretRequestVault;
    readonly actingAccountId?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>();
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    let secretStatus = "pending";
    let failedRecords = options.failedRecords ?? 0;
    const requestThreadId = options.threadId ?? threadId;
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      NodeServices.layer,
      Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          ...(options.directory === undefined ? {} : { directory: options.directory }),
          get: (name) => Effect.yieldNow.pipe(Effect.as(Option.fromNullishOr(stored.get(name)))),
          set: (name, value) => Effect.sync(() => void stored.set(name, value)),
          listNames: (prefix) =>
            Effect.sync(() => Array.from(stored.keys()).filter((name) => name.startsWith(prefix))),
          create: (name, value) =>
            stored.has(name)
              ? Effect.fail(
                  new ServerSecretStore.SecretStorePersistError({
                    resource: name,
                    cause: new PlatformError.PlatformError(
                      new PlatformError.SystemError({
                        _tag: "AlreadyExists",
                        module: "FileSystem",
                        method: "open",
                      }),
                    ),
                  } as never),
                )
              : Effect.sync(() => void stored.set(name, value)),
          getOrCreateRandom: (name, bytes) =>
            Effect.sync(() => {
              const existing = stored.get(name);
              if (existing) return existing;
              const value = new Uint8Array(bytes).fill(7);
              stored.set(name, value);
              return value;
            }),
          remove: (name) =>
            options.removeFails
              ? Effect.fail(
                  new ServerSecretStore.SecretStorePersistError({
                    resource: name,
                    cause: new Error("read-only"),
                  }),
                )
              : Effect.sync(() => void stored.delete(name)),
        }),
      ),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: () =>
          Effect.succeed({
            thread: { projectId },
            runs: [
              {
                id: "run-1",
                status: options.runStatus ?? "running",
                ...(options.actingAccountId === undefined
                  ? {}
                  : { actingAccountId: options.actingAccountId }),
              },
            ],
            turnItems: [
              {
                id: turnItemId,
                threadId: requestThreadId,
                runId: "run-1",
                nodeId: "node-root",
                type: "secret_request",
                label: "GitHub token",
                reason: "Used as GH_TOKEN.",
                ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
                ...(options.vault === undefined ? {} : { vault: options.vault }),
                secretStatus,
              },
            ],
          } as never),
        dispatch: (command) => {
          if (command.type === "secret_request.record" && failedRecords > 0) {
            failedRecords -= 1;
            return Effect.fail(new Error("orchestrator unavailable") as never);
          }
          return Effect.sync(() => {
            dispatched.push(command);
            if (options.closedFirst && command.type === "secret_request.record") {
              secretStatus = "cancelled";
            } else if (command.type === "secret_request.record" && secretStatus === "pending") {
              secretStatus = command.secretStatus;
            }
            return {} as never;
          });
        },
      }),
    );
    return yield* Effect.gen(function* () {
      const service = yield* SecretRequests.SecretRequests;
      const vault = yield* VaultService.VaultService;
      return yield* body({ service, stored, dispatched, vault });
    }).pipe(
      Effect.provide(
        SecretRequests.layer.pipe(
          Layer.provideMerge(VaultService.layer),
          Layer.provide(layerDependencies),
        ),
      ),
    );
  });

// An entry with a fixed id, so the approval card can name it before the service starts.
const seedEntry = (stored: Map<string, Uint8Array>, id: VaultEntryId) =>
  stored.set(
    `vault-entry-${id}`,
    new TextEncoder().encode(
      JSON.stringify({
        id,
        name: "GitHub",
        kind: "password",
        domains: ["github.com"],
        scope: "global",
        value: "vault-value-hunter2",
        version: 1,
        createdAt: "2026-11-24T00:00:00.000Z",
        updatedAt: "2026-11-24T00:00:00.000Z",
      }),
    ),
  );

const valuesOf = (stored: Map<string, Uint8Array>) =>
  Array.from(stored.entries())
    .filter(([name]) => name !== "secret-request-salt")
    .map(([, bytes]) => new TextDecoder().decode(bytes));

it.effect("a saved answer becomes a one-use ref, and the thread only learns it was saved", () =>
  withService(({ service, stored, dispatched }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      assert.equal(dispatched.length, 1);
      assert.include(dispatched[0] as object, {
        type: "secret_request.record",
        secretStatus: "saved",
      });
      assert.notInclude(Object.values(dispatched[0] as object).map(String), "ghp_secret");

      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
      assert.isFalse(valuesOf(stored).some((value) => value.includes("ghp_secret")));
      const again = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
      assert.include(again.message, "already used");
    }),
  ),
);

it.effect("a form fill uses only a vault-backed ref, once, and leaves a typed one usable", () =>
  withService(({ service, stored }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      assert.isUndefined(yield* service.consumeForFill({ ref, projectId }));

      const name = `secret-request-${ref.slice("secret-ref:".length)}`;
      const record = JSON.parse(new TextDecoder().decode(stored.get(name)));
      stored.set(name, new TextEncoder().encode(JSON.stringify({ ...record, entryId: "entry-1" })));
      assert.equal(yield* service.consumeForFill({ ref, projectId }), "entry-1");
      const again = yield* service.consumeForFill({ ref, projectId }).pipe(Effect.flip);
      assert.equal(again.reason, "ref_unavailable");
    }),
  ),
);

it.effect("two concurrent uses of one ref hand the value out once", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      const results = yield* Effect.forEach(
        [service.consume({ ref, projectId }), service.consume({ ref, projectId })],
        Effect.result,
        { concurrency: "unbounded" },
      );
      assert.deepEqual(results.map((result) => result._tag).toSorted(), ["Failure", "Success"]);
    }),
  ),
);

it.effect("a save that loses to the card closing deletes the value and says so", () =>
  withService(
    ({ service, stored }) =>
      Effect.gen(function* () {
        const error = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.equal(error.reason, "agent_stopped");
        assert.isFalse(valuesOf(stored).some((value) => value.includes("ghp_secret")));
      }),
    { closedFirst: true },
  ),
);

it.effect("a save whose record failed can be saved again", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        const failed = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.equal(failed.reason, "record_failed");
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
      }),
    { failedRecords: 1 },
  ),
);

it.effect("a ref only works in the project it was entered for", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      const elsewhere = yield* service
        .consume({ ref, projectId: ProjectId.make("project-other") })
        .pipe(Effect.flip);
      assert.include(elsewhere.message, "does not exist");
      assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
    }),
  ),
);

it.effect("declining stores nothing, and a request is answered once", () =>
  withService(({ service, stored, dispatched }) =>
    Effect.gen(function* () {
      yield* service.answer({ threadId, turnItemId, answer: { type: "decline" } });
      assert.deepEqual(valuesOf(stored), []);
      assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));
      const late = yield* service
        .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
        .pipe(Effect.flip);
      assert.include(late.message, "already answered");
      assert.equal(dispatched.length, 1);
      assert.deepEqual(valuesOf(stored), []);
    }),
  ),
);

it.effect("traces and counts a saved answer without ever recording the value", () =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const counted = Metric.snapshot.pipe(
      Effect.map((snapshots) => {
        const found = snapshots.find(
          (snapshot) =>
            snapshot.id === "t3_secret_refs_consumed_total" &&
            snapshot.attributes?.result === "used",
        );
        return found?.type === "Counter" ? Number(found.state.count) : 0;
      }),
    );
    const before = yield* counted;
    yield* withService(({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        yield* service.consume({ ref, projectId });
      }),
    ).pipe(Effect.withTracer(tracer));
    assert.equal((yield* counted) - before, 1);
    const recorded = spans.flatMap((span) => [
      span.name,
      ...Array.from(span.attributes.values(), String),
    ]);
    assert.include(recorded, "SecretRequests.answer");
    assert.include(recorded, "SecretRequests.consume");
    assert.isFalse(recorded.some((value) => value.includes("ghp_secret")));
  }),
);

it.effect("works in threads with long ids, such as a delegated subagent's", () => {
  const delegatedThreadId = ThreadId.make(
    `thread:delegated-task:command%3Amcp%3A${"a".repeat(36)}%3Adelegate-task%3Arelease-notes-v0.2.0-${"b".repeat(40)}`,
  );
  return withService(
    ({ service, stored }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId: delegatedThreadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        assert.isTrue(Array.from(stored.keys()).every((name) => name.length < 100));
        const ref = Option.getOrThrow(
          yield* service.savedRef({ threadId: delegatedThreadId, turnItemId }),
        );
        assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
      }),
    { threadId: delegatedThreadId },
  );
});

it.effect("refuses an answer once the agent that asked has stopped", () =>
  withService(
    ({ service, stored, dispatched }) =>
      Effect.gen(function* () {
        const late = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.include(late.message, "has stopped");
        assert.deepEqual(valuesOf(stored), []);
        assert.equal(dispatched.length, 0);
      }),
    { runStatus: "completed" },
  ),
);

it.effect("a used value that cannot be deleted is not handed out", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        const failed = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
        assert.include(failed.message, "Could not use");
      }),
    { removeFails: true },
  ),
);

const SECRET_FILE_TTL_MS = 24 * 60 * 60 * 1000;

it.effect("a file request moves its value to an owner-only file, once", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    const file = yield* withService(
      ({ service, stored, dispatched }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "cf_token'$(id)" },
          });
          assert.include(dispatched[0] as object, { secretStatus: "saved", delivery: "file" });
          const file = yield* service.saveToFile({ threadId, turnItemId });
          assert.equal(yield* fs.readFileString(file), "cf_token'$(id)");
          assert.deepEqual(valuesOf(stored), []);
          if ((yield* HostProcess.Platform) !== "win32") {
            assert.equal((yield* fs.stat(file)).mode & 0o777, 0o600);
            assert.equal((yield* fs.stat(path.dirname(file))).mode & 0o777, 0o700);
          }
          // A retried request_secret gets the same file; the value is never a ref again.
          assert.equal(yield* service.saveToFile({ threadId, turnItemId }), file);
          const ref = SecretRef.make(`secret-ref:${path.basename(file)}`);
          const reused = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
          assert.equal(reused.reason, "ref_unavailable");
          return file;
        }),
      { delivery: "file", directory },
    );

    const { mtime } = yield* fs.stat(file);
    yield* TestClock.setTime(Option.getOrThrow(mtime).getTime() + SECRET_FILE_TTL_MS);
    yield* withService(() => Effect.void, { directory });
    assert.isTrue(yield* fs.exists(file));
    yield* TestClock.setTime(Option.getOrThrow(mtime).getTime() + SECRET_FILE_TTL_MS + 1);
    yield* withService(() => Effect.void, { directory });
    assert.isFalse(yield* fs.exists(file));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a failed file write keeps the value, so the request can retry", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "cf_token" },
          });
          const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
          const name = ref.slice("secret-ref:".length);
          // A non-empty directory where the partial file goes makes the write fail.
          const partial = path.join(directory, "files", `${name}.partial`);
          yield* fs.makeDirectory(path.join(partial, "block"), { recursive: true });
          const failed = yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip);
          assert.equal(failed.reason, "store_failed");
          yield* fs.remove(partial, { recursive: true });
          const file = yield* service.saveToFile({ threadId, turnItemId });
          assert.equal(yield* fs.readFileString(file), "cf_token");
        }),
      { delivery: "file", directory },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a file is not delivered while its stored copy cannot be removed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "cf_token" },
          });
          const first = yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip);
          assert.equal(first.reason, "consume_failed");
          // A retry finds the file but still will not hand it out until the removal works.
          const retried = yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip);
          assert.equal(retried.reason, "consume_failed");
        }),
      { delivery: "file", directory, removeFails: true },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a secret the card promised to keep from the agent is never written to a file", () =>
  withService(({ service, stored }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const refused = yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip);
      assert.equal(refused.reason, "not_a_file_request");
      assert.isTrue(valuesOf(stored).some((value) => value.includes("ghp_secret")));
    }),
  ),
);

const VAULT_VALUE = "vault-value-hunter2";
const vaultEntry = (scope: VaultScope = "global", name = "Acme login") => ({
  name,
  kind: "password" as const,
  domains: ["github.com"],
  scope,
  value: VAULT_VALUE,
});
const leaks = (value: unknown) => JSON.stringify(value).includes(VAULT_VALUE);

it.effect(
  "a card answered with a vault entry hands over a ref and the card learns only saved",
  () =>
    withService(
      ({ service, dispatched, vault }) =>
        Effect.gen(function* () {
          const entry = yield* vault.create(vaultEntry({ projects: [projectId] }));
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "vault", entryId: entry.id },
          });
          assert.equal(dispatched.length, 1);
          assert.include(dispatched[0] as object, { secretStatus: "saved" });
          assert.notProperty(dispatched[0] as object, "vault");
          assert.isFalse(JSON.stringify(dispatched).includes("Acme"));
          assert.isFalse(leaks(dispatched));

          const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
          assert.equal(yield* service.consumeForFill({ ref, projectId }), entry.id);
          const used = yield* vault.get(entry.id);
          assert.include(used.lastUse, {
            threadId,
            accountId: "user-bob",
            delivery: "secretRef",
          });
        }),
      { actingAccountId: "user-bob" },
    ),
);

it.effect("an entry from another project is refused until Also allow adds this project", () =>
  withService(({ service, vault }) =>
    Effect.gen(function* () {
      const other = ProjectId.make("project-other");
      const entry = yield* vault.create(vaultEntry({ projects: [other] }));
      const refused = yield* service
        .answer({ threadId, turnItemId, answer: { type: "vault", entryId: entry.id } })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "vault_entry_unavailable");
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "vault", entryId: entry.id, alsoAllowProject: true },
      });
      assert.deepEqual((yield* vault.get(entry.id)).scope, { projects: [other, projectId] });
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      assert.equal(yield* service.consume({ ref, projectId }), VAULT_VALUE);
    }),
  ),
);

it.effect("a typed answer saved to the vault succeeds or fails with its entry", () =>
  withService(({ service, stored, dispatched, vault }) =>
    Effect.gen(function* () {
      yield* vault.create(vaultEntry());
      const saveToVault = {
        name: "Acme login",
        kind: "password" as const,
        scope: "global" as const,
        domains: ["github.com"],
      };
      const taken = yield* service
        .answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "typed-value", saveToVault },
        })
        .pipe(Effect.flip);
      assert.equal(taken.reason, "vault_name_taken");
      assert.equal(dispatched.length, 0);
      assert.isFalse(Array.from(stored.keys()).some((name) => name.startsWith("secret-request-r")));
      assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));

      yield* service.answer({
        threadId,
        turnItemId,
        answer: {
          type: "save",
          secret: "typed-value",
          saveToVault: { ...saveToVault, name: "Acme backup" },
        },
      });
      const saved = (yield* vault.list()).entries.find((entry) => entry.name === "Acme backup");
      assert.isDefined(saved);
      assert.equal(yield* vault.readValue(saved!.id), "typed-value");
      assert.isFalse(JSON.stringify(dispatched).includes("Acme"));
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      assert.equal(yield* service.consumeForFill({ ref, projectId }), saved!.id);
    }),
  ),
);

it.effect("a typed answer whose record fails takes its new vault entry back", () =>
  withService(
    ({ service, vault }) =>
      Effect.gen(function* () {
        const failed = yield* service
          .answer({
            threadId,
            turnItemId,
            answer: {
              type: "save",
              secret: "typed-value",
              saveToVault: { name: "GH", kind: "token", scope: "global", domains: [] },
            },
          })
          .pipe(Effect.flip);
        assert.equal(failed.reason, "record_failed");
        assert.deepEqual((yield* vault.list()).entries, []);
      }),
    { failedRecords: 1 },
  ),
);

it.effect("the owner's run uses an entry with no card, shown as Used <name>", () =>
  withService(({ service, dispatched, vault }) =>
    Effect.gen(function* () {
      const entry = yield* vault.create(vaultEntry());
      yield* service.useVaultEntry({
        threadId,
        runId: RunId.make("run-1"),
        nodeId: NodeId.make("node-root"),
        turnItemId,
        projectId,
        entry,
        label: "GitHub login",
        reason: "Sign in to GitHub.",
      });
      assert.include(dispatched[0] as object, { secretStatus: "saved" });
      assert.deepEqual((dispatched[0] as { vault?: unknown }).vault, {
        entryId: entry.id,
        entryName: "Acme login",
      });
      assert.isFalse(leaks(dispatched));
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      assert.equal(yield* service.consume({ ref, projectId }), VAULT_VALUE);
      const used = yield* vault.get(entry.id);
      assert.isUndefined(used.lastUse?.accountId);
      assert.equal(used.lastUse?.delivery, "secretRef");
    }),
  ),
);

const approvalFor = (entryId: VaultEntryId) => ({
  entryId,
  entryName: "GitHub",
  requestedByAccountId: "user-bob",
});

it.effect("the owner allows another account's run one use; the first answer wins", () =>
  Effect.gen(function* () {
    const entryId = VaultEntryId.make("entry-approval");
    yield* withService(
      ({ service, stored, dispatched, vault }) =>
        Effect.gen(function* () {
          seedEntry(stored, entryId);
          const typed = yield* service
            .answer({ threadId, turnItemId, answer: { type: "save", secret: "typed" } })
            .pipe(Effect.flip);
          assert.equal(typed.reason, "not_found", "an approval takes no typed value");

          yield* service.answerVaultApproval({ threadId, turnItemId, decision: "allow" });
          assert.include(dispatched[0] as object, { secretStatus: "saved" });
          assert.deepEqual((dispatched[0] as { vault?: unknown }).vault, approvalFor(entryId));
          assert.isFalse(leaks(dispatched));
          const again = yield* service
            .answerVaultApproval({ threadId, turnItemId, decision: "deny" })
            .pipe(Effect.flip);
          assert.equal(again.reason, "already_answered");
          const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
          assert.equal(yield* service.consume({ ref, projectId }), VAULT_VALUE);
          assert.equal((yield* vault.get(entryId)).lastUse?.accountId, "user-bob");
        }),
      { vault: approvalFor(entryId), actingAccountId: "user-bob" },
    );
  }),
);

it.effect("a denied approval stores nothing, and a plain card is not an approval", () =>
  Effect.gen(function* () {
    const entryId = VaultEntryId.make("entry-approval");
    yield* withService(
      ({ service, stored, dispatched }) =>
        Effect.gen(function* () {
          seedEntry(stored, entryId);
          yield* service.answerVaultApproval({ threadId, turnItemId, decision: "deny" });
          assert.include(dispatched[0] as object, { secretStatus: "declined" });
          assert.deepEqual((dispatched[0] as { vault?: unknown }).vault, approvalFor(entryId));
          assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));
          assert.isFalse(leaks(Array.from(stored.keys())));
        }),
      { vault: approvalFor(entryId), actingAccountId: "user-bob" },
    );
    yield* withService(({ service }) =>
      Effect.gen(function* () {
        const refused = yield* service
          .answerVaultApproval({ threadId, turnItemId, decision: "allow" })
          .pipe(Effect.flip);
        assert.equal(refused.reason, "not_found");
      }),
    );
  }),
);
