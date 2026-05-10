import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tool_call_file_diffs (
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      tool_call_id TEXT NOT NULL,
      diff TEXT NOT NULL,
      truncated INTEGER NOT NULL DEFAULT 0,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, tool_call_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_tool_call_file_diffs_thread
    ON tool_call_file_diffs(thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_tool_call_file_diffs_updated_at
    ON tool_call_file_diffs(updated_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_tool_call_file_diffs_last_accessed_at
    ON tool_call_file_diffs(last_accessed_at)
  `;
});
