/** The brain's T3 port on the server's own services: no MCP hop, and no MCP runtime-mode ceiling. */
import {
  CommandId,
  MessageId,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as ServerConfig from "../config.ts";
import * as Project from "../project/ProjectService.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ServerSettings from "../serverSettings.ts";
import { T3Error, type VoiceT3, type VoiceThread } from "./sessions.ts";

export class VoiceT3Refused extends Schema.TaggedError<VoiceT3Refused>()("VoiceT3Refused", {
  message: Schema.String,
}) {}

const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === "object" && error && "message" in error
      ? String(error.message)
      : String(error);

const toVoiceThread = (shell: OrchestrationV2ThreadShell): VoiceThread => ({
  threadId: shell.id,
  projectId: shell.projectId,
  title: shell.title,
  status: shell.activityRunStatus ?? shell.status,
  latestRunId: shell.latestRunId,
  itemCount: shell.itemCount,
  updatedAt: DateTime.toEpochMillis(shell.updatedAt),
  pendingRequest: shell.pendingRuntimeRequest && {
    id: shell.pendingRuntimeRequest.id,
    kind: shell.pendingRuntimeRequest.kind,
  },
});

/** What launching a thread needs beyond the services read at construction. */
type Services =
  | ThreadLaunch.ThreadLaunchService
  | Crypto.Crypto
  | FileSystem.FileSystem
  | ServerConfig.ServerConfig
  | DocumentText.DocumentText;

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* Project.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const run = Effect.runPromiseExitWith(yield* Effect.context<Services>());
  const call = async <A, E>(operation: string, effect: Effect.Effect<A, E, Services>) => {
    const exit = await run(effect.pipe(Effect.withSpan(`VoiceT3.${operation}`)));
    if (Exit.isSuccess(exit)) return exit.value;
    throw new T3Error(`${operation}: ${message(Cause.squash(exit.cause))}`);
  };
  const newId = Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4()),
    Effect.orDie,
    Effect.map((id) => CommandId.make(`voice:${id}`)),
  );
  const shellOf = (threadId: string) =>
    threads.getThreadShell(ThreadId.make(threadId)).pipe(
      Effect.filterOrFail(
        (shell): shell is NonNullable<typeof shell> => shell !== null && shell.deletedAt === null,
        () => new VoiceT3Refused({ message: "这个 session 已经不在了" }),
      ),
    );

  const t3: VoiceT3 = {
    projects: () =>
      call(
        "projects",
        Effect.map(projects.snapshot, (snapshot) =>
          snapshot.projects
            .filter((p) => p.deletedAt === null)
            .map((p) => ({ id: p.id, title: p.title })),
        ),
      ),
    threads: () =>
      call(
        "threads",
        Effect.map(threads.getShellSnapshot(), (snapshot) =>
          snapshot.threads
            .filter((t) => t.archivedAt === null && t.lineage.relationshipToParent !== "subagent")
            .map(toVoiceThread),
        ),
      ),
    send: (threadId, text, mode) =>
      call(
        "send",
        Effect.gen(function* () {
          const shell = yield* shellOf(threadId);
          const commandId = yield* newId;
          yield* threads.sendToThread({
            projectId: shell.projectId,
            commandId,
            threadId: shell.id,
            messageId: MessageId.make(commandId),
            text,
            attachments: [],
            mode,
            createdBy: "user",
            creationSource: "server",
          });
        }),
      ),
    interrupt: (threadId) =>
      call(
        "interrupt",
        Effect.gen(function* () {
          const shell = yield* shellOf(threadId);
          yield* threads.interruptThread({
            projectId: shell.projectId,
            threadId: shell.id,
            commandId: yield* newId,
            reason: "voice",
          });
        }),
      ),
    lastExchange: (threadId) =>
      call(
        "lastExchange",
        Effect.map(
          threads.getThreadRecords(ThreadId.make(threadId), ["runs", "messages"]),
          ({ runs, messages }) => {
            const reply = messages.findLast(
              (m) => m.role === "assistant" && !m.streaming && m.text.trim().length > 0,
            );
            if (!reply) return { asked: null, text: null };
            const run = runs.find((r) => r.id === reply.runId);
            const asked = messages.find((m) => m.id === run?.userMessageId)?.text ?? null;
            return { asked, text: reply.text };
          },
        ),
      ),
    pendingQuestions: (threadId) =>
      call(
        "pendingQuestions",
        Effect.map(
          threads.getThreadRecords(ThreadId.make(threadId), ["runtimeRequests", "turnItems"], {
            turnItemTypes: ["user_input_request"],
          }),
          ({ runtimeRequests, turnItems }) => {
            const pending = new Set(
              runtimeRequests
                .filter((r) => r.kind === "user_input" && r.status === "pending")
                .map((r) => r.id),
            );
            return turnItems.flatMap((item) =>
              item.type === "user_input_request" && pending.has(item.requestId)
                ? [{ requestId: item.requestId, questions: item.questions }]
                : [],
            );
          },
        ),
      ),
    respondToApproval: (threadId, requestId, decision) =>
      call(
        "respondToApproval",
        Effect.gen(function* () {
          yield* threads.dispatch({
            type: "runtime-request.respond",
            commandId: yield* newId,
            threadId: ThreadId.make(threadId),
            requestId: RuntimeRequestId.make(requestId),
            decision,
          });
        }),
      ),
    launch: (projectId, text, runtimeMode) =>
      call(
        "launch",
        Effect.gen(function* () {
          const id = ProjectId.make(projectId);
          const project = Option.getOrUndefined(yield* projects.getById(id));
          const defaults = resolveProjectSettings(
            yield* settings.getSettings,
            id,
            project,
          ).settings;
          if (!defaults.defaultModelSelection)
            return yield* new VoiceT3Refused({ message: "这个项目没有默认模型" });
          const commandId = yield* newId;
          const result = yield* ThreadMessageIntake.launchThread({
            commandId,
            threadId: ThreadId.make(commandId),
            projectId: id,
            title: [...text.split("\n")[0]!].slice(0, 40).join(""),
            generateTitle: true,
            modelSelection: defaults.defaultModelSelection,
            runtimeMode,
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: { messageId: MessageId.make(commandId), text, attachments: [] },
            createdBy: "user",
            creationSource: "server",
          });
          return { threadId: result.projection.thread.id };
        }),
      ),
  };
  return t3;
});
