import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE history_sync_state
    ADD COLUMN initial_sync_phase TEXT
  `;

  yield* sql`
    ALTER TABLE history_sync_state
    ADD COLUMN initial_sync_started_at TEXT
  `;

  yield* sql`
    ALTER TABLE history_sync_state
    ADD COLUMN initial_sync_error TEXT
  `;
});
