import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("037_HistorySyncLatestFirstState", (it) => {
  it.effect("adds latest-first sync cursors and per-thread state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });

      const stateColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(history_sync_state)
      `;
      for (const columnName of [
        "remote_applied_sequence",
        "remote_known_max_sequence",
        "latest_bootstrap_completed_at",
        "backfill_cursor_updated_at",
        "live_append_enabled",
      ]) {
        assert.ok(
          stateColumns.some((column) => column.name === columnName),
          `missing ${columnName}`,
        );
      }

      const threadStateTables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name = 'history_sync_thread_state'
      `;
      assert.strictEqual(threadStateTables.length, 1);
    }),
  );
});
