import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// fwai: linked threads across environments (#21 phase 2).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Groups homed in another environment that one of this environment's threads belongs to.
  yield* sql`CREATE TABLE link_remote_memberships (
    link_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    home_environment_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (link_id, thread_id)
  )`;
  // Envelopes not yet taken by the other environment: results, membership changes, cancels.
  yield* sql`CREATE TABLE link_outbox (
    envelope_id TEXT PRIMARY KEY,
    envelope_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`;
});
