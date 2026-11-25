import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type TurnItemId,
  type VaultCreateInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VaultService from "../vault/VaultService.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const threadId = ThreadId.make("thread-vault-caller");
const instanceId = ProviderInstanceId.make("codex");
const runId = RunId.make("run-vault");
const VALUE = "hunter2-vault-value";

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-vault"),
  requestNamespace: "provider-session-vault",
  thread: { threadId, providerSessionId: "provider-session-vault", providerInstanceId: instanceId },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const password = (overrides: Partial<VaultCreateInput> = {}): VaultCreateInput => ({
  name: "Acme login",
  kind: "password",
  username: "octocat",
  domains: ["acme.example"],
  scope: "global",
  value: VALUE,
  ...overrides,
});

type SecretItem = Extract<OrchestrationV2TurnItem, { readonly type: "secret_request" }>;

/**
 * Real vault and secret refs over an in-memory store; the thread is a fake that applies
 * `secret_request.record` as the orchestrator does (the first non-pending status sticks).
 */
const makeHarness = Effect.fnUntraced(function* (options: {
  readonly projectId: ProjectId;
  readonly actingAccountId?: string;
  readonly directory?: string;
}) {
  const stored = new Map<string, Uint8Array>();
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const items = new Map<string, SecretItem>();
  const logs: Array<string> = [];
  const pendingRecorded = yield* Queue.unbounded<TurnItemId>();
  const run = {
    id: runId,
    ordinal: 1,
    status: "running" as string,
    rootNodeId: NodeId.make("node-root"),
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.4" },
    ...(options.actingAccountId === undefined ? {} : { actingAccountId: options.actingAccountId }),
  };
  const projection = () => ({
    thread: { id: threadId, projectId: options.projectId, providerInstanceId: instanceId },
    runs: [run],
    turnItems: Array.from(items.values()),
    messages: [],
    runtimeRequests: [],
    subagents: [],
    contextTransfers: [],
    providerTurns: [],
  });

  const layerStore = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      ...(options.directory === undefined ? {} : { directory: options.directory }),
      get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
      set: (name, value) => Effect.sync(() => void stored.set(name, value)),
      create: (name, value) => Effect.sync(() => void stored.set(name, value)),
      listNames: (prefix) =>
        Effect.sync(() => Array.from(stored.keys()).filter((name) => name.startsWith(prefix))),
      getOrCreateRandom: (name, bytes) =>
        Effect.sync(() => {
          const value = stored.get(name) ?? new Uint8Array(bytes).fill(7);
          stored.set(name, value);
          return value;
        }),
      remove: (name) => Effect.sync(() => void stored.delete(name)),
    }),
  );
  const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadRecords: () => Effect.sync(() => projection() as never),
    dispatch: (command) =>
      Effect.gen(function* () {
        dispatched.push(command);
        if (command.type !== "secret_request.record") return {} as never;
        const existing = items.get(command.turnItemId);
        if (existing === undefined || existing.secretStatus === "pending") {
          if (existing === undefined || command.secretStatus !== "pending") {
            const { type: _type, commandId: _commandId, ...fields } = command;
            items.set(command.turnItemId, {
              ...fields,
              id: command.turnItemId,
              type: "secret_request",
              status: command.secretStatus === "pending" ? "waiting" : "completed",
            } as unknown as SecretItem);
          }
        }
        if (command.secretStatus === "pending")
          yield* Queue.offer(pendingRecorded, command.turnItemId);
        return {} as never;
      }),
  });
  const layerVault = VaultService.layer.pipe(
    Layer.provide(Layer.merge(layerStore, NodeCrypto.layer)),
  );
  const layerSecrets = SecretRequests.layer.pipe(
    Layer.provide(Layer.mergeAll(layerStore, layerThreads, layerVault, NodeServices.layer)),
  );
  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provideMerge(Layer.mergeAll(layerVault, layerSecrets)),
    Layer.provide(
      Layer.mergeAll(
        layerThreads,
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        NodeCrypto.layer,
      ),
    ),
    Layer.provideMerge(
      Logger.layer([Logger.make(({ message }) => void logs.push(JSON.stringify(message)))], {
        mergeWithExisting: false,
      }),
    ),
  );
  const context = yield* Layer.build(layer);
  return {
    context,
    stored,
    dispatched,
    items,
    logs,
    pendingRecorded,
    run,
  };
});

const withHarness = <A, E>(
  options: Parameters<typeof makeHarness>[0],
  body: (input: {
    readonly mcp: OrchestratorMcpService.OrchestratorMcpService["Service"];
    readonly vault: VaultService.VaultService["Service"];
    readonly secrets: SecretRequests.SecretRequests["Service"];
    readonly harness: Effect.Success<ReturnType<typeof makeHarness>>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness(options);
      return yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        const vault = yield* VaultService.VaultService;
        const secrets = yield* SecretRequests.SecretRequests;
        return yield* body({ mcp, vault, secrets, harness });
      }).pipe(Effect.provide(harness.context));
    }),
  );

/** Neither the value nor anything derived from it may appear in what fwai records or returns. */
const assertNoValue = (
  harness: Effect.Success<ReturnType<typeof makeHarness>>,
  ...results: ReadonlyArray<unknown>
) => {
  assert.notInclude(JSON.stringify(harness.dispatched), VALUE);
  assert.notInclude(JSON.stringify(Array.from(harness.items.values())), VALUE);
  assert.notInclude(harness.logs.join("\n"), VALUE);
  assert.notInclude(JSON.stringify(results), VALUE);
};

it.effect("an owner's run uses an entry saved in another project by name, with no card", () =>
  withHarness({ projectId: projectB }, ({ mcp, vault, secrets, harness }) =>
    Effect.gen(function* () {
      const entry = yield* vault.create(password());
      const listed = yield* mcp.listSecrets(scope);
      assert.deepEqual(listed, {
        entries: [
          { name: "Acme login", kind: "password", username: "octocat", domains: ["acme.example"] },
        ],
      });

      const result = yield* mcp.requestSecret(scope, {
        label: "Acme",
        reason: "Sign in to Acme.",
        name: "Acme login",
      });
      assert.equal(result.status, "saved");
      assert.isTrue(Option.isNone(yield* Queue.poll(harness.pendingRecorded)), "no card");
      const [item] = Array.from(harness.items.values());
      assert.equal(item?.secretStatus, "saved");
      assert.deepEqual(item?.vault, { entryId: entry.id, entryName: "Acme login" });

      assert.isTrue("secretRef" in result);
      const ref = "secretRef" in result ? result.secretRef : undefined;
      assert.equal(yield* secrets.consume({ ref: ref!, projectId: projectB }), VALUE);
      const used = yield* vault.get(entry.id);
      assert.include(used.lastUse, { threadId, delivery: "secretRef" });
      assert.isUndefined(used.lastUse?.accountId);
      assertNoValue(harness, listed, result);
    }),
  ),
);

it.effect("a file delivery writes the entry for the agent's commands", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "vault-mcp-test-" });
    yield* withHarness({ projectId: projectB, directory }, ({ mcp, vault, harness }) =>
      Effect.gen(function* () {
        const entry = yield* vault.create(password({ kind: "token", name: "ACME_TOKEN" }));
        const result = yield* mcp.requestSecret(scope, {
          label: "Acme token",
          reason: "For the CLI.",
          name: "ACME_TOKEN",
          delivery: "file",
        });
        assert.isTrue("file" in result);
        const file = "file" in result ? result.file : "";
        assert.equal(yield* fs.readFileString(file), VALUE);
        const [item] = Array.from(harness.items.values());
        assert.equal(item?.delivery, "file");
        assert.equal((yield* vault.get(entry.id)).lastUse?.delivery, "file");
        assertNoValue(harness, result);
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("an entry scoped to another project stays hidden and unusable until allowed", () =>
  withHarness({ projectId: projectB }, ({ mcp, vault }) =>
    Effect.gen(function* () {
      const entry = yield* vault.create(password({ scope: { projects: [projectA] } }));
      assert.deepEqual(yield* mcp.listSecrets(scope), { entries: [] });
      const refused = yield* mcp
        .requestSecret(scope, { label: "Acme", reason: "Sign in.", name: "Acme login" })
        .pipe(Effect.flip);
      assert.equal(refused.code, "out_of_scope");

      yield* vault.allowProject({ id: entry.id, projectId: projectB });
      assert.equal((yield* mcp.listSecrets(scope)).entries.length, 1);
      const result = yield* mcp.requestSecret(scope, {
        label: "Acme",
        reason: "Sign in.",
        name: "Acme login",
        clientRequestId: "after-allow",
      });
      assert.equal(result.status, "saved");
    }),
  ),
);

it.effect("two entries with one name visible to the project make a by-name request ambiguous", () =>
  withHarness({ projectId: projectB }, ({ mcp, harness }) =>
    Effect.gen(function* () {
      // As vault sync can bring in: create refuses a taken name, so write the records directly.
      for (const id of ["entry-one", "entry-two"]) {
        harness.stored.set(
          `vault-entry-${id}`,
          new TextEncoder().encode(
            JSON.stringify({
              ...password(),
              id,
              version: 1,
              createdAt: "2026-11-24T00:00:00.000Z",
              updatedAt: "2026-11-24T00:00:00.000Z",
            }),
          ),
        );
      }
      const refused = yield* mcp
        .requestSecret(scope, { label: "Acme", reason: "Sign in.", name: "Acme login" })
        .pipe(Effect.flip);
      assert.equal(refused.code, "ambiguous_name");
      assert.deepEqual(harness.dispatched, []);
    }),
  ),
);

it.effect("an unknown name falls back to the card", () =>
  withHarness({ projectId: projectB }, ({ mcp, secrets, harness }) =>
    Effect.gen(function* () {
      const fiber = yield* mcp
        .requestSecret(scope, { label: "Acme", reason: "Sign in.", name: "Nothing like it" })
        .pipe(Effect.forkChild);
      const turnItemId = yield* Queue.take(harness.pendingRecorded);
      assert.isUndefined(harness.items.get(turnItemId)?.vault);
      yield* secrets.answer({ threadId, turnItemId, answer: { type: "decline" } });
      yield* TestClock.adjust("500 millis");
      assert.deepEqual(yield* Fiber.join(fiber), { status: "declined" });
    }),
  ),
);

it.effect("a collaborator's run waits for the owner's approval, once per use", () =>
  withHarness(
    { projectId: projectB, actingAccountId: "user-bob" },
    ({ mcp, vault, secrets, harness }) =>
      Effect.gen(function* () {
        const entry = yield* vault.create(password());
        const listed = yield* mcp.listSecrets(scope).pipe(Effect.flip);
        assert.equal(listed.code, "not_allowed");

        const ask = (clientRequestId: string, timeoutMs?: number) =>
          mcp
            .requestSecret(scope, {
              label: "Acme",
              reason: "Sign in.",
              name: "Acme login",
              clientRequestId,
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            })
            .pipe(Effect.forkChild);

        const allowed = yield* ask("first");
        const first = yield* Queue.take(harness.pendingRecorded);
        assert.deepEqual(harness.items.get(first)?.vault, {
          entryId: entry.id,
          entryName: "Acme login",
          requestedByAccountId: "user-bob",
        });
        assert.isUndefined((yield* vault.get(entry.id)).lastUse, "nothing is used before approval");
        yield* secrets.answerVaultApproval({ threadId, turnItemId: first, decision: "allow" });
        const again = yield* secrets
          .answerVaultApproval({ threadId, turnItemId: first, decision: "deny" })
          .pipe(Effect.flip);
        assert.equal(again.reason, "already_answered");
        yield* TestClock.adjust("500 millis");
        const result = yield* Fiber.join(allowed);
        const ref = "secretRef" in result ? result.secretRef : undefined;
        assert.equal(yield* secrets.consume({ ref: ref!, projectId: projectB }), VALUE);
        assert.equal((yield* vault.get(entry.id)).lastUse?.accountId, "user-bob");

        const denied = yield* ask("second");
        const second = yield* Queue.take(harness.pendingRecorded);
        assert.notEqual(second, first, "each use asks again");
        yield* secrets.answerVaultApproval({ threadId, turnItemId: second, decision: "deny" });
        yield* TestClock.adjust("500 millis");
        assert.equal((yield* Fiber.join(denied).pipe(Effect.flip)).code, "approval_denied");

        const timedOut = yield* ask("third", 1_000);
        yield* Queue.take(harness.pendingRecorded);
        yield* TestClock.adjust("1 second");
        assert.equal((yield* Fiber.join(timedOut).pipe(Effect.flip)).code, "approval_denied");

        const ended = yield* ask("fourth");
        yield* Queue.take(harness.pendingRecorded);
        harness.run.status = "completed";
        yield* TestClock.adjust("500 millis");
        assert.equal((yield* Fiber.join(ended).pipe(Effect.flip)).code, "approval_denied");
        assertNoValue(harness, result);
      }),
  ),
);

it.effect("work a collaborator's run started, like a scheduled task, is held to approval too", () =>
  // A child thread, delegated task or scheduled task inherits the acting account, so its
  // run reaches the vault as the collaborator's would.
  withHarness({ projectId: projectB, actingAccountId: "user-bob" }, ({ mcp, vault, harness }) =>
    Effect.gen(function* () {
      yield* vault.create(password());
      const fiber = yield* mcp
        .requestSecret(scope, { label: "Acme", reason: "Nightly sync.", name: "Acme login" })
        .pipe(Effect.forkChild);
      const turnItemId = yield* Queue.take(harness.pendingRecorded);
      assert.equal(harness.items.get(turnItemId)?.vault?.requestedByAccountId, "user-bob");
      assert.equal(harness.items.get(turnItemId)?.secretStatus, "pending");
      yield* Fiber.interrupt(fiber);
    }),
  ),
);
