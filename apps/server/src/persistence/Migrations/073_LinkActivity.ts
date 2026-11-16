import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// fwai: what each linked thread's runs did, one line per run (#37).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE link_activity (
    activity_id TEXT NOT NULL,
    link_id TEXT NOT NULL,
    member_environment_id TEXT NOT NULL,
    member_thread_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    PRIMARY KEY (link_id, activity_id)
  )`;
  yield* sql`CREATE INDEX link_activity_member
    ON link_activity (link_id, member_environment_id, member_thread_id, at_ms)`;
});
