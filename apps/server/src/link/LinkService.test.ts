import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type ModelSelection,
  type NodeId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ThreadShareId,
} from "@t3tools/contracts";
import type {
  RelayLinkDelivery,
  RelayLinkEnvelope,
  RelayLinkReceipt,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as LinkRelay from "./LinkRelay.ts";
import * as ProviderTurnStartServiceTestkit from "../orchestration-v2/ProviderTurnStartService.testkit.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Result from "effect/Result";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { linkPeerId } from "./LinkDecider.ts";
import * as LinkService from "./LinkService.ts";
import * as LinkTurnContext from "./LinkTurnContext.ts";

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-link-service-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by delegated completion tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerTestProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const environmentId = EnvironmentId.make("environment-local");

/** One environment's runtime; `relay` stands in for fwai Connect. */
const layerEnvironment = (
  id: EnvironmentId,
  relay: LinkRelay.LinkRelay["Service"] = {
    send: () => Effect.succeed(null),
    presence: () => Effect.succeed(null),
  },
) =>
  Layer.mergeAll(
    RuntimeLayer.layer,
    RuntimeLayer.layerEventSink,
    RuntimeLayer.layerLinkService.pipe(Layer.provide(Layer.succeed(LinkRelay.LinkRelay, relay))),
  ).pipe(
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(id),
      }),
    ),
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provide(
      Layer.mock(WorkspacePaths.WorkspacePaths)({
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      }),
    ),
    Layer.provide(ProviderTurnStartServiceTestkit.layer),
    Layer.provide(
      Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
        peek: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          }),
        request: () => Effect.void,
        getAvailable: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          }),
        invalidate: () => Effect.void,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(layerCheckpointStoreTest),
    Layer.provide(layerServerConfig),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerTestProviderInstanceRegistry),
    Layer.provide(layerPlatformTest),
  );

const layerTest = layerEnvironment(environmentId);

const seedThread = (name: string, title: string) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* projects.create({
      commandId: CommandId.make(`command:project:${name}`),
      projectId: ProjectId.make(`project:${name}`),
      title,
      workspaceRoot: `/workspace/${name}`,
    });
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:thread:${name}`),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: `${title} thread`,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    return threadId;
  });

const sendUserMessage = (threadId: ThreadId, key: string, text: string, actingAccountId?: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:message:${key}`),
      ...(actingAccountId === undefined ? {} : { actingAccountId }),
      threadId,
      messageId: MessageId.make(`message:${key}`),
      text,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "queue_after_active" },
    });
    return (yield* orchestrator.getThreadProjection(threadId)).runs.find(
      (run) => run.userMessageId === MessageId.make(`message:${key}`),
    )!;
  });

const linkTaskRun = (threadId: ThreadId, taskId: NodeId) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator
      .getThreadProjection(threadId)
      .pipe(
        Effect.map((projection) => projection.runs.find((run) => run.linkTask?.taskId === taskId)!),
      ),
  );

const requesterTask = (threadId: ThreadId, taskId: NodeId) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator
      .getThreadProjection(threadId)
      .pipe(Effect.map((projection) => projection.subagents.find((task) => task.id === taskId)!)),
  );

/** Stands in for the provider: the run ends, optionally with a final assistant message. */
const endRun = (run: OrchestrationV2Run, status: OrchestrationV2Run["status"], reply?: string) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        ...(reply === undefined
          ? []
          : [
              {
                id: EventId.make(`event:reply:${run.id}`),
                type: "message.updated" as const,
                threadId: run.threadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  id: MessageId.make(`message:reply:${run.id}`),
                  threadId: run.threadId,
                  runId: run.id,
                  nodeId: null,
                  role: "assistant" as const,
                  text: reply,
                  attachments: [],
                  streaming: false,
                  createdBy: "agent" as const,
                  creationSource: "server" as const,
                  createdAt: now,
                  updatedAt: now,
                },
              },
            ]),
        {
          id: EventId.make(`event:end:${run.id}:${status}`),
          type: "run.updated",
          threadId: run.threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status, startedAt: run.startedAt ?? now, completedAt: now },
        },
      ],
    });
  });

const returnResult = (run: OrchestrationV2Run) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.finalizeLinkTask(run.linkTask!.requester.threadId, run.threadId, run.id),
  );

const assignFailure = (input: Parameters<LinkService.LinkService["Service"]["assign"]>[0]) =>
  LinkService.LinkService.use((links) => links.assign(input)).pipe(
    Effect.result,
    Effect.map((result) => (Result.isFailure(result) ? result.failure.code : "assigned")),
  );

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))("link groups", (it) => {
  it.effect("returns a peer's final reply to the requester and wakes it", () =>
    Effect.gen(function* () {
      const links = yield* LinkService.LinkService;
      const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const fwai = yield* seedThread("wake-fwai", "fwai_code");
      const gateway = yield* seedThread("wake-gateway", "llm_gateway");
      const requesterRun = yield* sendUserMessage(fwai, "wake-start", "Wire the new endpoint");
      yield* links.create({
        name: "Gateway work",
        members: [
          { threadId: fwai, purpose: "owns fwai_code" },
          { threadId: gateway, purpose: "owns llm_gateway, follows its AGENTS.md" },
        ],
      });

      const peers = yield* links.peers(fwai);
      assert.deepEqual(peers, [
        {
          peerId: linkPeerId(gateway),
          linkName: "Gateway work",
          title: "llm_gateway thread",
          purpose: "owns llm_gateway, follows its AGENTS.md",
          location: "local",
          project: "llm_gateway",
          online: true,
          paused: false,
        },
      ]);

      const { taskId } = yield* links.assign({
        callerThreadId: fwai,
        peerId: peers[0]!.peerId,
        task: "Add a /v1/scopes endpoint",
      });
      const peerRun = yield* linkTaskRun(gateway, taskId);
      assert.deepEqual(peerRun.linkTask?.sender, {
        threadTitle: "fwai_code thread",
        projectTitle: "fwai_code",
        purpose: "owns fwai_code",
      });
      assert.deepEqual(peerRun.linkTask?.requester, { environmentId, threadId: fwai });
      assert.isUndefined(peerRun.actingAccountId);
      const task = yield* requesterTask(fwai, taskId);
      assert.deepEqual(task.assignee, { environmentId, threadId: gateway });
      assert.equal(task.link?.hop, 1);
      assert.equal(task.childThreadId, gateway);

      yield* endRun(requesterRun, "completed");
      yield* endRun(peerRun, "completed", "Added /v1/scopes with tests.");
      yield* returnResult(peerRun);

      const finished = yield* requesterTask(fwai, taskId);
      assert.equal(finished.status, "completed");
      assert.equal(finished.result, "Added /v1/scopes with tests.");
      const wake = yield* requests.take;
      assert.equal(wake.threadId, fwai);
      assert.equal(wake.delegatedCompletion?.parentRunId, requesterRun.id);
    }),
  );

  it.effect("runs a task for the account the requesting run acts for", () =>
    Effect.gen(function* () {
      const links = yield* LinkService.LinkService;
      const fwai = yield* seedThread("acting-fwai", "fwai_code");
      const gateway = yield* seedThread("acting-gateway", "llm_gateway");
      yield* sendUserMessage(fwai, "acting-start", "Wire it", "gateway-user-1");
      yield* links.create({
        name: "Acting",
        members: [
          { threadId: fwai, purpose: "owns fwai_code" },
          { threadId: gateway, purpose: "owns llm_gateway" },
        ],
      });
      const { taskId } = yield* links.assign({
        callerThreadId: fwai,
        peerId: linkPeerId(gateway),
        task: "Add a /v1/scopes endpoint",
      });
      assert.equal((yield* linkTaskRun(gateway, taskId)).actingAccountId, "gateway-user-1");
    }),
  );

  it.effect("lists the peer's reply in the chain once the task completes", () =>
    Effect.gen(function* () {
      const links = yield* LinkService.LinkService;
      const fwai = yield* seedThread("chain-reply-fwai", "fwai_code");
      const gateway = yield* seedThread("chain-reply-gateway", "llm_gateway");
      const requesterRun = yield* sendUserMessage(fwai, "chain-reply-start", "Wire it up");
      yield* links.create({
        name: "Chain reply",
        members: [
          { threadId: fwai, purpose: "owns fwai_code" },
          { threadId: gateway, purpose: "owns llm_gateway" },
        ],
      });
      const { taskId } = yield* links.assign({
        callerThreadId: fwai,
        peerId: linkPeerId(gateway),
        task: "Add a /v1/scopes endpoint",
      });
      const chainId = (yield* requesterTask(fwai, taskId)).link!.chainId;
      const open = yield* links.getChain(chainId);
      assert.equal(open.tasks[0]?.result, null);

      const peerRun = yield* linkTaskRun(gateway, taskId);
      yield* endRun(requesterRun, "completed");
      yield* endRun(peerRun, "completed", "Added /v1/scopes with tests.");
      yield* returnResult(peerRun);

      const chain = yield* links.getChain(chainId);
      assert.equal(chain.tasks[0]?.status, "completed");
      assert.equal(chain.tasks[0]?.result, "Added /v1/scopes with tests.");
    }),
  );

  it.effect("tells a linked thread about its peers only when something changed", () =>
    Effect.gen(function* () {
      const links = yield* LinkService.LinkService;
      const turns = yield* LinkTurnContext.LinkTurnContext;
      const fwai = yield* seedThread("aware-fwai", "fwai_code");
      const gateway = yield* seedThread("aware-gateway", "llm_gateway");
      const turnFor = (threadId: ThreadId, fresh = false) => turns.forTurn({ threadId, fresh });
      assert.isNull(yield* turnFor(fwai));

      yield* links.create({
        name: "Gateway work",
        members: [
          { threadId: fwai, purpose: "owns fwai_code" },
          { threadId: gateway, purpose: "owns llm_gateway" },
        ],
      });
      const first = (yield* turnFor(fwai))!;
      assert.include(
        first.text,
        `[${linkPeerId(gateway)}] llm_gateway thread: owns llm_gateway (local, project llm_gateway; idle)`,
      );
      assert.include(first.text, "t3_link_assign");
      yield* first.commit;
      assert.isNull(yield* turnFor(fwai));

      // The gateway thread finishes a run; the fwai thread's next turn hears only that.
      const run = yield* sendUserMessage(gateway, "aware-gateway-run", "Add scopes");
      yield* endRun(run, "completed", "## Added the /v1/scopes endpoint with tests. Docs too.");
      yield* links.recordActivity(gateway, run.id);
      const update = (yield* turnFor(fwai))!;
      assert.match(
        update.text,
        /· llm_gateway thread: \d{2}:\d{2}Z the user asked: Added the \/v1\/scopes endpoint with tests\. \(completed\)/,
      );
      assert.notInclude(update.text, "t3_link_assign");
      yield* update.commit;
      assert.isNull(yield* turnFor(fwai));
      // A provider history that lost earlier blocks gets the whole block again.
      assert.include((yield* turnFor(fwai, true))!.text, "t3_link_assign");

      const entries = yield* links.activity(fwai, linkPeerId(gateway));
      assert.deepEqual(
        entries.map((entry) => [entry.peerTitle, entry.askedBy, entry.summary, entry.outcome]),
        [
          [
            "llm_gateway thread",
            "the user",
            "Added the /v1/scopes endpoint with tests.",
            "completed",
          ],
        ],
      );
      // Recording the same run again changes nothing; the thread's own runs are not its peers'.
      yield* links.recordActivity(gateway, run.id);
      assert.lengthOf(yield* links.activity(fwai), 1);
      assert.deepEqual(yield* links.activity(gateway), []);
    }),
  );

  it.effect("refuses a task to a thread outside the caller's groups", () =>
    Effect.gen(function* () {
      const links = yield* LinkService.LinkService;
      const a = yield* seedThread("outside-a", "outside-a");
      const b = yield* seedThread("outside-b", "outside-b");
      const c = yield* seedThread("outside-c", "outside-c");
      const d = yield* seedThread("outside-d", "outside-d");
      yield* sendUserMessage(a, "outside-start", "Go");
      yield* links.create({
        name: "A and B",
        members: [
          { threadId: a, purpose: "" },
          { threadId: b, purpose: "" },
        ],
      });
      yield* links.create({
        name: "C and D",
        members: [
          { threadId: c, purpose: "" },
          { threadId: d, purpose: "" },
        ],
      });

      assert.equal(
        yield* assignFailure({ callerThreadId: a, peerId: linkPeerId(c), task: "x" }),
        "not_a_peer",
      );
      assert.equal(
        yield* assignFailure({ callerThreadId: a, peerId: linkPeerId(d), task: "x" }),
        "not_a_peer",
      );
    }),
  );

  it.effect("gives each peer a short id that adding members does not change", () =>
    Effect.gen(function* () {
      const links = yield* LinkService.LinkService;
      const a = yield* seedThread("short-a", "short-a");
      const b = yield* seedThread("short-b", "short-b");
      const c = yield* seedThread("short-c", "short-c");
      yield* sendUserMessage(a, "short-start", "Go");
      const { linkId } = yield* links.create({
        name: "A and B",
        members: [
          { threadId: a, purpose: "" },
          { threadId: b, purpose: "" },
        ],
      });
      const [peerId] = (yield* links.peers(a)).map((peer) => peer.peerId);
      assert.match(peerId!, /^p-[0-9a-f]{8}$/);
      yield* links.setMember({ linkId, threadId: c, purpose: "" });
      assert.include(
        (yield* links.peers(a)).map((peer) => peer.peerId),
        peerId,
      );

      assert.equal(
        yield* assignFailure({ callerThreadId: a, peerId: peerId!, task: "x" }),
        "assigned",
      );
      const wrong = yield* links
        .assign({ callerThreadId: a, peerId: "p-00000000", task: "x" })
        .pipe(Effect.flip);
      assert.equal(wrong.code, "not_a_peer");
      assert.include(wrong.message, peerId!);
    }),
  );

  it.effect("refuses the cycle A to B to C to A at the last hop, and chains over three hops", () =>
    Effect.gen(function* () {
      const links = yield* LinkService.LinkService;
      const names = ["cycle-a", "cycle-b", "cycle-c", "cycle-d", "cycle-e"] as const;
      const [a, b, c, d, e] = yield* Effect.forEach(names, (name) => seedThread(name, name));
      yield* sendUserMessage(a!, "cycle-start", "Start the chain");
      yield* links.create({
        name: "Ring",
        members: [a!, b!, c!, d!, e!].map((threadId) => ({ threadId, purpose: "" })),
      });
      const ab = yield* links.assign({
        callerThreadId: a!,
        peerId: linkPeerId(b!),
        task: "1",
      });
      const bc = yield* links.assign({
        callerThreadId: b!,
        peerId: linkPeerId(c!),
        task: "2",
      });
      assert.equal((yield* requesterTask(b!, bc.taskId)).link?.parentTaskId, ab.taskId);

      assert.equal(
        yield* assignFailure({ callerThreadId: c!, peerId: linkPeerId(a!), task: "3" }),
        "cycle",
      );
      assert.equal(
        yield* assignFailure({ callerThreadId: c!, peerId: linkPeerId(b!), task: "3" }),
        "cycle",
      );

      const cd = yield* links.assign({
        callerThreadId: c!,
        peerId: linkPeerId(d!),
        task: "3",
      });
      assert.equal((yield* requesterTask(c!, cd.taskId)).link?.hop, 3);
      assert.equal(
        yield* assignFailure({ callerThreadId: d!, peerId: linkPeerId(e!), task: "4" }),
        "hop_limit",
      );
    }),
  );

  it.effect("pausing refuses new tasks; dissolving removes the group", () =>
    Effect.gen(function* () {
      const links = yield* LinkService.LinkService;
      const a = yield* seedThread("pause-a", "pause-a");
      const b = yield* seedThread("pause-b", "pause-b");
      yield* sendUserMessage(a, "pause-start", "Go");
      const { linkId } = yield* links.create({
        name: "Pausable",
        members: [
          { threadId: a, purpose: "" },
          { threadId: b, purpose: "" },
        ],
      });
      yield* links.pause({ linkId });
      assert.equal(
        yield* assignFailure({ callerThreadId: a, peerId: linkPeerId(b), task: "x" }),
        "link_paused",
      );
      yield* links.resume({ linkId });
      assert.equal(
        yield* assignFailure({ callerThreadId: a, peerId: linkPeerId(b), task: "x" }),
        "assigned",
      );
      yield* links.end({ linkId });
      assert.isFalse((yield* links.snapshot).groups.some((group) => group.linkId === linkId));
      assert.deepEqual(yield* links.peers(a), []);
    }),
  );

  it.effect("archiving a member removes it from its groups", () =>
    Effect.gen(function* () {
      const links = yield* LinkService.LinkService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* Effect.forEach(["archive-a", "archive-b", "archive-c"], (name) =>
        seedThread(name, name),
      );
      const { linkId } = yield* links.create({
        name: "Three",
        members: threads.map((threadId) => ({ threadId, purpose: "" })),
      });
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("command:archive-c"),
        threadId: threads[2]!,
      });
      const group = yield* links.subscribe.pipe(
        Stream.map((snapshot) => snapshot.groups.find((row) => row.linkId === linkId)),
        Stream.filter((row) => row?.members.length === 2),
        Stream.runHead,
        Effect.map(Option.getOrUndefined),
      );
      assert.deepEqual(
        group?.members.map((member) => member.threadId),
        threads.slice(0, 2),
      );
    }),
  );

  it.effect("stopping mid-chain stops only that subtree and refuses the chain afterwards", () =>
    Effect.gen(function* () {
      const links = yield* LinkService.LinkService;
      const a = yield* seedThread("stop-a", "stop-a");
      const b = yield* seedThread("stop-b", "stop-b");
      const c = yield* seedThread("stop-c", "stop-c");
      yield* sendUserMessage(a, "stop-start", "Start the chain");
      yield* links.create({
        name: "Chain",
        members: [a, b, c].map((threadId) => ({ threadId, purpose: "" })),
      });
      const ab = yield* links.assign({
        callerThreadId: a,
        peerId: linkPeerId(b),
        task: "1",
      });
      const bRun = yield* linkTaskRun(b, ab.taskId);
      const unrelated = yield* sendUserMessage(b, "stop-unrelated", "Unrelated work");
      assert.equal(unrelated.status, "queued");
      const bc = yield* links.assign({
        callerThreadId: b,
        peerId: linkPeerId(c),
        task: "2",
      });
      const cRun = yield* linkTaskRun(c, bc.taskId);

      yield* links.stopTask({ requesterThreadId: a, taskId: ab.taskId, stoppedBy: "the user" });

      assert.equal((yield* requesterTask(a, ab.taskId)).link?.stoppedBy, "the user");
      assert.equal((yield* requesterTask(b, bc.taskId)).link?.stoppedBy, "the user");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const bAfter = yield* orchestrator.getThreadProjection(b);
      const cAfter = yield* orchestrator.getThreadProjection(c);
      assert.equal(bAfter.runs.find((run) => run.id === bRun.id)?.status, "interrupted");
      assert.equal(cAfter.runs.find((run) => run.id === cRun.id)?.status, "interrupted");
      // Untouched: it was waiting for B to be free, and starts as it would have anyway.
      assert.equal(bAfter.runs.find((run) => run.id === unrelated.id)?.status, "starting");

      yield* returnResult(cRun);
      yield* returnResult(bRun);
      const stopped = yield* requesterTask(a, ab.taskId);
      assert.equal(stopped.status, "cancelled");
      assert.equal(stopped.result, "Stopped by the user.");

      assert.equal(
        yield* assignFailure({ callerThreadId: a, peerId: linkPeerId(c), task: "again" }),
        "chain_stopped",
      );
      const chain = yield* links.getChain(stopped.link!.chainId);
      assert.isTrue(chain.stopped);
      assert.deepEqual(
        chain.tasks.map((task) => task.status),
        ["stopped", "stopped"],
      );
    }),
  );
});

const organization = { id: "org_1", role: "member" as const, projectIds: [] };

/** fwai Connect in miniature: sets the acting account from the sender's environment. */
interface Network {
  readonly owners: Record<string, string>;
  readonly online: Set<string>;
  readonly receivers: Map<string, (delivery: RelayLinkDelivery) => Effect.Effect<RelayLinkReceipt>>;
  readonly sent: Array<RelayLinkEnvelope>;
}

const fakeRelay = (network: Network, self: EnvironmentId): LinkRelay.LinkRelay["Service"] => {
  const relation = (target: string) =>
    network.owners[target] === network.owners[self]
      ? ("same_account" as const)
      : ("shared" as const);
  const reachable = (target: string) => network.online.has(target) && network.receivers.has(target);
  return {
    send: (envelope) =>
      Effect.gen(function* () {
        network.sent.push(envelope);
        if (envelope.sender.environmentId !== self) return { outcome: "not_authorized" as const };
        const target = envelope.target.environmentId;
        if (!reachable(target)) return { outcome: "peer_offline" as const };
        const receipt = yield* network.receivers.get(target)!({
          ...envelope,
          actingAccountId: network.owners[self]!,
          actingOrganization: organization,
          relation: relation(target),
          receivedAt: "2026-11-12T00:00:00.000Z",
        });
        return { outcome: "delivered" as const, receipt };
      }),
    presence: (request) =>
      Effect.succeed({
        peers: request.targets.map((target) => ({
          ...target,
          authorized: true,
          online: reachable(target.environmentId),
          relation: relation(target.environmentId),
        })),
      }),
  };
};

const layerNetworked = (network: Network, id: EnvironmentId) =>
  Layer.merge(layerEnvironment(id, fakeRelay(network, id)), ProviderContinuationRequests.layer);
type EnvironmentServices = Layer.Success<ReturnType<typeof layerNetworked>>;

/** Starts an environment on the network; the returned function runs an effect inside it. */
const joinNetwork = (network: Network, id: EnvironmentId) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(layerNetworked(network, id));
    const inside = <A, E>(effect: Effect.Effect<A, E, EnvironmentServices>) =>
      Effect.provideContext(effect, context);
    network.receivers.set(id, (delivery) =>
      inside(LinkService.LinkService.use((links) => links.receive(delivery))),
    );
    network.online.add(id);
    return inside;
  });

const makeNetwork = (owners: Record<string, string>): Network => ({
  owners,
  online: new Set(),
  receivers: new Map(),
  sent: [],
});

const shareWith = (threadId: ThreadId, accountId: string, requireApproval: boolean) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.dispatch({
      type: "thread.share.grant",
      commandId: CommandId.make(`command:share:${threadId}:${accountId}`),
      threadId,
      share: {
        id: ThreadShareId.make(`share:${threadId}:${accountId}`),
        target: { kind: "account", id: accountId, label: accountId },
        role: "collaborator",
        requireApproval,
        status: "active",
        grantedAt: "2026-11-12T00:00:00.000Z",
      },
    }),
  );

/** Stands in for the provider: the run moves to `status` without ending. */
const moveRun = (run: OrchestrationV2Run, status: OrchestrationV2Run["status"]) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:move:${run.id}:${status}`),
          type: "run.updated",
          threadId: run.threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status, startedAt: run.startedAt ?? now },
        },
      ],
    });
  });

const reportRun = (run: OrchestrationV2Run) =>
  LinkService.LinkService.use((links) => links.returnRemoteResult(run.threadId, run.id));

const laptop = EnvironmentId.make("env-laptop");
const server = EnvironmentId.make("env-server");
const office = EnvironmentId.make("env-office");

it.effect("links one account's laptop and server without a share, both ways", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const network = makeNetwork({ [laptop]: "alice", [server]: "alice" });
      const onLaptop = yield* joinNetwork(network, laptop);
      const onServer = yield* joinNetwork(network, server);
      const mine = yield* onLaptop(seedThread("laptop", "fwai_code"));
      const theirs = yield* onServer(seedThread("server", "staging"));

      yield* onLaptop(
        LinkService.LinkService.use((links) =>
          links.create({
            name: "Release",
            members: [
              { threadId: mine, purpose: "owns fwai_code" },
              {
                threadId: theirs,
                environmentId: server,
                purpose: "owns staging",
                title: "staging",
              },
            ],
          }),
        ),
      );
      const serverPeers = yield* onServer(
        LinkService.LinkService.use((links) => links.peers(theirs)),
      );
      assert.deepEqual(
        serverPeers.map((peer) => [peer.peerId, peer.location, peer.online, peer.requiresApproval]),
        [[linkPeerId(mine), "remote", true, false]],
      );

      const requesterRun = yield* onLaptop(sendUserMessage(mine, "laptop-start", "Ship it"));
      const { taskId } = yield* onLaptop(
        LinkService.LinkService.use((links) =>
          links.assign({
            callerThreadId: mine,
            peerId: linkPeerId(theirs),
            task: "Deploy the release to staging",
          }),
        ),
      );
      const peerRun = yield* onServer(linkTaskRun(theirs, taskId));
      assert.deepEqual(peerRun.linkTask?.requester, { environmentId: laptop, threadId: mine });
      assert.deepEqual(peerRun.linkTask?.sender.remote, {
        environmentId: laptop,
        accountId: "alice",
        owner: null,
      });
      assert.equal(peerRun.runtimeModeCeiling, "full-access");
      // The same account's other environment is its owner here.
      assert.isUndefined(peerRun.actingAccountId);
      const recorded = yield* onLaptop(requesterTask(mine, taskId));
      assert.deepEqual(recorded.assignee, { environmentId: server, threadId: theirs });
      assert.equal(recorded.childThreadId, null);

      yield* onLaptop(endRun(requesterRun, "completed"));
      yield* onServer(endRun(peerRun, "completed", "Deployed 1.4.2 to staging."));
      yield* onServer(reportRun(peerRun));
      const finished = yield* onLaptop(requesterTask(mine, taskId));
      assert.equal(finished.status, "completed");
      assert.equal(finished.result, "Deployed 1.4.2 to staging.");
      const wake = yield* onLaptop(
        ProviderContinuationRequests.ProviderContinuationRequests.use((requests) => requests.take),
      );
      assert.equal(wake.threadId, mine);

      // The server's agent assigns back; the result returns the same way.
      const serverRun = yield* onServer(sendUserMessage(theirs, "server-start", "Check it"));
      const back = yield* onServer(
        LinkService.LinkService.use((links) =>
          links.assign({
            callerThreadId: theirs,
            peerId: linkPeerId(mine),
            task: "Bump the changelog",
          }),
        ),
      );
      const laptopRun = yield* onLaptop(linkTaskRun(mine, back.taskId));
      yield* onServer(endRun(serverRun, "completed"));
      yield* onLaptop(endRun(laptopRun, "completed", "Changelog bumped."));
      yield* onLaptop(reportRun(laptopRun));
      assert.equal(
        (yield* onServer(requesterTask(theirs, back.taskId))).result,
        "Changelog bumped.",
      );
    }),
  ),
);

it.effect("crosses accounts only through shares, and waits for the owner's approval", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const network = makeNetwork({ [laptop]: "alice", [office]: "bob" });
      const onLaptop = yield* joinNetwork(network, laptop);
      const onOffice = yield* joinNetwork(network, office);
      const mine = yield* onLaptop(seedThread("alice", "fwai_code"));
      const bobs = yield* onOffice(seedThread("bob", "llm_gateway"));
      // Bob shared his thread with Alice, asking to approve; the picker shared hers back.
      yield* onOffice(shareWith(bobs, "alice", true));
      yield* onLaptop(shareWith(mine, "bob", true));

      yield* onLaptop(
        LinkService.LinkService.use((links) =>
          links.create({
            name: "Scopes",
            members: [
              { threadId: mine, purpose: "owns fwai_code" },
              {
                threadId: bobs,
                environmentId: office,
                purpose: "owns llm_gateway",
                owner: "bob",
              },
            ],
          }),
        ),
      );
      const peers = yield* onLaptop(LinkService.LinkService.use((links) => links.peers(mine)));
      assert.deepEqual(
        peers.map((peer) => [peer.location, peer.owner, peer.requiresApproval]),
        [["remote", "bob", true]],
      );

      const requesterRun = yield* onLaptop(sendUserMessage(mine, "alice-start", "Add scopes"));
      const { taskId } = yield* onLaptop(
        LinkService.LinkService.use((links) =>
          links.assign({
            callerThreadId: mine,
            peerId: linkPeerId(bobs),
            task: "Add a scopes endpoint",
          }),
        ),
      );
      const bobRun = yield* onOffice(linkTaskRun(bobs, taskId));
      assert.equal(bobRun.runtimeModeCeiling, "approval-required");
      assert.equal(bobRun.actingAccountId, "alice");

      yield* onOffice(moveRun(bobRun, "waiting"));
      yield* onOffice(reportRun(bobRun));
      const waiting = yield* onLaptop(requesterTask(mine, taskId));
      assert.equal(waiting.link?.remoteState, "waiting_for_owner_approval");
      const chain = yield* onLaptop(
        LinkService.LinkService.use((links) => links.getChain(waiting.link!.chainId)),
      );
      assert.deepEqual(
        chain.tasks.map((task) => task.status),
        ["waiting_for_owner_approval"],
      );

      // Bob approves: the run goes on, then ends.
      yield* onOffice(moveRun(bobRun, "running"));
      yield* onOffice(reportRun(bobRun));
      assert.equal((yield* onLaptop(requesterTask(mine, taskId))).link?.remoteState, undefined);
      yield* onLaptop(endRun(requesterRun, "completed"));
      yield* onOffice(endRun(bobRun, "completed", "Added /v1/scopes."));
      yield* onOffice(reportRun(bobRun));
      assert.equal((yield* onLaptop(requesterTask(mine, taskId))).result, "Added /v1/scopes.");

      // Bob's agent assigns back; it runs under Alice's approval setting.
      yield* onOffice(sendUserMessage(bobs, "bob-start", "Tell the client"));
      const back = yield* onOffice(
        LinkService.LinkService.use((links) =>
          links.assign({
            callerThreadId: bobs,
            peerId: linkPeerId(mine),
            task: "Call /v1/scopes from the client",
          }),
        ),
      );
      const aliceRun = yield* onLaptop(linkTaskRun(mine, back.taskId));
      assert.equal(aliceRun.runtimeModeCeiling, "approval-required");
      assert.deepEqual(aliceRun.linkTask?.sender.remote?.accountId, "bob");
      assert.equal(aliceRun.actingAccountId, "bob");
    }),
  ),
);

it.effect("refuses a colleague's thread that is not shared back, and an offline peer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const network = makeNetwork({ [laptop]: "alice", [office]: "bob" });
      const onLaptop = yield* joinNetwork(network, laptop);
      const onOffice = yield* joinNetwork(network, office);
      const mine = yield* onLaptop(seedThread("refuse-alice", "fwai_code"));
      const bobs = yield* onOffice(seedThread("refuse-bob", "llm_gateway"));
      yield* onLaptop(
        LinkService.LinkService.use((links) =>
          links.create({
            name: "Unshared",
            members: [
              { threadId: mine, purpose: "" },
              { threadId: bobs, environmentId: office, purpose: "" },
            ],
          }),
        ),
      );
      yield* onLaptop(sendUserMessage(mine, "refuse-start", "Try"));
      const assign = onLaptop(
        assignFailure({ callerThreadId: mine, peerId: linkPeerId(bobs), task: "Do it" }),
      );
      // Bob never shared his thread, so his environment refuses.
      assert.equal(yield* assign, "not_authorized");

      yield* onOffice(shareWith(bobs, "alice", false));
      network.online.delete(office);
      assert.equal(yield* assign, "peer_offline");
      network.online.add(office);
      assert.equal(yield* assign, "assigned");
    }),
  ),
);

it.effect("drops a colleague's thread from the group when its owner settles it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const network = makeNetwork({ [laptop]: "alice", [office]: "bob" });
      const onLaptop = yield* joinNetwork(network, laptop);
      const onOffice = yield* joinNetwork(network, office);
      const mine = yield* onLaptop(seedThread("settle-alice", "fwai_code"));
      const bobs = yield* onOffice(seedThread("settle-bob", "llm_gateway"));
      const third = yield* onLaptop(seedThread("settle-third", "docs"));
      yield* onOffice(shareWith(bobs, "alice", true));
      yield* onLaptop(shareWith(mine, "bob", true));
      const { linkId } = yield* onLaptop(
        LinkService.LinkService.use((links) =>
          links.create({
            name: "Settling",
            members: [
              { threadId: mine, purpose: "" },
              { threadId: third, purpose: "" },
              { threadId: bobs, environmentId: office, purpose: "" },
            ],
          }),
        ),
      );
      assert.lengthOf(
        yield* onLaptop(LinkService.LinkService.use((links) => links.peers(mine))),
        2,
      );

      yield* onOffice(
        Orchestrator.OrchestratorV2.use((orchestrator) =>
          orchestrator.dispatch({
            type: "thread.settle",
            commandId: CommandId.make("command:settle:bob"),
            threadId: bobs,
          }),
        ),
      );
      const group = yield* onLaptop(
        LinkService.LinkService.use((links) =>
          links.subscribe.pipe(
            Stream.map((snapshot) =>
              snapshot.groups.find((candidate) => candidate.linkId === linkId),
            ),
            Stream.filter(
              (candidate) => !candidate?.members.some((member) => member.threadId === bobs),
            ),
            Stream.runHead,
          ),
        ),
      );
      assert.deepEqual(
        Option.getOrThrow(group)?.members.map((member) => member.threadId),
        [mine, third],
      );
      const peers = yield* onLaptop(LinkService.LinkService.use((links) => links.peers(mine)));
      assert.deepEqual(
        peers.map((peer) => peer.peerId),
        [linkPeerId(third)],
      );
    }),
  ),
);

it.effect("ignores a member view older than the one it holds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const network = makeNetwork({ [laptop]: "alice", [server]: "alice" });
      const onLaptop = yield* joinNetwork(network, laptop);
      const onServer = yield* joinNetwork(network, server);
      const mine = yield* onLaptop(seedThread("laptop", "fwai_code"));
      const theirs = yield* onServer(seedThread("server", "staging"));
      const { linkId } = yield* onLaptop(
        LinkService.LinkService.use((links) =>
          links.create({
            name: "Release",
            members: [
              { threadId: mine, purpose: "owns fwai_code" },
              { threadId: theirs, environmentId: server, purpose: "owns staging" },
            ],
          }),
        ),
      );
      yield* onLaptop(
        LinkService.LinkService.use((links) =>
          links.setMember({ linkId, threadId: mine, purpose: "owns the release" }),
        ),
      );
      const views = network.sent.filter((envelope) => envelope.body.kind === "member-joined");
      assert.equal(views.length, 2);
      const [first, second] = views;
      assert.isTrue(
        first!.body.kind === "member-joined" &&
          second!.body.kind === "member-joined" &&
          (first!.body.version ?? 0) < (second!.body.version ?? 0),
      );

      // The relay replays the first view after the second arrived.
      const receipt = yield* network.receivers.get(server)!({
        ...first!,
        actingAccountId: "alice",
        actingOrganization: organization,
        relation: "same_account",
        receivedAt: "2026-11-12T00:00:00.000Z",
      });
      assert.isTrue(receipt.accepted);
      const peers = yield* onServer(LinkService.LinkService.use((links) => links.peers(theirs)));
      assert.deepEqual(
        peers.map((peer) => peer.purpose),
        ["owns the release"],
      );
    }),
  ),
);

it.effect("carries a remote member's activity through the relay into the context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const network = makeNetwork({ [laptop]: "alice", [server]: "alice" });
      const onLaptop = yield* joinNetwork(network, laptop);
      const onServer = yield* joinNetwork(network, server);
      const mine = yield* onLaptop(seedThread("activity-laptop", "fwai_code"));
      const theirs = yield* onServer(seedThread("activity-server", "staging"));
      yield* onLaptop(
        LinkService.LinkService.use((links) =>
          links.create({
            name: "Release",
            members: [
              { threadId: mine, purpose: "owns fwai_code" },
              {
                threadId: theirs,
                environmentId: server,
                purpose: "owns staging",
                title: "staging",
              },
            ],
          }),
        ),
      );
      const before = (yield* onLaptop(
        LinkTurnContext.LinkTurnContext.use((turns) =>
          turns.forTurn({ threadId: mine, fresh: false }),
        ),
      ))!;
      assert.include(before.text, `[${linkPeerId(theirs)}] staging: owns staging (remote; online)`);
      yield* onLaptop(before.commit);

      const run = yield* onServer(sendUserMessage(theirs, "activity-server-run", "Deploy"));
      yield* onServer(endRun(run, "failed", "Deploy failed: the staging database is down."));
      yield* onServer(LinkService.LinkService.use((links) => links.recordActivity(theirs, run.id)));
      assert.isTrue(
        network.sent.some(
          (envelope) =>
            envelope.body.kind === "activity" &&
            envelope.target.environmentId === laptop &&
            envelope.target.threadId === mine,
        ),
      );

      const entries = yield* onLaptop(
        LinkService.LinkService.use((links) => links.activity(mine, linkPeerId(theirs))),
      );
      assert.deepEqual(
        entries.map((entry) => [entry.peerTitle, entry.summary, entry.outcome]),
        [["staging", "Deploy failed: the staging database is down.", "failed"]],
      );
      const update = (yield* onLaptop(
        LinkTurnContext.LinkTurnContext.use((turns) =>
          turns.forTurn({ threadId: mine, fresh: false }),
        ),
      ))!;
      assert.include(
        update.text,
        "the user asked: Deploy failed: the staging database is down. (failed)",
      );

      // The server's own context lists the laptop thread as a remote peer.
      const serverView = (yield* onServer(
        LinkTurnContext.LinkTurnContext.use((turns) =>
          turns.forTurn({ threadId: theirs, fresh: false }),
        ),
      ))!;
      assert.include(
        serverView.text,
        `[${linkPeerId(mine)}] fwai_code thread: owns fwai_code (remote; online)`,
      );
    }),
  ),
);

it("caps a long reply in the chain and marks the cut", () => {
  const long = "x".repeat(LinkService.LINK_CHAIN_RESULT_MAX_LENGTH + 10);
  const capped = LinkService.chainTaskResult(long)!;
  assert.isTrue(capped.startsWith("x".repeat(LinkService.LINK_CHAIN_RESULT_MAX_LENGTH)));
  assert.isTrue(capped.endsWith("Open the thread for the full text.]"));
  assert.equal(LinkService.chainTaskResult("  done  "), "done");
  assert.equal(LinkService.chainTaskResult("   "), null);
  assert.equal(LinkService.chainTaskResult(null), null);
});
