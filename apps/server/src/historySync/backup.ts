import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import { HistorySyncConfigError } from "@t3tools/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { HISTORY_SYNC_RESTORE_TABLES } from "./tableManifest.ts";
import type { HistorySyncRestoreTable } from "./tableManifest.ts";

const HISTORY_SYNC_BACKUP_FILE_NAME = "history-sync-pre-sync.sqlite";
export const RESTORE_BACKUP_TABLES = HISTORY_SYNC_RESTORE_TABLES;

export interface BackupTableMetadata {
  readonly tableName: string;
  readonly localColumnCount: number;
  readonly backupColumnCount: number | null;
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function describeSyncFailure(error: unknown): string {
  const wrappedCause =
    typeof error === "object" && error !== null && "cause" in error
      ? (error as { readonly cause?: unknown }).cause
      : undefined;
  return describeUnknownError(wrappedCause ?? error) || "History sync failed.";
}

export function historySyncBackupPath(dbPath: string): string {
  return Path.join(Path.dirname(dbPath), HISTORY_SYNC_BACKUP_FILE_NAME);
}

export function readBackupSummary(dbPath: string) {
  const backupPath = historySyncBackupPath(dbPath);
  return Effect.promise(async () => {
    try {
      const stat = await Fs.stat(backupPath);
      if (!stat.isFile()) return null;
      return {
        createdAt: stat.mtime.toISOString(),
        path: backupPath,
      };
    } catch {
      return null;
    }
  });
}

export function createSqliteBackup(sql: SqlClient.SqlClient, dbPath: string) {
  const backupPath = historySyncBackupPath(dbPath);
  return Effect.gen(function* () {
    yield* sql`PRAGMA wal_checkpoint(FULL)`;
    yield* Effect.tryPromise({
      try: async () => {
        await Fs.mkdir(Path.dirname(backupPath), { recursive: true });
        await Fs.copyFile(dbPath, backupPath);
      },
      catch: (cause) =>
        new HistorySyncConfigError({
          message: describeUnknownError(cause) || "Failed to create history sync backup.",
        }),
    });
    console.info("[history-sync] sqlite backup created", { path: backupPath });
  });
}

export function validateBackupTableMetadata(
  tables: readonly BackupTableMetadata[],
): Effect.Effect<void, HistorySyncConfigError> {
  const missingTables = tables
    .filter((table) => table.backupColumnCount === null)
    .map((table) => table.tableName);
  if (missingTables.length > 0) {
    return Effect.fail(
      new HistorySyncConfigError({
        message: `History sync SQLite backup is incompatible. Missing tables: ${missingTables.join(", ")}.`,
      }),
    );
  }

  const mismatchedTables = tables.filter(
    (table) =>
      table.backupColumnCount !== null && table.localColumnCount !== table.backupColumnCount,
  );
  if (mismatchedTables.length > 0) {
    return Effect.fail(
      new HistorySyncConfigError({
        message: `History sync SQLite backup is incompatible. Column count mismatch: ${mismatchedTables
          .map(
            (table) =>
              `${table.tableName} (local ${table.localColumnCount}, backup ${table.backupColumnCount})`,
          )
          .join(", ")}.`,
      }),
    );
  }

  return Effect.void;
}

function validateAttachedBackupSchema(sql: SqlClient.SqlClient) {
  return Effect.forEach(
    RESTORE_BACKUP_TABLES,
    (tableName) =>
      Effect.gen(function* () {
        const backupTableRows = yield* sql<{ readonly name: string }>`
          SELECT name
          FROM history_sync_backup.sqlite_master
          WHERE type = 'table' AND name = ${tableName}
        `;
        const localColumnRows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM pragma_table_info(${tableName})
        `;
        const backupColumnRows =
          backupTableRows.length === 0
            ? []
            : yield* sql<{ readonly count: number }>`
                SELECT COUNT(*) AS count
                FROM history_sync_backup.pragma_table_info(${tableName})
              `;

        return {
          tableName,
          localColumnCount: localColumnRows[0]?.count ?? 0,
          backupColumnCount:
            backupTableRows.length === 0 ? null : (backupColumnRows[0]?.count ?? 0),
        } satisfies BackupTableMetadata;
      }),
    { concurrency: 1 },
  ).pipe(Effect.flatMap(validateBackupTableMetadata));
}

export function deleteHistorySyncRestoreTable(
  sql: SqlClient.SqlClient,
  tableName: HistorySyncRestoreTable,
) {
  return sql`DELETE FROM ${sql(tableName)}`;
}

export function copyHistorySyncRestoreTableFromBackup(
  sql: SqlClient.SqlClient,
  tableName: HistorySyncRestoreTable,
) {
  return sql`
    INSERT INTO ${sql(tableName)}
    SELECT * FROM ${sql("history_sync_backup")}.${sql(tableName)}
  `;
}

function restoreBackupTables(sql: SqlClient.SqlClient) {
  return sql.withTransaction(
    Effect.all(
      [
        ...RESTORE_BACKUP_TABLES.map((tableName) => deleteHistorySyncRestoreTable(sql, tableName)),
        ...RESTORE_BACKUP_TABLES.map((tableName) =>
          copyHistorySyncRestoreTableFromBackup(sql, tableName),
        ),
      ],
      { concurrency: 1 },
    ),
  );
}

export function restoreBackupTablesFromDisk(sql: SqlClient.SqlClient, dbPath: string) {
  const backupPath = historySyncBackupPath(dbPath);
  return Effect.gen(function* () {
    const backup = yield* readBackupSummary(dbPath);
    if (!backup) {
      return yield* new HistorySyncConfigError({
        message: "No history sync SQLite backup is available.",
      });
    }
    yield* sql`ATTACH DATABASE ${backupPath} AS history_sync_backup`;
    yield* validateAttachedBackupSchema(sql).pipe(
      Effect.andThen(restoreBackupTables(sql)),
      Effect.ensuring(sql`DETACH DATABASE history_sync_backup`.pipe(Effect.ignore)),
    );
    console.info("[history-sync] sqlite backup restored", { path: backupPath });
  }).pipe(
    Effect.catchTag("HistorySyncConfigError", (cause) => Effect.fail(cause)),
    Effect.mapError(
      (cause) =>
        new HistorySyncConfigError({
          message: describeSyncFailure(cause),
        }),
    ),
  );
}
