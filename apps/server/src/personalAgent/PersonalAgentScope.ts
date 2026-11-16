import {
  PERSONAL_AGENT_PROJECT_CAPABILITIES,
  personalAgentGrant,
  type AgentNeed,
  type PersonalAgentPermissions,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  AGENT_THREAD_PREFIX,
  isAgentOwnThreadId,
  WORK_THREAD_PREFIX,
  type PermissionView,
} from "./personalAgentPolicy.ts";

/** Recent threads per project shown to the agent; enough to pick a target, cheap in tokens. */
const RECENT_THREADS_PER_PROJECT = 10;

export interface ScopedThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
}

/**
 * The owner's grants (#45) resolved against this environment: what a request's approved needs
 * let its thread read, what the prompt lists, and which project a thread belongs to. The
 * agent's own threads are never targets.
 */
export class PersonalAgentScope extends Context.Service<
  PersonalAgentScope,
  {
    /** Folders a request's thread may read: approved project folders and the extra folders. */
    readonly readableRoots: (
      permissions: PersonalAgentPermissions,
      approved: ReadonlyArray<AgentNeed>,
    ) => Effect.Effect<ReadonlyArray<string>>;
    readonly view: (permissions: PersonalAgentPermissions) => Effect.Effect<PermissionView>;
    readonly projectOfThread: (threadId: string) => Effect.Effect<string | null>;
    readonly listThreads: (
      projectIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<ScopedThread>>;
  }
>()("t3/personalAgent/PersonalAgentScope") {}

export const layer = Layer.effect(
  PersonalAgentScope,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const liveProjects = projects.list().pipe(Effect.orElseSucceed(() => []));

    const threadsOf = (projectIds: ReadonlyArray<string>, limit: number) =>
      projectIds.length === 0
        ? Effect.succeed([])
        : sql<{ readonly thread_id: string; readonly project_id: string; readonly title: string }>`
            SELECT thread_id, project_id, title FROM orchestration_v2_projection_threads
            WHERE project_id IN ${sql.in(projectIds)} AND archived_at IS NULL
              AND deleted_at IS NULL
              AND (thread_id NOT LIKE ${`${AGENT_THREAD_PREFIX}%`}
                OR thread_id LIKE ${`${WORK_THREAD_PREFIX}%`})
            ORDER BY updated_at DESC LIMIT ${limit}
          `.pipe(
            Effect.map((rows) =>
              rows.map((row) => ({
                id: row.thread_id,
                projectId: row.project_id,
                title: row.title,
              })),
            ),
            Effect.orElseSucceed((): ReadonlyArray<ScopedThread> => []),
          );

    const readableRoots = Effect.fn("PersonalAgentScope.readableRoots")(function* (
      permissions: PersonalAgentPermissions,
      approved: ReadonlyArray<AgentNeed>,
    ) {
      const folderIds = new Set(
        approved.flatMap((need) => (need.kind === "read_folder" ? [need.projectId] : [])),
      );
      const readable = (yield* liveProjects).filter((project) => folderIds.has(project.projectId));
      const ids = readable.map((project) => project.projectId);
      const worktrees =
        ids.length === 0
          ? []
          : yield* sql<{ readonly path: string | null }>`
              SELECT DISTINCT json_extract(payload_json, '$.worktreePath') AS path
              FROM orchestration_v2_projection_threads
              WHERE project_id IN ${sql.in(ids)} AND deleted_at IS NULL
            `.pipe(Effect.orElseSucceed(() => []));
      return [
        ...readable.map((project) => project.workspaceRoot),
        ...worktrees.flatMap((row) => (row.path === null ? [] : [row.path])),
        ...permissions.extraReadPaths,
      ];
    });

    const view = Effect.fn("PersonalAgentScope.view")(function* (
      permissions: PersonalAgentPermissions,
    ) {
      const rows = [];
      for (const project of yield* liveProjects) {
        const grants = {
          readFolder: personalAgentGrant(permissions, project.projectId, "readFolder"),
          readThreads: personalAgentGrant(permissions, project.projectId, "readThreads"),
          send: personalAgentGrant(permissions, project.projectId, "send"),
          start: personalAgentGrant(permissions, project.projectId, "start"),
        };
        if (PERSONAL_AGENT_PROJECT_CAPABILITIES.every((key) => grants[key] === "deny")) continue;
        rows.push({
          id: project.projectId,
          title: project.title,
          grants,
          threads:
            grants.send === "deny"
              ? []
              : yield* threadsOf([project.projectId], RECENT_THREADS_PER_PROJECT),
        });
      }
      return {
        projects: rows,
        extraReadPaths: permissions.extraReadPaths,
        reply: permissions.reply,
        share: permissions.share,
      } satisfies PermissionView;
    });

    const projectOfThread = Effect.fn("PersonalAgentScope.projectOfThread")(function* (
      threadId: string,
    ) {
      if (isAgentOwnThreadId(threadId)) return null;
      const rows = yield* sql<{ readonly project_id: string }>`
        SELECT project_id FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId} AND archived_at IS NULL AND deleted_at IS NULL
      `.pipe(Effect.orElseSucceed(() => []));
      return rows[0]?.project_id ?? null;
    });

    const listThreads = Effect.fn("PersonalAgentScope.listThreads")(function* (
      projectIds: ReadonlyArray<string>,
    ) {
      return yield* threadsOf(projectIds, 100);
    });

    return PersonalAgentScope.of({ readableRoots, view, projectOfThread, listThreads });
  }),
);

/** For tests: grants resolved against a fixed set of projects and threads. */
export const layerTest = (fixture: {
  readonly projects: ReadonlyArray<{ id: string; title: string; root: string }>;
  readonly threads: ReadonlyArray<ScopedThread>;
}) =>
  Layer.succeed(
    PersonalAgentScope,
    PersonalAgentScope.of({
      readableRoots: Effect.fn("PersonalAgentScope.test.readableRoots")(
        function* (permissions, approved) {
          const ids = new Set<string>(
            approved.flatMap((need) => (need.kind === "read_folder" ? [need.projectId] : [])),
          );
          return yield* Effect.succeed([
            ...fixture.projects.filter((project) => ids.has(project.id)).map((p) => p.root),
            ...permissions.extraReadPaths,
          ]);
        },
      ),
      view: Effect.fn("PersonalAgentScope.test.view")(function* (permissions) {
        return yield* Effect.succeed({
          projects: fixture.projects.map((project) => ({
            id: project.id,
            title: project.title,
            grants: {
              readFolder: personalAgentGrant(permissions, project.id, "readFolder"),
              readThreads: personalAgentGrant(permissions, project.id, "readThreads"),
              send: personalAgentGrant(permissions, project.id, "send"),
              start: personalAgentGrant(permissions, project.id, "start"),
            },
            threads: fixture.threads.filter((thread) => thread.projectId === project.id),
          })),
          extraReadPaths: permissions.extraReadPaths,
          reply: permissions.reply,
          share: permissions.share,
        });
      }),
      projectOfThread: Effect.fn("PersonalAgentScope.test.projectOfThread")(function* (threadId) {
        return yield* Effect.succeed(
          fixture.threads.find((thread) => thread.id === threadId)?.projectId ?? null,
        );
      }),
      listThreads: Effect.fn("PersonalAgentScope.test.listThreads")(function* (projectIds) {
        return yield* Effect.succeed(
          fixture.threads.filter((thread) => projectIds.some((id) => id === thread.projectId)),
        );
      }),
    }),
  );
