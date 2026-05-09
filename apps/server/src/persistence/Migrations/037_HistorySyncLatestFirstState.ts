import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE history_sync_state
    ADD COLUMN remote_applied_sequence INTEGER NOT NULL DEFAULT 0
  `;

  yield* sql`
    ALTER TABLE history_sync_state
    ADD COLUMN remote_known_max_sequence INTEGER NOT NULL DEFAULT 0
  `;

  yield* sql`
    ALTER TABLE history_sync_state
    ADD COLUMN latest_bootstrap_completed_at TEXT
  `;

  yield* sql`
    ALTER TABLE history_sync_state
    ADD COLUMN backfill_cursor_updated_at TEXT
  `;

  yield* sql`
    ALTER TABLE history_sync_state
    ADD COLUMN live_append_enabled INTEGER NOT NULL DEFAULT 0
  `;

  yield* sql`
    UPDATE history_sync_state
    SET
      remote_applied_sequence = last_synced_remote_sequence,
      remote_known_max_sequence = last_synced_remote_sequence,
      live_append_enabled = has_completed_initial_sync
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS history_sync_thread_state (
      thread_id TEXT PRIMARY KEY,
      remote_project_id TEXT,
      local_project_id TEXT,
      latest_remote_sequence INTEGER NOT NULL DEFAULT 0,
      imported_through_sequence INTEGER NOT NULL DEFAULT 0,
      is_shell_loaded INTEGER NOT NULL DEFAULT 0,
      is_full_loaded INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 0,
      last_requested_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_history_sync_thread_state_priority
    ON history_sync_thread_state(priority DESC, updated_at DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_history_sync_thread_state_full_loaded
    ON history_sync_thread_state(is_full_loaded, latest_remote_sequence DESC)
  `;
});
