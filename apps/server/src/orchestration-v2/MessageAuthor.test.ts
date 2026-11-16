import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { withMessageAuthor } from "./ThreadManagementService.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for message authors"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "message-author" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const threadId = ThreadId.make("thread:message-author");

const message = (id: string) =>
  ({
    type: "message.dispatch",
    commandId: CommandId.make(id),
    threadId,
    messageId: MessageId.make(id),
    text: "Hello",
    attachments: [],
    createdBy: "user",
    creationSource: "web",
  }) as const;

it("replaces any author a client claims with the session's account", () => {
  const claimed = {
    ...message("claimed"),
    authorAccountId: "someone-else",
    dispatchMode: { type: "defer_start" as const },
  };
  assert.equal(
    (withMessageAuthor(claimed, "gateway-user-1") as { authorAccountId?: string }).authorAccountId,
    "gateway-user-1",
  );
  assert.notProperty(withMessageAuthor(claimed, undefined), "authorAccountId");
  const ceilingClaimed = { ...claimed, runtimeModeCeiling: "full-access" as const };
  assert.notProperty(withMessageAuthor(ceilingClaimed, undefined), "runtimeModeCeiling");
  assert.equal(
    (
      withMessageAuthor(ceilingClaimed, "gateway-user-1", "approval-required") as {
        runtimeModeCeiling?: string;
      }
    ).runtimeModeCeiling,
    "approval-required",
  );
});

it.effect("keeps the author on the message and its timeline item", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-message-author"),
      threadId,
      projectId: ProjectId.make("project:message-author"),
      title: "Authors",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      ...message("authored"),
      authorAccountId: "gateway-user-1",
      runtimeModeCeiling: "approval-required",
      dispatchMode: { type: "defer_start" },
    });
    yield* orchestrator.dispatch({ ...message("local"), dispatchMode: { type: "defer_start" } });

    const projection = yield* projections.getThreadProjection(threadId);
    const byId = (id: string) => projection.messages.find((item) => item.id === MessageId.make(id));
    assert.equal(byId("authored")?.authorAccountId, "gateway-user-1");
    assert.isUndefined(byId("local")?.authorAccountId);
    const item = projection.turnItems.find(
      (turnItem) =>
        turnItem.type === "user_message" && turnItem.messageId === MessageId.make("authored"),
    );
    assert.equal(item?.type === "user_message" ? item.authorAccountId : null, "gateway-user-1");
    const runOf = (id: string) =>
      projection.runs.find((run) => run.userMessageId === MessageId.make(id));
    assert.equal(runOf("authored")?.runtimeModeCeiling, "approval-required");
    assert.isUndefined(runOf("local")?.runtimeModeCeiling);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("names the collaborator whose message started the run on its pending approval", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-requester"),
      threadId,
      projectId: ProjectId.make("project:message-author"),
      title: "Requesters",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      ...message("collaborator"),
      authorAccountId: "gateway-user-1",
      dispatchMode: { type: "defer_start" },
    });
    yield* orchestrator.dispatch({ ...message("owner"), dispatchMode: { type: "defer_start" } });
    const projection = yield* projections.getThreadProjection(threadId);
    const runOf = (id: string) =>
      projection.runs.find((run) => run.userMessageId === MessageId.make(id))!.id;

    const approvalFor = (runId: ReturnType<typeof runOf>) =>
      ingestor
        .normalize({
          providerSessionId: ProviderSessionId.make("session:requester"),
          providerInstanceId: instanceId,
          threadId,
          runId,
          event: {
            type: "runtime_request.updated",
            driver: ProviderDriverKind.make("codex"),
            threadId,
            runtimeRequest: {
              id: RuntimeRequestId.make(`request:${runId}`),
              nodeId: NodeId.make(`node:${runId}`),
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "command",
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: projection.thread.createdAt,
              resolvedAt: null,
            },
          },
        })
        .pipe(
          Effect.map((events) => {
            const event = events[0];
            return event?.type === "runtime-request.updated"
              ? event.payload.requestedByAccountId
              : "not a runtime request";
          }),
        );
    assert.equal(yield* approvalFor(runOf("collaborator")), "gateway-user-1");
    assert.isUndefined(yield* approvalFor(runOf("owner")));
  }).pipe(Effect.provide(layerTest)),
);
