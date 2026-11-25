import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// fwai: the account a scheduled task's runs act for; NULL is the environment owner.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN acting_account_id TEXT`;
});
