import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS history_sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      has_completed_initial_sync INTEGER NOT NULL DEFAULT 0,
      last_synced_remote_sequence INTEGER NOT NULL DEFAULT 0,
      last_successful_sync_at TEXT
    )
  `;
});
