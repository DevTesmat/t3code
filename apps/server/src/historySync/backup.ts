import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import { HistorySyncConfigError } from "@t3tools/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

const HISTORY_SYNC_BACKUP_FILE_NAME = "history-sync-pre-sync.sqlite";

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
    yield* restoreBackupTables(sql).pipe(
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
