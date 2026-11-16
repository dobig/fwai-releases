import {
  AgentNeed,
  EMPTY_PERSONAL_AGENT_PERMISSIONS,
  type PersonalAgentProjectOverrides,
  PersonalAgentAskOrigin,
  PersonalAgentPermissions,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** This environment's agent: its thread and folder, and what the owner granted it (#22). */
export const PersonalAgentConfig = Schema.Struct({
  /** The relay last said this environment is the account's agent environment. */
  enabled: Schema.Boolean,
  threadId: Schema.NullOr(ThreadId),
  projectId: Schema.NullOr(ProjectId),
  /** The agent's folder: its instructions and memory, and the cwd of every triage. */
  directory: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  permissions: PersonalAgentPermissions,
  /** The owner's own instructions; absent in configs saved before they existed. */
  instructions: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Access the owner approved for each colleague request's thread (#45); the newest few. */
  requestScopes: Schema.Array(
    Schema.Struct({ requestId: Schema.String, needs: Schema.Array(AgentNeed) }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Requests this environment sent, with where a reply may open a thread; the newest few. */
  askOrigins: Schema.Array(
    Schema.Struct({ requestId: Schema.String, origin: PersonalAgentAskOrigin }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type PersonalAgentConfig = typeof PersonalAgentConfig.Type;

export const EMPTY_PERSONAL_AGENT_CONFIG: PersonalAgentConfig = {
  enabled: false,
  threadId: null,
  projectId: null,
  directory: null,
  providerInstanceId: null,
  permissions: EMPTY_PERSONAL_AGENT_PERMISSIONS,
  instructions: "",
  askOrigins: [],
  requestScopes: [],
};

export class PersonalAgentStoreError extends Schema.TaggedError<PersonalAgentStoreError>()(
  "PersonalAgentStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Personal agent store operation '${this.operation}' failed.`;
  }
}

export class PersonalAgentStore extends Context.Service<
  PersonalAgentStore,
  {
    /** Cached; the runtime policy reads it on every turn. */
    readonly get: Effect.Effect<PersonalAgentConfig>;
    readonly update: (
      change: (config: PersonalAgentConfig) => PersonalAgentConfig,
    ) => Effect.Effect<PersonalAgentConfig, PersonalAgentStoreError>;
  }
>()("t3/personalAgent/PersonalAgentStore") {}

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(PersonalAgentConfig));
const decodeObject = Schema.decodeUnknownOption(PersonalAgentConfig);

/** Permissions as first saved: thread lists and raw paths. */
const V1Permissions = Schema.Struct({
  readPaths: Schema.Array(Schema.String),
  readProjectIds: Schema.Array(ProjectId),
  readMemory: Schema.Boolean,
  actThreadIds: Schema.Array(Schema.String),
  startThreadProjectIds: Schema.Array(ProjectId),
  shareThreads: Schema.Boolean,
});
const V2Rights = Schema.Struct({
  read: Schema.Boolean,
  send: Schema.Boolean,
  start: Schema.Boolean,
});
/** Permissions as saved with per-project ticks, before auto, ask and deny. */
const V2Permissions = Schema.Struct({
  allProjects: V2Rights,
  projects: Schema.Array(Schema.Struct({ projectId: ProjectId, rights: V2Rights })),
  extraReadPaths: Schema.Array(Schema.String),
  readMemory: Schema.Boolean,
  shareThreads: Schema.Boolean,
});
const LegacyPermissions = Schema.Union([V2Permissions, V1Permissions]);
export type LegacyPersonalAgentPermissions = typeof LegacyPermissions.Type;
const decodeLegacy = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.StructWithRest(Schema.Struct({ permissions: LegacyPermissions }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  ),
);

/**
 * Older grants keep their meaning: what was ticked stays allowed (reads automatic, actions after
 * approval, as before) and what was not becomes deny, not the new default of ask.
 */
export function migrateLegacyPermissions(
  legacy: LegacyPersonalAgentPermissions,
  projectOfThread: ReadonlyMap<string, string>,
): PersonalAgentPermissions {
  const rows = new Map<string, PersonalAgentProjectOverrides>();
  const set = (projectId: string, change: PersonalAgentProjectOverrides) =>
    rows.set(projectId, { ...rows.get(projectId), ...change });
  const fromRights = (rights: typeof V2Rights.Type) => ({
    readFolder: rights.read ? ("auto" as const) : ("deny" as const),
    readThreads: "deny" as const,
    send: rights.send ? ("ask" as const) : ("deny" as const),
    start: rights.start ? ("ask" as const) : ("deny" as const),
  });
  let allProjects = fromRights({ read: false, send: false, start: false });
  let extraReadPaths: ReadonlyArray<string>;
  if ("allProjects" in legacy) {
    allProjects = fromRights(legacy.allProjects);
    for (const entry of legacy.projects) {
      if (entry.rights.read) set(entry.projectId, { readFolder: "auto" });
      if (entry.rights.send) set(entry.projectId, { send: "ask" });
      if (entry.rights.start) set(entry.projectId, { start: "ask" });
    }
    extraReadPaths = legacy.extraReadPaths;
  } else {
    for (const projectId of legacy.readProjectIds) set(projectId, { readFolder: "auto" });
    for (const projectId of legacy.startThreadProjectIds) set(projectId, { start: "ask" });
    for (const threadId of legacy.actThreadIds) {
      const projectId = projectOfThread.get(threadId);
      if (projectId !== undefined) set(projectId, { send: "ask" });
    }
    extraReadPaths = legacy.readPaths;
  }
  return {
    ...EMPTY_PERSONAL_AGENT_PERMISSIONS,
    allProjects,
    projects: [...rows].map(([projectId, grants]) => ({
      projectId: ProjectId.make(projectId),
      grants,
    })),
    extraReadPaths: extraReadPaths.filter((path) => path.startsWith("/")),
    readMemory: legacy.readMemory,
    share: legacy.shareThreads ? "ask" : "deny",
  };
}
const encode = Schema.encodeSync(Schema.fromJsonString(PersonalAgentConfig));

export const layer = Layer.effect(
  PersonalAgentStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM personal_agent WHERE id = 1
    `.pipe(Effect.orElseSucceed(() => []));
    const payload = rows[0]?.payload_json;
    const current = payload === undefined ? Option.none() : decode(payload);
    const legacy =
      payload === undefined || Option.isSome(current) ? Option.none() : decodeLegacy(payload);
    const initial = Option.isSome(current)
      ? current.value
      : Option.isSome(legacy)
        ? yield* Effect.gen(function* () {
            const legacyPermissions = legacy.value.permissions;
            const threadIds =
              "actThreadIds" in legacyPermissions ? legacyPermissions.actThreadIds : [];
            const owners =
              threadIds.length === 0
                ? []
                : yield* sql<{ readonly thread_id: string; readonly project_id: string }>`
                    SELECT thread_id, project_id FROM orchestration_v2_projection_threads
                    WHERE thread_id IN ${sql.in(threadIds)}
                  `.pipe(Effect.orElseSucceed(() => []));
            const migrated = Option.getOrElse(
              decodeObject({
                ...legacy.value,
                permissions: migrateLegacyPermissions(
                  legacy.value.permissions,
                  new Map(owners.map((row) => [row.thread_id, row.project_id])),
                ),
              }),
              () => EMPTY_PERSONAL_AGENT_CONFIG,
            );
            yield* sql`
              UPDATE personal_agent SET payload_json = ${encode(migrated)} WHERE id = 1
            `.pipe(Effect.ignore);
            return migrated;
          })
        : EMPTY_PERSONAL_AGENT_CONFIG;
    const cache = yield* Ref.make(initial);
    const writes = yield* Semaphore.make(1);
    return PersonalAgentStore.of({
      get: Ref.get(cache),
      update: Effect.fn("PersonalAgentStore.update")(
        function* (change: (config: PersonalAgentConfig) => PersonalAgentConfig) {
          const next = change(yield* Ref.get(cache));
          yield* sql`
            INSERT INTO personal_agent (id, payload_json) VALUES (1, ${encode(next)})
            ON CONFLICT (id) DO UPDATE SET payload_json = excluded.payload_json
          `.pipe(
            Effect.mapError((cause) => new PersonalAgentStoreError({ operation: "update", cause })),
          );
          yield* Ref.set(cache, next);
          return next;
        },
        (effect) => writes.withPermits(1)(effect),
      ),
    });
  }),
);

/** For tests and layers that run without SQLite. */
export const layerMemory = (initial: PersonalAgentConfig = EMPTY_PERSONAL_AGENT_CONFIG) =>
  Layer.effect(
    PersonalAgentStore,
    Effect.gen(function* () {
      const cache = yield* Ref.make(initial);
      return PersonalAgentStore.of({
        get: Ref.get(cache),
        update: Effect.fn("PersonalAgentStore.update")((change) => Ref.updateAndGet(cache, change)),
      });
    }),
  );
