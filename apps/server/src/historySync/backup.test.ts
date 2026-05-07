import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";

import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";

import {
  historySyncBackupPath,
  readBackupSummary,
  restoreBackupTablesFromDisk,
  validateBackupTableMetadata,
} from "./backup.ts";

describe("history sync backup", () => {
  test("uses the pre-sync sqlite backup file beside the server database", () => {
    expect(historySyncBackupPath("/tmp/t3-code/server.sqlite")).toBe(
      Path.join("/tmp/t3-code", "history-sync-pre-sync.sqlite"),
    );
  });

  test("accepts compatible backup table metadata", async () => {
    await expect(
      Effect.runPromise(
        validateBackupTableMetadata([
          {
            tableName: "orchestration_events",
            localColumnCount: 14,
            backupColumnCount: 14,
          },
        ]),
      ),
    ).resolves.toBeUndefined();
  });

  test("rejects backups missing required tables", async () => {
    const exit = await Effect.runPromiseExit(
      validateBackupTableMetadata([
        {
          tableName: "history_sync_state",
          localColumnCount: 5,
          backupColumnCount: null,
        },
      ]),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain("Missing tables: history_sync_state");
    }
  });

  test("rejects backups with mismatched column counts", async () => {
    const exit = await Effect.runPromiseExit(
      validateBackupTableMetadata([
        {
          tableName: "projection_threads",
          localColumnCount: 16,
          backupColumnCount: 15,
        },
      ]),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain("Column count mismatch");
      expect(exit.cause.toString()).toContain("projection_threads (local 16, backup 15)");
    }
  });

  test("readBackupSummary returns null when pre-sync backup is missing", async () => {
    const dir = await Fs.mkdtemp(Path.join(Os.tmpdir(), "history-sync-backup-"));
    try {
      const dbPath = Path.join(dir, "local.sqlite");

      await expect(Effect.runPromise(readBackupSummary(dbPath))).resolves.toBeNull();
    } finally {
      await Fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("restore fails with missing-backup guidance when no pre-sync backup exists", async () => {
    const dir = await Fs.mkdtemp(Path.join(Os.tmpdir(), "history-sync-backup-"));
    try {
      const dbPath = Path.join(dir, "local.sqlite");
      const sql = (() => Effect.void) as never;

      const exit = await Effect.runPromiseExit(restoreBackupTablesFromDisk(sql, dbPath));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.toString()).toContain("No history sync SQLite backup is available.");
      }
    } finally {
      await Fs.rm(dir, { recursive: true, force: true });
    }
  });
});
