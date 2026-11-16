import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE link_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    link_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX idx_link_events_command ON link_events(command_id)`;
  yield* sql`CREATE TABLE projection_link_groups (
    link_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE link_tasks (
    task_id TEXT PRIMARY KEY,
    link_id TEXT NOT NULL,
    chain_id TEXT NOT NULL,
    parent_task_id TEXT,
    hop INTEGER NOT NULL,
    requester_environment_id TEXT NOT NULL,
    requester_thread_id TEXT NOT NULL,
    assignee_environment_id TEXT NOT NULL,
    assignee_thread_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX idx_link_tasks_chain ON link_tasks(chain_id)`;
  yield* sql`CREATE INDEX idx_link_tasks_parent ON link_tasks(parent_task_id)`;
  yield* sql`CREATE INDEX idx_link_tasks_link_created ON link_tasks(link_id, created_at)`;
  yield* sql`CREATE TABLE link_stopped_chains (
    chain_id TEXT PRIMARY KEY,
    stopped_by TEXT NOT NULL,
    stopped_at TEXT NOT NULL
  )`;
});
