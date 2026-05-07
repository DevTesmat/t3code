import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_HistorySyncInitialPhase", (it) => {
  it.effect("adds durable initial sync phase columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 36 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(history_sync_state)
      `;
      assert.ok(columns.some((column) => column.name === "initial_sync_phase"));
      assert.ok(columns.some((column) => column.name === "initial_sync_started_at"));
      assert.ok(columns.some((column) => column.name === "initial_sync_error"));
    }),
  );
});
