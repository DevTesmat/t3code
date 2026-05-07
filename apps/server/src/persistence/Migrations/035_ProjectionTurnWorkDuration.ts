import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN work_duration_ms INTEGER
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    UPDATE projection_turns
    SET work_duration_ms =
      CASE
        WHEN turn_id IS NOT NULL
          AND started_at IS NOT NULL
          AND completed_at IS NOT NULL
          AND julianday(completed_at) >= julianday(started_at)
        THEN CAST(ROUND((julianday(completed_at) - julianday(started_at)) * 86400000) AS INTEGER)
        ELSE NULL
      END
    WHERE work_duration_ms IS NULL
  `;
});
