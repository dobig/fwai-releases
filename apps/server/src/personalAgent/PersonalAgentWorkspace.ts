import { PersonalAgentError, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { AGENT_INSTRUCTIONS, AGENT_MEMORY } from "./personalAgentPolicy.ts";
import { PersonalAgentWorkspace } from "./PersonalAgentService.ts";

/** The agent's own project: a managed folder holding its instructions and memory. */
export const layer = Layer.effect(
  PersonalAgentWorkspace,
  Effect.gen(function* () {
    const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return PersonalAgentWorkspace.of({
      createProject: Effect.gen(function* () {
        const created = yield* folders.createNamedProject({ name: "Personal agent" });
        yield* fileSystem.writeFileString(
          path.join(created.workspaceRoot, "AGENTS.md"),
          AGENT_INSTRUCTIONS,
        );
        yield* fileSystem.writeFileString(
          path.join(created.workspaceRoot, "MEMORY.md"),
          AGENT_MEMORY,
        );
        return { projectId: created.projectId, directory: created.workspaceRoot };
      }).pipe(
        Effect.mapError(
          () =>
            new PersonalAgentError({
              reason: "failed",
              detail: "Could not create the agent's project.",
            }),
        ),
        Effect.withSpan("PersonalAgentWorkspace.createProject"),
      ),
      projectExists: Effect.fn("PersonalAgentWorkspace.projectExists")((projectId) =>
        projects.get(ProjectId.make(projectId)).pipe(
          Effect.map(Option.isSome),
          Effect.orElseSucceed(() => false),
        ),
      ),
    });
  }),
);
