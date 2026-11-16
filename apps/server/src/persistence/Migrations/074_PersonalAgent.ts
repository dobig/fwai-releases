import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// fwai: personal agent (#22). One row: the agent thread, its project and the owner's permissions.
// Requests live in the relay; this environment keeps none.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE personal_agent (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload_json TEXT NOT NULL
  )`;
});
