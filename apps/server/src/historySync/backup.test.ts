import * as Path from "node:path";

import { describe, expect, test } from "vitest";
import { Effect, Exit } from "effect";

import { historySyncBackupPath, validateBackupTableMetadata } from "./backup.ts";

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
});
