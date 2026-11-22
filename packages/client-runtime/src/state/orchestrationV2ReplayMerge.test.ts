import { describe, expect, it } from "vite-plus/test";
import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { mergeThreadReplay } from "@t3tools/shared/orchestrationV2ReplayMerge";
import * as DateTime from "effect/DateTime";

import {
  applyOrchestrationV2ProjectionEvent,
  type ApplyOrchestrationV2ProjectionEventOptions,
} from "./orchestrationV2Projection.ts";

const at = (second: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 21, 0, 0, second));
const threadId = ThreadId.make("thread-merge");
const runId = RunId.make("run-merge");
const instance = ProviderInstanceId.make("claude");

const run = (status: OrchestrationV2Run["status"]) =>
  ({
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: instance,
    modelSelection: { instanceId: instance, model: "model" },
    providerThreadId: null,
    userMessageId: MessageId.make("message-user"),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: at(0),
    startedAt: at(0),
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  }) satisfies OrchestrationV2Run;

const base = {
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  title: null,
  startedAt: at(0),
  completedAt: null,
  updatedAt: at(0),
};

const reasoning = (id: string, text: string, ordinal: number, done = false) =>
  ({
    ...base,
    id: TurnItemId.make(id),
    ordinal,
    status: done ? "completed" : "running",
    type: "reasoning",
    text,
    streaming: !done,
  }) as unknown as OrchestrationV2TurnItem;

const command = (id: string, output: string, ordinal: number, done = false) =>
  ({
    ...base,
    id: TurnItemId.make(id),
    ordinal,
    status: done ? "completed" : "running",
    type: "command_execution",
    input: "ls",
    output,
    exitCode: done ? 0 : null,
  }) as unknown as OrchestrationV2TurnItem;

const providerTurn = (status: string, tokens: number | undefined) => ({
  id: ProviderTurnId.make("provider-turn"),
  providerThreadId: ProviderThreadId.make("provider-thread"),
  nodeId: NodeId.make("node-root"),
  runAttemptId: null,
  nativeTurnRef: null,
  ordinal: 1,
  status,
  startedAt: at(0),
  completedAt: null,
  tokenUsage:
    tokens === undefined
      ? undefined
      : { usedTokens: tokens, maxTokens: 200_000, updatedAt: "2026-11-21T00:00:00.000Z" },
});

const emptyProjection = {
  thread: {
    id: threadId,
    projectId: ProjectId.make("project-merge"),
    title: "Merge",
    providerInstanceId: instance,
    modelSelection: { instanceId: instance, model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: at(0),
} as unknown as OrchestrationV2ThreadProjection;

type Item = {
  readonly kind: "event";
  readonly sequence: number;
  readonly event: OrchestrationV2DomainEvent;
};

function sequenced(payloads: ReadonlyArray<readonly [string, unknown]>): Item[] {
  return payloads.map(([type, payload], index) => ({
    kind: "event",
    sequence: 100 + index * 3,
    event: {
      id: `event-${index}`,
      type,
      threadId,
      runId,
      occurredAt: at(index),
      payload,
    } as OrchestrationV2DomainEvent,
  }));
}

function apply(
  start: OrchestrationV2ThreadProjection,
  items: ReadonlyArray<Item>,
  options?: ApplyOrchestrationV2ProjectionEventOptions,
) {
  let projection: OrchestrationV2ThreadProjection | null = start;
  for (const item of items) {
    projection = applyOrchestrationV2ProjectionEvent(projection, item.event, options);
  }
  // The merged survivor carries its last version's time, so the projection's
  // updatedAt can trail by the replay window; it is not part of the content.
  return projection === null ? null : { ...projection, updatedAt: null };
}

function merged(items: ReadonlyArray<Item>): ReadonlyArray<Item> {
  const result = mergeThreadReplay(items);
  if (result.mode !== "replay") throw new Error("expected a merged replay");
  return result.items;
}

// An active run as the store records it: interleaved streaming updates of
// several entities plus events that must stay in place.
const activeRun = sequenced([
  ["run.updated", run("running")],
  ["message.updated", { id: "message-assistant", threadId, runId, role: "assistant", text: "" }],
  ["turn-item.updated", reasoning("item-think-1", "I", 10)],
  ["node.updated", { id: "node-root", threadId, runId, status: "running" }],
  ["turn-item.updated", reasoning("item-think-1", "I will", 10)],
  ["provider-turn.updated", providerTurn("running", 1_000)],
  ["turn-item.updated", command("item-ls", "", 11)],
  ["turn-item.updated", reasoning("item-think-1", "I will list", 10)],
  ["turn-item.updated", command("item-ls", "a\n", 11)],
  ["message.updated", { id: "message-assistant", threadId, runId, role: "assistant", text: "Hi" }],
  ["node.updated", { id: "node-root", threadId, runId, status: "waiting" }],
  ["turn-item.updated", command("item-ls", "a\nb\n", 11, true)],
  ["turn-item.updated", reasoning("item-think-1", "I will list files", 10, true)],
  ["turn-item.updated", reasoning("item-think-2", "Done", 12)],
  ["provider-turn.updated", providerTurn("completed", undefined)],
  ["turn-item.updated", reasoning("item-think-2", "Done.", 12, true)],
  ["message.updated", { id: "message-assistant", threadId, runId, role: "assistant", text: "Hi!" }],
  ["node.updated", { id: "node-root", threadId, runId, status: "completed" }],
  ["run.updated", run("completed")],
]);

describe("mergeThreadReplay", () => {
  it("gives the same projection as applying every event, with fewer events", () => {
    const result = merged(activeRun);
    expect(result.length).toBeLessThan(activeRun.length);
    expect(apply(emptyProjection, result)).toEqual(apply(emptyProjection, activeRun));
  });

  it("gives the same projection in a partial timeline", () => {
    const loaded = apply(emptyProjection, activeRun.slice(0, 3))!;
    const start = { ...loaded, updatedAt: at(0) };
    const partial = { partialTimeline: true, latestLocalTurnOrdinal: 10 } as const;
    const rest = activeRun.slice(3);
    expect(apply(start, merged(rest), partial)).toEqual(apply(start, rest, partial));
  });

  it("keeps sequences increasing at each entity's first position", () => {
    const result = merged(activeRun);
    const sequences = result.map((item) => item.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    const think = result.filter(
      (item) => item.event.type === "turn-item.updated" && item.event.payload.id === "item-think-1",
    );
    expect(think.map((item) => item.sequence)).toEqual([activeRun[2]!.sequence]);
    expect(think[0]?.event.type === "turn-item.updated" && think[0].event.payload).toMatchObject({
      status: "completed",
    });
  });

  it("reaches the same state when delivery is cut off and the client resumes from its cursor", () => {
    const expected = apply(emptyProjection, activeRun);
    const result = merged(activeRun);
    for (let cut = 0; cut <= result.length; cut += 1) {
      const delivered = result.slice(0, cut);
      const cursor = delivered.at(-1)?.sequence ?? 0;
      const partway = apply(emptyProjection, delivered)!;
      const next = merged(activeRun.filter((item) => item.sequence > cursor));
      expect(apply({ ...partway, updatedAt: at(0) }, next)).toEqual(expected);
    }
  });

  it("does not merge across a change of a turn item's ordinal", () => {
    const moves = sequenced([
      ["turn-item.updated", command("item-move", "1", 5)],
      ["turn-item.updated", command("item-other", "x", 6)],
      ["turn-item.updated", command("item-move", "2", 7)],
      ["turn-item.updated", command("item-move", "3", 5)],
    ]);
    const result = merged(moves);
    expect(result).toHaveLength(4);
    expect(apply(emptyProjection, result)).toEqual(apply(emptyProjection, moves));
  });

  it("keeps updates that read the previous version", () => {
    const turns = activeRun.filter((item) => item.event.type === "provider-turn.updated");
    expect(merged(turns)).toEqual(turns);
    expect(apply(emptyProjection, merged(activeRun))?.providerTurns[0]?.tokenUsage).toMatchObject({
      usedTokens: 1_000,
    });
  });

  it("falls back to a snapshot when the range removes state", () => {
    const rollback = sequenced([
      ["turn-item.updated", command("item-ls", "a", 11)],
      ["run.updated", run("rolled_back")],
    ]);
    expect(mergeThreadReplay(rollback)).toEqual({ mode: "snapshot" });
    const deleted = sequenced([["thread.deleted", emptyProjection.thread]]);
    expect(mergeThreadReplay(deleted)).toEqual({ mode: "snapshot" });
  });
});
