import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, test } from "vitest";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { RESTORE_BACKUP_TABLES } from "./backup.ts";
import { CLEAR_LOCAL_HISTORY_TABLES } from "./localRepository.ts";
import {
  HISTORY_SYNC_EXCLUDED_TABLES,
  HISTORY_SYNC_LOCAL_HISTORY_TABLES,
  HISTORY_SYNC_RESTORE_ONLY_TABLES,
  HISTORY_SYNC_RESTORE_TABLES,
} from "./tableManifest.ts";

describe("history sync local repository", () => {
  test("keeps destructive import and restore table lists aligned", () => {
    expect(RESTORE_BACKUP_TABLES).toEqual([
      ...CLEAR_LOCAL_HISTORY_TABLES,
      "history_sync_project_mappings",
      "history_sync_state",
    ]);
    expect(CLEAR_LOCAL_HISTORY_TABLES).toBe(HISTORY_SYNC_LOCAL_HISTORY_TABLES);
    expect(RESTORE_BACKUP_TABLES).toBe(HISTORY_SYNC_RESTORE_TABLES);
    expect(HISTORY_SYNC_RESTORE_ONLY_TABLES).toEqual([
      "history_sync_project_mappings",
      "history_sync_state",
    ]);
  });
});

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

function isHistorySyncClassifiedTable(tableName: string): boolean {
  return (
    tableName.startsWith("orchestration_") ||
    tableName.startsWith("projection_") ||
    tableName.startsWith("checkpoint_") ||
    tableName.startsWith("history_sync_") ||
    HISTORY_SYNC_EXCLUDED_TABLES.some((entry) => entry.tableName === tableName)
  );
}

layer("history sync destructive table manifest", (it) => {
  it.effect("classifies every migrated history-derived table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      const rows = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name != 'effect_sql_migrations'
        ORDER BY name ASC
      `;

      const destructiveTables: ReadonlySet<string> = new Set([
        ...HISTORY_SYNC_LOCAL_HISTORY_TABLES,
        ...HISTORY_SYNC_RESTORE_ONLY_TABLES,
      ]);
      const excludedTables: ReadonlySet<string> = new Set(
        HISTORY_SYNC_EXCLUDED_TABLES.map((entry) => entry.tableName),
      );
      const unclassified = rows
        .map((row) => row.name)
        .filter(isHistorySyncClassifiedTable)
        .filter((tableName) => !destructiveTables.has(tableName) && !excludedTables.has(tableName));

      assert.deepStrictEqual(unclassified, []);
    }),
  );

  it.effect("records reasons for explicitly excluded tables", () =>
    Effect.sync(() => {
      for (const entry of HISTORY_SYNC_EXCLUDED_TABLES) {
        assert.ok(entry.reason.trim().length > 0, `${entry.tableName} is missing a reason`);
      }
    }),
  );
});
