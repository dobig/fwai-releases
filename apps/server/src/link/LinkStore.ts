import {
  AuthAccountOrganization,
  type CommandId,
  EnvironmentId,
  LINK_ACTIVITY_PER_MEMBER,
  LinkActivityEntry,
  LinkChainId,
  LinkEvent,
  LinkGroup,
  LinkGroupId,
  NodeId,
  NonNegativeInt,
  ThreadId,
  type LinkThreadRef,
  type UnsequencedLinkEvent,
  LinkGroupStatus,
  LinkName,
  LinkThreadRef as LinkThreadRefSchema,
} from "@t3tools/contracts";
import { RelayLinkEnvelope, RelayLinkMemberInfo } from "@t3tools/contracts/relay";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { applyLinkEvent } from "./LinkDecider.ts";

export class LinkStoreError extends Schema.TaggedError<LinkStoreError>()("LinkStoreError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Link store operation '${this.operation}' failed.`;
  }
}

/** The cross-thread index of link tasks; their status lives on the requester's task record. */
export interface LinkTaskIndexRow {
  readonly taskId: NodeId;
  readonly linkId: LinkGroupId;
  readonly chainId: LinkChainId;
  readonly parentTaskId: NodeId | null;
  readonly hop: number;
  readonly requester: LinkThreadRef;
  readonly assignee: LinkThreadRef;
  readonly createdAtMs: number;
}

/**
 * This environment's thread in a group homed in another environment (#21 phase 2), as the home
 * last described it. The home decides membership; this copy lets the agent see its peers.
 */
export const LinkRemoteMembership = Schema.Struct({
  linkId: LinkGroupId,
  threadId: ThreadId,
  home: LinkThreadRefSchema,
  name: LinkName,
  status: LinkGroupStatus,
  members: Schema.Array(RelayLinkMemberInfo),
  /** The home owner's account and how the relay related it to this environment. */
  homeAccountId: Schema.String,
  homeOrganization: Schema.NullOr(AuthAccountOrganization),
  relation: Schema.Literals(["same_account", "shared"]),
  /** The home's version of this view; see `member-joined`. */
  version: Schema.optional(NonNegativeInt),
});
export type LinkRemoteMembership = typeof LinkRemoteMembership.Type;

/** A member's activity entry in one group (#37). */
export interface LinkActivityRow {
  readonly linkId: LinkGroupId;
  readonly member: LinkThreadRef;
  readonly entry: LinkActivityEntry;
}

export class LinkStore extends Context.Service<
  LinkStore,
  {
    readonly listGroups: Effect.Effect<ReadonlyArray<LinkGroup>, LinkStoreError>;
    /** Appends a command's events and their projection in one transaction. */
    readonly commit: (
      events: ReadonlyArray<UnsequencedLinkEvent>,
    ) => Effect.Effect<ReadonlyArray<LinkEvent>, LinkStoreError>;
    readonly hasCommand: (commandId: CommandId) => Effect.Effect<boolean, LinkStoreError>;
    readonly recordTask: (row: LinkTaskIndexRow) => Effect.Effect<void, LinkStoreError>;
    readonly getTask: (taskId: NodeId) => Effect.Effect<LinkTaskIndexRow | null, LinkStoreError>;
    readonly chainTasks: (
      chainId: LinkChainId,
    ) => Effect.Effect<ReadonlyArray<LinkTaskIndexRow>, LinkStoreError>;
    readonly tasksSince: (
      sinceMs: number,
      linkId?: LinkGroupId,
    ) => Effect.Effect<ReadonlyArray<LinkTaskIndexRow>, LinkStoreError>;
    readonly stopChain: (input: {
      readonly chainId: LinkChainId;
      readonly stoppedBy: string;
      readonly stoppedAt: string;
    }) => Effect.Effect<void, LinkStoreError>;
    readonly isChainStopped: (chainId: LinkChainId) => Effect.Effect<boolean, LinkStoreError>;
    readonly chainStoppedBy: (chainId: LinkChainId) => Effect.Effect<string | null, LinkStoreError>;
    readonly listRemoteMemberships: Effect.Effect<
      ReadonlyArray<LinkRemoteMembership>,
      LinkStoreError
    >;
    readonly putRemoteMembership: (
      membership: LinkRemoteMembership,
    ) => Effect.Effect<void, LinkStoreError>;
    readonly deleteRemoteMembership: (input: {
      readonly linkId: LinkGroupId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<void, LinkStoreError>;
    /** Replaces any envelope with the same id: the latest membership view wins. */
    readonly enqueue: (
      envelope: RelayLinkEnvelope,
      createdAtMs: number,
    ) => Effect.Effect<void, LinkStoreError>;
    readonly listOutbox: Effect.Effect<
      ReadonlyArray<{ readonly envelope: RelayLinkEnvelope; readonly createdAtMs: number }>,
      LinkStoreError
    >;
    readonly dequeue: (envelopeId: string) => Effect.Effect<void, LinkStoreError>;
    /** Keeps the member's newest entries in the group; an entry already held is left alone. */
    readonly putActivity: (row: LinkActivityRow) => Effect.Effect<boolean, LinkStoreError>;
    /** Newest first. */
    readonly listActivity: (
      linkIds: ReadonlyArray<LinkGroupId>,
    ) => Effect.Effect<ReadonlyArray<LinkActivityRow>, LinkStoreError>;
  }
>()("t3/link/LinkStore") {}

const GroupJson = Schema.fromJsonString(LinkGroup);
const decodeGroup = Schema.decodeUnknownEffect(GroupJson);
const encodeGroup = Schema.encodeEffect(GroupJson);
const PayloadJson = Schema.fromJsonString(Schema.Unknown);
const encodePayload = Schema.encodeEffect(PayloadJson);
const decodePayload = Schema.decodeUnknownEffect(PayloadJson);
const decodeEvent = Schema.decodeUnknownEffect(LinkEvent);
const MembershipJson = Schema.fromJsonString(LinkRemoteMembership);
const decodeMembership = Schema.decodeUnknownEffect(MembershipJson);
const encodeMembership = Schema.encodeEffect(MembershipJson);
const ActivityJson = Schema.fromJsonString(LinkActivityEntry);
const decodeActivity = Schema.decodeUnknownEffect(ActivityJson);
const encodeActivity = Schema.encodeEffect(ActivityJson);
const EnvelopeJson = Schema.fromJsonString(RelayLinkEnvelope);
const decodeEnvelope = Schema.decodeUnknownEffect(EnvelopeJson);
const encodeEnvelope = Schema.encodeEffect(EnvelopeJson);

interface TaskDbRow {
  readonly task_id: string;
  readonly link_id: string;
  readonly chain_id: string;
  readonly parent_task_id: string | null;
  readonly hop: number;
  readonly requester_environment_id: string;
  readonly requester_thread_id: string;
  readonly assignee_environment_id: string;
  readonly assignee_thread_id: string;
  readonly created_at: number;
}

const toTask = (row: TaskDbRow): LinkTaskIndexRow => ({
  taskId: NodeId.make(row.task_id),
  linkId: LinkGroupId.make(row.link_id),
  chainId: LinkChainId.make(row.chain_id),
  parentTaskId: row.parent_task_id === null ? null : NodeId.make(row.parent_task_id),
  hop: row.hop,
  requester: {
    environmentId: EnvironmentId.make(row.requester_environment_id),
    threadId: ThreadId.make(row.requester_thread_id),
  },
  assignee: {
    environmentId: EnvironmentId.make(row.assignee_environment_id),
    threadId: ThreadId.make(row.assignee_thread_id),
  },
  createdAtMs: row.created_at,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mapError =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new LinkStoreError({ operation, cause })));

  const readGroup = (linkId: LinkGroupId) =>
    sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM projection_link_groups WHERE link_id = ${linkId}
    `.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows.slice(0, 1), (row) => decodeGroup(row.payload_json)),
      ),
      Effect.map((groups) => groups[0]),
    );

  const listGroups = sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM projection_link_groups ORDER BY link_id
  `.pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeGroup(row.payload_json))),
    NodeSqliteClient.readOnly,
    mapError("listGroups"),
  );

  const commit = (events: ReadonlyArray<UnsequencedLinkEvent>) =>
    sql
      .withTransaction(
        Effect.forEach(events, (event) =>
          Effect.gen(function* () {
            const payloadJson = yield* encodePayload(event.payload);
            const inserted = yield* sql<{ readonly sequence: number }>`
              INSERT INTO link_events (
                event_id, link_id, command_id, event_type, occurred_at, payload_json
              )
              VALUES (
                ${event.eventId}, ${event.linkId}, ${event.commandId}, ${event.type},
                ${event.occurredAt}, ${payloadJson}
              )
              RETURNING sequence
            `;
            const next = applyLinkEvent(yield* readGroup(event.linkId), event);
            if (next === null) {
              yield* sql`DELETE FROM projection_link_groups WHERE link_id = ${event.linkId}`;
            } else {
              const groupJson = yield* encodeGroup(next);
              yield* sql`
                INSERT INTO projection_link_groups (link_id, payload_json)
                VALUES (${event.linkId}, ${groupJson})
                ON CONFLICT (link_id) DO UPDATE SET payload_json = excluded.payload_json
              `;
            }
            return yield* decodeEvent({
              ...event,
              sequence: inserted[0]!.sequence,
              payload: yield* decodePayload(payloadJson),
            });
          }),
        ),
      )
      .pipe(mapError("commit"));

  const hasCommand = (commandId: CommandId) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found FROM link_events WHERE command_id = ${commandId} LIMIT 1
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      NodeSqliteClient.readOnly,
      mapError("hasCommand"),
    );

  const recordTask = (row: LinkTaskIndexRow) =>
    sql`
      INSERT INTO link_tasks (
        task_id, link_id, chain_id, parent_task_id, hop,
        requester_environment_id, requester_thread_id,
        assignee_environment_id, assignee_thread_id, created_at
      )
      VALUES (
        ${row.taskId}, ${row.linkId}, ${row.chainId}, ${row.parentTaskId}, ${row.hop},
        ${row.requester.environmentId}, ${row.requester.threadId},
        ${row.assignee.environmentId}, ${row.assignee.threadId}, ${row.createdAtMs}
      )
      ON CONFLICT (task_id) DO NOTHING
    `.pipe(Effect.asVoid, mapError("recordTask"));

  const getTask = (taskId: NodeId) =>
    sql<TaskDbRow>`SELECT * FROM link_tasks WHERE task_id = ${taskId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toTask(rows[0]))),
      NodeSqliteClient.readOnly,
      mapError("getTask"),
    );

  const chainTasks = (chainId: LinkChainId) =>
    sql<TaskDbRow>`
      SELECT * FROM link_tasks WHERE chain_id = ${chainId} ORDER BY created_at, task_id
    `.pipe(
      Effect.map((rows) => rows.map(toTask)),
      NodeSqliteClient.readOnly,
      mapError("chainTasks"),
    );

  const tasksSince = (sinceMs: number, linkId?: LinkGroupId) =>
    sql<TaskDbRow>`
      SELECT * FROM link_tasks
      WHERE ${sql.and([
        sql`created_at >= ${sinceMs}`,
        ...(linkId === undefined ? [] : [sql`link_id = ${linkId}`]),
      ])}
      ORDER BY created_at, task_id
    `.pipe(
      Effect.map((rows) => rows.map(toTask)),
      NodeSqliteClient.readOnly,
      mapError("tasksSince"),
    );

  const stopChain = (input: {
    readonly chainId: LinkChainId;
    readonly stoppedBy: string;
    readonly stoppedAt: string;
  }) =>
    sql`
      INSERT INTO link_stopped_chains (chain_id, stopped_by, stopped_at)
      VALUES (${input.chainId}, ${input.stoppedBy}, ${input.stoppedAt})
      ON CONFLICT (chain_id) DO NOTHING
    `.pipe(Effect.asVoid, mapError("stopChain"));

  const isChainStopped = (chainId: LinkChainId) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found FROM link_stopped_chains WHERE chain_id = ${chainId}
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      NodeSqliteClient.readOnly,
      mapError("isChainStopped"),
    );

  const chainStoppedBy = (chainId: LinkChainId) =>
    sql<{ readonly stopped_by: string }>`
      SELECT stopped_by FROM link_stopped_chains WHERE chain_id = ${chainId}
    `.pipe(
      Effect.map((rows) => rows[0]?.stopped_by ?? null),
      NodeSqliteClient.readOnly,
      mapError("chainStoppedBy"),
    );

  const listRemoteMemberships = sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM link_remote_memberships ORDER BY link_id, thread_id
  `.pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeMembership(row.payload_json))),
    NodeSqliteClient.readOnly,
    mapError("listRemoteMemberships"),
  );

  const putRemoteMembership = (membership: LinkRemoteMembership) =>
    encodeMembership(membership).pipe(
      Effect.flatMap(
        (payloadJson) => sql`
          INSERT INTO link_remote_memberships (link_id, thread_id, home_environment_id, payload_json)
          VALUES (
            ${membership.linkId}, ${membership.threadId}, ${membership.home.environmentId},
            ${payloadJson}
          )
          ON CONFLICT (link_id, thread_id) DO UPDATE SET
            home_environment_id = excluded.home_environment_id,
            payload_json = excluded.payload_json
        `,
      ),
      Effect.asVoid,
      mapError("putRemoteMembership"),
    );

  const deleteRemoteMembership = (input: {
    readonly linkId: LinkGroupId;
    readonly threadId: ThreadId;
  }) =>
    sql`
      DELETE FROM link_remote_memberships
      WHERE link_id = ${input.linkId} AND thread_id = ${input.threadId}
    `.pipe(Effect.asVoid, mapError("deleteRemoteMembership"));

  const enqueue = (envelope: RelayLinkEnvelope, createdAtMs: number) =>
    encodeEnvelope(envelope).pipe(
      Effect.flatMap(
        (envelopeJson) => sql`
          INSERT INTO link_outbox (envelope_id, envelope_json, created_at)
          VALUES (${envelope.id}, ${envelopeJson}, ${createdAtMs})
          ON CONFLICT (envelope_id) DO UPDATE SET envelope_json = excluded.envelope_json
        `,
      ),
      Effect.asVoid,
      mapError("enqueue"),
    );

  const listOutbox = sql<{ readonly envelope_json: string; readonly created_at: number }>`
    SELECT envelope_json, created_at FROM link_outbox ORDER BY created_at, envelope_id
  `.pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        decodeEnvelope(row.envelope_json).pipe(
          Effect.map((envelope) => ({ envelope, createdAtMs: row.created_at })),
        ),
      ),
    ),
    NodeSqliteClient.readOnly,
    mapError("listOutbox"),
  );

  const dequeue = (envelopeId: string) =>
    sql`DELETE FROM link_outbox WHERE envelope_id = ${envelopeId}`.pipe(
      Effect.asVoid,
      mapError("dequeue"),
    );

  const putActivity = (row: LinkActivityRow) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const payloadJson = yield* encodeActivity(row.entry);
          const atMs = Date.parse(row.entry.at);
          const inserted = yield* sql<{ readonly activity_id: string }>`
            INSERT INTO link_activity (
              activity_id, link_id, member_environment_id, member_thread_id, payload_json, at_ms
            )
            VALUES (
              ${row.entry.id}, ${row.linkId}, ${row.member.environmentId}, ${row.member.threadId},
              ${payloadJson}, ${Number.isFinite(atMs) ? atMs : 0}
            )
            ON CONFLICT (link_id, activity_id) DO NOTHING
            RETURNING activity_id
          `;
          if (inserted.length === 0) return false;
          yield* sql`
            DELETE FROM link_activity
            WHERE link_id = ${row.linkId}
              AND member_environment_id = ${row.member.environmentId}
              AND member_thread_id = ${row.member.threadId}
              AND activity_id NOT IN (
                SELECT activity_id FROM link_activity
                WHERE link_id = ${row.linkId}
                  AND member_environment_id = ${row.member.environmentId}
                  AND member_thread_id = ${row.member.threadId}
                ORDER BY at_ms DESC, activity_id DESC
                LIMIT ${LINK_ACTIVITY_PER_MEMBER}
              )
          `;
          return true;
        }),
      )
      .pipe(mapError("putActivity"));

  const listActivity = (linkIds: ReadonlyArray<LinkGroupId>) =>
    linkIds.length === 0
      ? Effect.succeed([])
      : sql<{
          readonly link_id: string;
          readonly member_environment_id: string;
          readonly member_thread_id: string;
          readonly payload_json: string;
        }>`
          SELECT link_id, member_environment_id, member_thread_id, payload_json
          FROM link_activity
          WHERE link_id IN ${sql.in(linkIds)}
          ORDER BY at_ms DESC, activity_id DESC
        `.pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              decodeActivity(row.payload_json).pipe(
                Effect.map((entry): LinkActivityRow => ({
                  linkId: LinkGroupId.make(row.link_id),
                  member: {
                    environmentId: EnvironmentId.make(row.member_environment_id),
                    threadId: ThreadId.make(row.member_thread_id),
                  },
                  entry,
                })),
              ),
            ),
          ),
          NodeSqliteClient.readOnly,
          mapError("listActivity"),
        );

  return LinkStore.of({
    putActivity,
    listActivity,
    chainStoppedBy,
    listRemoteMemberships,
    putRemoteMembership,
    deleteRemoteMembership,
    enqueue,
    listOutbox,
    dequeue,
    listGroups,
    commit,
    hasCommand,
    recordTask,
    getTask,
    chainTasks,
    tasksSince,
    stopChain,
    isChainStopped,
  });
});

export const layer = Layer.effect(LinkStore, make);
