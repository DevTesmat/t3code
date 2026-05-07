import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS history_sync_pushed_events (
      sequence INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      stream_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      pushed_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_history_sync_pushed_events_stream
    ON history_sync_pushed_events(stream_id, sequence)
  `;
});
