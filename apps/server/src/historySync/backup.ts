import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import { HistorySyncConfigError } from "@t3tools/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

const HISTORY_SYNC_BACKUP_FILE_NAME = "history-sync-pre-sync.sqlite";
const RESTORE_BACKUP_TABLES = [
  "orchestration_command_receipts",
  "projection_pending_approvals",
  "projection_turns",
  "projection_thread_sessions",
  "projection_thread_activities",
  "projection_thread_proposed_plans",
  "projection_thread_messages",
  "projection_threads",
  "projection_projects",
  "projection_state",
  "checkpoint_diff_blobs",
  "history_sync_pushed_events",
  "orchestration_events",
  "history_sync_project_mappings",
  "history_sync_state",
] as const;

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

function restoreBackupTables(sql: SqlClient.SqlClient) {
  return sql.withTransaction(
    Effect.all(
      [
        sql`DELETE FROM orchestration_command_receipts`,
        sql`DELETE FROM projection_pending_approvals`,
        sql`DELETE FROM projection_turns`,
        sql`DELETE FROM projection_thread_sessions`,
        sql`DELETE FROM projection_thread_activities`,
        sql`DELETE FROM projection_thread_proposed_plans`,
        sql`DELETE FROM projection_thread_messages`,
        sql`DELETE FROM projection_threads`,
        sql`DELETE FROM projection_projects`,
        sql`DELETE FROM projection_state`,
        sql`DELETE FROM checkpoint_diff_blobs`,
        sql`DELETE FROM history_sync_pushed_events`,
        sql`DELETE FROM orchestration_events`,
        sql`DELETE FROM history_sync_project_mappings`,
        sql`DELETE FROM history_sync_state`,
        sql`
          INSERT INTO orchestration_command_receipts
          SELECT * FROM history_sync_backup.orchestration_command_receipts
        `,
        sql`
          INSERT INTO projection_pending_approvals
          SELECT * FROM history_sync_backup.projection_pending_approvals
        `,
        sql`
          INSERT INTO projection_turns
          SELECT * FROM history_sync_backup.projection_turns
        `,
        sql`
          INSERT INTO projection_thread_sessions
          SELECT * FROM history_sync_backup.projection_thread_sessions
        `,
        sql`
          INSERT INTO projection_thread_activities
          SELECT * FROM history_sync_backup.projection_thread_activities
        `,
        sql`
          INSERT INTO projection_thread_proposed_plans
          SELECT * FROM history_sync_backup.projection_thread_proposed_plans
        `,
        sql`
          INSERT INTO projection_thread_messages
          SELECT * FROM history_sync_backup.projection_thread_messages
        `,
        sql`
          INSERT INTO projection_threads
          SELECT * FROM history_sync_backup.projection_threads
        `,
        sql`
          INSERT INTO projection_projects
          SELECT * FROM history_sync_backup.projection_projects
        `,
        sql`
          INSERT INTO projection_state
          SELECT * FROM history_sync_backup.projection_state
        `,
        sql`
          INSERT INTO checkpoint_diff_blobs
          SELECT * FROM history_sync_backup.checkpoint_diff_blobs
        `,
        sql`
          INSERT INTO history_sync_pushed_events
          SELECT * FROM history_sync_backup.history_sync_pushed_events
        `,
        sql`
          INSERT INTO orchestration_events
          SELECT * FROM history_sync_backup.orchestration_events
        `,
        sql`
          INSERT INTO history_sync_project_mappings
          SELECT * FROM history_sync_backup.history_sync_project_mappings
        `,
        sql`
          INSERT INTO history_sync_state
          SELECT * FROM history_sync_backup.history_sync_state
        `,
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
