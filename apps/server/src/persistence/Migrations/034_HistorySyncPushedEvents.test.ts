import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("034_HistorySyncPushedEvents", (it) => {
  it.effect("creates pushed event receipts table and stream index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 34 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(history_sync_pushed_events)
      `;
      assert.deepStrictEqual(
        columns.map((column) => column.name),
        ["sequence", "event_id", "stream_id", "event_type", "pushed_at"],
      );

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(history_sync_pushed_events)
      `;
      assert.ok(indexes.some((index) => index.name === "idx_history_sync_pushed_events_stream"));

      const indexColumns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info('idx_history_sync_pushed_events_stream')
      `;
      assert.deepStrictEqual(
        indexColumns.map((column) => column.name),
        ["stream_id", "sequence"],
      );
    }),
  );
});
