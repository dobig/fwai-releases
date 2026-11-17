import {
  activeThreadShares,
  EnvironmentAuthorizationError,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  type AuthAccountPrincipal,
  type AuthEnvironmentScope,
  type OrchestrationV2ShellStreamItem,
  type ProjectId,
  type ProviderRequestKind,
  type RuntimeMode,
  type RuntimeRequestId,
  type RunId,
  type ThreadId,
  type ThreadShare,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { narrowerRuntimeMode } from "../orchestration-v2/RuntimePolicy.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

/**
 * Per-thread access for sessions of accounts other than the owner (#20). The owner's own sessions
 * (local, paired, or the linked fwai account) carry no `shareIds` and keep full access; a
 * collaborator session reaches only threads whose active shares name its account, one of its
 * projects or its organization. The relay pre-checks; this environment decides.
 */
export type ThreadAccess = "owner" | "collaborator" | "viewer";

export const COLLABORATOR_SCOPES: ReadonlyArray<AuthEnvironmentScope> = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
];

/** Everything else (terminal, files, git, settings, projects, providers) is the owner's. */
const COLLABORATOR_RPC_METHODS: ReadonlySet<string> = new Set<string>([
  ORCHESTRATION_V2_WS_METHODS.subscribeShell,
  ORCHESTRATION_V2_WS_METHODS.subscribeThread,
  ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
  ORCHESTRATION_V2_WS_METHODS.getTurnItem,
  ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
  ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
  ORCHESTRATION_V2_WS_METHODS.searchThread,
  ORCHESTRATION_V2_WS_METHODS.searchThreadStream,
  ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
  ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.subscribeServerLifecycle,
  WS_METHODS.serverProbe,
  WS_METHODS.serverGetConfig,
  WS_METHODS.attachmentsCreateUploadUrl,
  WS_METHODS.assetsPersistChatAttachments,
  WS_METHODS.assetsCreateUrl,
]);

/** Calls that name no thread: connection health, config, and uploading an attachment to send. */
const UNTHREADED_COLLABORATOR_METHODS: ReadonlySet<string> = new Set<string>([
  ORCHESTRATION_V2_WS_METHODS.subscribeShell,
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.subscribeServerLifecycle,
  WS_METHODS.serverProbe,
  WS_METHODS.serverGetConfig,
  WS_METHODS.attachmentsCreateUploadUrl,
]);

/** Commands a collaborator may send for a run only when it started that run. */
const OWN_RUN_COMMANDS: ReadonlySet<string> = new Set([
  "run.interrupt",
  "subagent.stop",
  "queued-run.cancel",
  "queued-run.edit",
  "queued-run.start",
  "prepared-run.retry",
  "queued-message.promote-to-steer",
]);

export const isCollaboratorPrincipal = (
  principal: AuthAccountPrincipal | undefined,
): principal is AuthAccountPrincipal & { readonly shareIds: ReadonlyArray<string> } =>
  principal?.shareIds !== undefined;

function shareMatchesPrincipal(share: ThreadShare, principal: AuthAccountPrincipal) {
  switch (share.target.kind) {
    case "account":
      return share.target.id === principal.accountId;
    case "project":
      return principal.organization?.projectIds.includes(share.target.id) ?? false;
    case "organization":
      return principal.organization?.id === share.target.id;
    case "link":
      return false;
  }
}

const matchingShares = (
  principal: AuthAccountPrincipal,
  shares: ReadonlyArray<ThreadShare> | undefined,
) => activeThreadShares(shares).filter((share) => shareMatchesPrincipal(share, principal));

export function threadAccessFor(
  principal: AuthAccountPrincipal | undefined,
  thread: {
    readonly shares?: ReadonlyArray<ThreadShare> | undefined;
    readonly deletedAt?: unknown;
  },
): ThreadAccess | null {
  if (!isCollaboratorPrincipal(principal)) return "owner";
  if (thread.deletedAt != null) return null;
  const shares = matchingShares(principal, thread.shares);
  if (shares.length === 0) return null;
  return shares.some((share) => share.role === "collaborator") ? "collaborator" : "viewer";
}

/**
 * Whether a run a collaborator starts must ask the owner before commands and file changes. The
 * share granting the most wins: one collaborator share without approval is enough to skip it.
 */
export function collaboratorRunNeedsApproval(
  principal: AuthAccountPrincipal,
  shares: ReadonlyArray<ThreadShare> | undefined,
): boolean {
  const collaborating = matchingShares(principal, shares).filter(
    (share) => share.role === "collaborator",
  );
  return collaborating.length > 0 && collaborating.every((share) => share.requireApproval);
}

const APPROVAL_REQUEST_KINDS: ReadonlySet<string> = new Set<ProviderRequestKind>([
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
]);

/**
 * Questions are the collaborator's to answer. Approvals are the owner's while the collaborator's
 * share asks for them, else theirs too; anything else (auth, tool calls) stays the owner's.
 */
function collaboratorMayAnswer(
  principal: AuthAccountPrincipal,
  shares: ReadonlyArray<ThreadShare> | undefined,
  kind: string,
): boolean {
  if (kind === "user_input") return true;
  return APPROVAL_REQUEST_KINDS.has(kind) && !collaboratorRunNeedsApproval(principal, shares);
}

export class ThreadAccessPolicy extends Context.Service<
  ThreadAccessPolicy,
  {
    /** The session's access to a thread; null when it has none or the thread is gone. */
    readonly access: (
      principal: AuthAccountPrincipal | undefined,
      threadId: ThreadId,
    ) => Effect.Effect<ThreadAccess | null>;
    /** Refuses a collaborator's RPC call unless it stays inside a thread shared with them. */
    readonly authorizeCall: (
      principal: AuthAccountPrincipal | undefined,
      method: string,
      payload: unknown,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    /** The mode a collaborator's run on this thread may not exceed, if their shares ask for one. */
    readonly runCeiling: (
      principal: AuthAccountPrincipal | undefined,
      threadId: ThreadId,
    ) => Effect.Effect<RuntimeMode | null>;
    /** The shell stream as a collaborator may see it: only their threads and those projects. */
    readonly filterShell: <E, R>(
      principal: AuthAccountPrincipal,
      stream: Stream.Stream<OrchestrationV2ShellStreamItem, E, R>,
    ) => Stream.Stream<OrchestrationV2ShellStreamItem, E, R>;
  }
>()("t3/threadShare/ThreadAccessPolicy") {}

const decodeSharedThread = (payloadJson: string) => {
  try {
    const value = JSON.parse(payloadJson) as {
      readonly shares?: ReadonlyArray<ThreadShare>;
      readonly deletedAt?: unknown;
    };
    return { shares: value.shares, deletedAt: value.deletedAt };
  } catch {
    return null;
  }
};

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const sql = yield* SqlClient.SqlClient;

  // Projects of every thread shared with this principal, read from the shares themselves so the
  // answer does not depend on which threads the stream has delivered yet.
  const accessibleProjectIds = (principal: AuthAccountPrincipal) =>
    sql<{ readonly project_id: string; readonly payload_json: string }>`
      SELECT project_id, payload_json FROM orchestration_v2_projection_threads
      WHERE json_array_length(payload_json, '$.shares') > 0
    `.pipe(
      Effect.map((rows) => {
        const ids = new Set<string>();
        for (const row of rows) {
          const thread = decodeSharedThread(row.payload_json);
          if (thread !== null && threadAccessFor(principal, thread) !== null)
            ids.add(row.project_id);
        }
        return ids;
      }),
      Effect.orElseSucceed(() => new Set<string>()),
    );

  const sharesOf = (threadId: ThreadId) =>
    projections.getThreadRecords(threadId, []).pipe(
      Effect.map(({ thread }) => thread),
      Effect.orElseSucceed(() => null),
    );

  const access: ThreadAccessPolicy["Service"]["access"] = (principal, threadId) =>
    isCollaboratorPrincipal(principal)
      ? Effect.map(sharesOf(threadId), (thread) =>
          thread === null ? null : threadAccessFor(principal, thread),
        )
      : Effect.succeed("owner");

  // A run belongs to whoever wrote the message that started it.
  const runsStartedBy = Effect.fn("ThreadAccessPolicy.runsStartedBy")(
    function* (principal: AuthAccountPrincipal, threadId: ThreadId, runIds: ReadonlyArray<RunId>) {
      const { runs } = yield* projections.getThreadRecords(threadId, ["runs"], { runIds });
      const wanted = new Set<string>(runIds);
      const matched = runs.filter((run) => wanted.has(run.id));
      if (matched.length !== wanted.size) return false;
      const { messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
        messageIds: matched.map((run) => run.userMessageId),
      });
      return matched.every(
        (run) =>
          messages.find((message) => message.id === run.userMessageId)?.authorAccountId ===
          principal.accountId,
      );
    },
    Effect.orElseSucceed(() => false),
  );

  // Shared sessions never hold the owner's scopes, so name the one an owner session carries.
  const denied = (message: string) =>
    Effect.fail(
      new EnvironmentAuthorizationError({ message, requiredScope: AuthOrchestrationOperateScope }),
    );

  const authorizeCall: ThreadAccessPolicy["Service"]["authorizeCall"] = Effect.fn(
    "ThreadAccessPolicy.authorizeCall",
  )(function* (principal, method, payload) {
    if (!isCollaboratorPrincipal(principal)) return;
    if (!COLLABORATOR_RPC_METHODS.has(method)) {
      return yield* denied("Only the owner can do this on a shared environment.");
    }
    const fields = (typeof payload === "object" && payload !== null ? payload : {}) as {
      readonly threadId?: unknown;
      readonly type?: unknown;
      readonly requestId?: unknown;
      readonly runId?: unknown;
      readonly queuedRunId?: unknown;
      readonly targetRunId?: unknown;
      readonly holdQueue?: unknown;
      readonly runtimeMode?: unknown;
      readonly resource?: { readonly _tag?: unknown; readonly threadId?: unknown };
    };
    if (UNTHREADED_COLLABORATOR_METHODS.has(method)) return;
    if (method === WS_METHODS.assetsCreateUrl) {
      // Attachment ids are unguessable; everything else reads the owner's files.
      if (fields.resource?._tag === "attachment") return;
      if (fields.resource?._tag !== "tool-output-image") {
        return yield* denied("Only the owner can do this on a shared environment.");
      }
    }
    const threadIdField =
      method === WS_METHODS.assetsCreateUrl ? fields.resource?.threadId : fields.threadId;
    if (typeof threadIdField !== "string") {
      return yield* denied("This thread is not shared with you.");
    }
    const threadId = threadIdField as ThreadId;
    const thread = yield* sharesOf(threadId);
    const threadAccess = thread === null ? null : threadAccessFor(principal, thread);
    if (threadAccess === null) return yield* denied("This thread is not shared with you.");
    if (
      method !== ORCHESTRATION_V2_WS_METHODS.dispatchCommand &&
      method !== WS_METHODS.assetsPersistChatAttachments
    ) {
      return;
    }
    if (threadAccess !== "collaborator") {
      return yield* denied("You can only read this shared thread.");
    }
    if (method === WS_METHODS.assetsPersistChatAttachments) return;
    switch (fields.type) {
      case "message.dispatch":
      case "thread.interaction-mode.set":
        return;
      case "thread.runtime-mode.set": {
        // The owner's later runs use the thread's mode too, so a collaborator who must ask the
        // owner may only tighten it.
        const ceiling = collaboratorRunNeedsApproval(principal, thread?.shares)
          ? ("approval-required" as const)
          : undefined;
        const mode = fields.runtimeMode as RuntimeMode;
        if (narrowerRuntimeMode(mode, ceiling) === mode) return;
        return yield* denied("Only the owner can loosen this thread's approvals.");
      }
    }
    if (typeof fields.type === "string" && OWN_RUN_COMMANDS.has(fields.type)) {
      const runIds = [fields.runId, fields.queuedRunId, fields.targetRunId].filter(
        (id): id is RunId => typeof id === "string",
      );
      if (
        runIds.length > 0 &&
        fields.holdQueue !== true &&
        (yield* runsStartedBy(principal, threadId, runIds))
      ) {
        return;
      }
      return yield* denied("You can only manage your own messages in this shared thread.");
    }
    if (fields.type === "runtime-request.respond" || fields.type === "thread.user-input.dismiss") {
      const request =
        typeof fields.requestId === "string"
          ? yield* projections
              .getRuntimeRequest(threadId, fields.requestId as RuntimeRequestId)
              .pipe(Effect.orElseSucceed(() => undefined))
          : undefined;
      if (request !== undefined && collaboratorMayAnswer(principal, thread?.shares, request.kind)) {
        return;
      }
      return yield* denied("Only the owner can answer this request.");
    }
    return yield* denied("You can only send messages in this shared thread.");
  });

  const filterShell: ThreadAccessPolicy["Service"]["filterShell"] = (principal, stream) => {
    // Threads and projects this subscriber has been sent, so losing access sends a removal and a
    // thread is never sent before its project.
    const sentThreads = new Map<string, string>();
    const sentProjects = new Set<string>();
    const redactProject = <P extends { readonly scripts: ReadonlyArray<unknown> }>(project: P) => ({
      ...project,
      scripts: [],
    });
    const visible = (threadId: ThreadId) =>
      Effect.map(
        sharesOf(threadId),
        (thread) => thread !== null && threadAccessFor(principal, thread) !== null,
      );
    const projectItem = (projectId: ProjectId, sequence: number) =>
      projects.getShell(projectId).pipe(
        Effect.map(
          Option.match({
            onNone: () => [] as ReadonlyArray<OrchestrationV2ShellStreamItem>,
            onSome: (project) => {
              sentProjects.add(project.id);
              return [
                { kind: "project.updated" as const, sequence, project: redactProject(project) },
              ];
            },
          }),
        ),
        Effect.orElseSucceed(() => []),
      );
    return stream.pipe(
      Stream.mapEffect((item) =>
        Effect.gen(function* () {
          switch (item.kind) {
            case "synchronized":
              return [item];
            case "snapshot": {
              // A resume or enrichment snapshot carries projects only; it replaces nothing.
              const replaces =
                item.snapshot.threads.length > 0 ||
                item.resolvedRepositoryIdentityRoots === undefined;
              if (replaces) {
                sentThreads.clear();
                sentProjects.clear();
              }
              const threads = [];
              for (const thread of item.snapshot.threads) {
                if (yield* visible(thread.id)) {
                  threads.push(thread);
                  sentThreads.set(thread.id, thread.projectId);
                }
              }
              const allowed = yield* accessibleProjectIds(principal);
              for (const projectId of sentThreads.values()) allowed.add(projectId);
              const projectsInSnapshot = item.snapshot.projects
                .filter((project) => allowed.has(project.id))
                .map(redactProject);
              for (const project of projectsInSnapshot) sentProjects.add(project.id);
              const { olderSettled: _olderSettled, ...snapshot } = item.snapshot;
              return [
                {
                  ...item,
                  snapshot: {
                    ...snapshot,
                    threads,
                    archivedThreads: [],
                    projects: projectsInSnapshot,
                  },
                },
              ];
            }
            case "project.updated":
              return sentProjects.has(item.project.id) ||
                (yield* accessibleProjectIds(principal)).has(item.project.id)
                ? (sentProjects.add(item.project.id),
                  [{ ...item, project: redactProject(item.project) }])
                : [];
            case "project.removed":
              return sentProjects.delete(item.projectId) ? [item] : [];
            case "thread.updated": {
              if (item.location === "active" && (yield* visible(item.thread.id))) {
                const before = sentProjects.has(item.thread.projectId)
                  ? []
                  : yield* projectItem(item.thread.projectId, item.sequence);
                sentThreads.set(item.thread.id, item.thread.projectId);
                return [...before, { ...item, location: "active" as const }];
              }
              if (!sentThreads.delete(item.thread.id)) return [];
              return [
                {
                  kind: "thread.removed" as const,
                  sequence: item.sequence,
                  location: "active" as const,
                  threadId: item.thread.id,
                },
              ];
            }
            case "thread.removed":
              if (!sentThreads.delete(item.threadId)) return [];
              return [{ ...item, location: "active" as const }];
          }
        }),
      ),
      Stream.flatMap((items: ReadonlyArray<OrchestrationV2ShellStreamItem>) =>
        Stream.fromIterable(items),
      ),
    );
  };

  const runCeiling: ThreadAccessPolicy["Service"]["runCeiling"] = (principal, threadId) =>
    isCollaboratorPrincipal(principal)
      ? Effect.map(sharesOf(threadId), (thread) =>
          thread !== null && collaboratorRunNeedsApproval(principal, thread.shares)
            ? ("approval-required" as const)
            : null,
        )
      : Effect.succeed(null);

  return ThreadAccessPolicy.of({ access, authorizeCall, runCeiling, filterShell });
});

export const layer = Layer.effect(ThreadAccessPolicy, make);
