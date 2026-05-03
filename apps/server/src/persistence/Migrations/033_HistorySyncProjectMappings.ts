import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE history_sync_state
    ADD COLUMN client_id TEXT NOT NULL DEFAULT ''
  `;

  yield* sql`
    UPDATE history_sync_state
    SET client_id = lower(hex(randomblob(16)))
    WHERE client_id = ''
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS history_sync_project_mappings (
      remote_project_id TEXT PRIMARY KEY,
      local_project_id TEXT NOT NULL,
      local_workspace_root TEXT NOT NULL,
      remote_workspace_root TEXT NOT NULL,
      remote_title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_history_sync_project_mappings_local_project
    ON history_sync_project_mappings(local_project_id)
  `;
});
