import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  if (columns.some((column) => column.name === "pinned_at")) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN pinned_at TEXT
  `;
});
