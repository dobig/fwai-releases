import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scope from "./PersonalAgentScope.ts";

const testLayer = Scope.layer.pipe(
  Layer.provideMerge(ProjectStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect("treats threads the agent started for a request as the owner's threads", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const createdAt = "2026-11-12T00:00:00.000Z";
    for (const threadId of [
      "personal-agent-6f1c",
      "personal-agent-req-areq_1",
      "personal-agent-work-areq_1",
      "ordinary",
    ]) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json
        ) VALUES (
          ${threadId}, 'project-1', ${threadId}, 'claudeAgent', 'approval-required', 'default',
          ${createdAt}, ${createdAt}, '{}'
        )
      `;
    }
    const scope = yield* Scope.PersonalAgentScope;

    expect((yield* scope.listThreads(["project-1"])).map((thread) => thread.id).sort()).toEqual([
      "ordinary",
      "personal-agent-work-areq_1",
    ]);
    expect(yield* scope.projectOfThread("personal-agent-work-areq_1")).toBe("project-1");
    expect(yield* scope.projectOfThread("personal-agent-6f1c")).toBeNull();
    expect(yield* scope.projectOfThread("personal-agent-req-areq_1")).toBeNull();
  }).pipe(Effect.provide(testLayer)),
);
