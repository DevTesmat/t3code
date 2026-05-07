import * as Path from "node:path";

import { describe, expect, test } from "vitest";

import { historySyncBackupPath } from "./backup.ts";

describe("history sync backup", () => {
  test("uses the pre-sync sqlite backup file beside the server database", () => {
    expect(historySyncBackupPath("/tmp/t3-code/server.sqlite")).toBe(
      Path.join("/tmp/t3-code", "history-sync-pre-sync.sqlite"),
    );
  });
});
