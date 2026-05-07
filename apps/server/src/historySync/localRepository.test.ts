import { describe, expect, test } from "vitest";

import { RESTORE_BACKUP_TABLES } from "./backup.ts";
import { CLEAR_LOCAL_HISTORY_TABLES } from "./localRepository.ts";

describe("history sync local repository", () => {
  test("keeps destructive import and restore table lists aligned", () => {
    expect(RESTORE_BACKUP_TABLES).toEqual([
      ...CLEAR_LOCAL_HISTORY_TABLES,
      "history_sync_project_mappings",
      "history_sync_state",
    ]);
  });
});
