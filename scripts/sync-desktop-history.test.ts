import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, assert, describe, it } from "vitest";

import { parseSyncDesktopHistoryArgs, syncDesktopHistory } from "./sync-desktop-history.ts";

const TEST_NOW = new Date(2026, 0, 2, 3, 4, 5);
const BACKUP_SEGMENT = path.join("backups", "history-sync", "20260102-030405");

const tempDirs: Array<string> = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("syncDesktopHistory", () => {
  it("dry run prints source, target, and backup path without writing", () => {
    const baseDir = makeTempDir();
    const sourceDir = path.join(baseDir, "userdata");
    const targetDir = path.join(baseDir, "dev");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "state.sqlite"), "source-db");
    const logs: Array<string> = [];

    const result = syncDesktopHistory(
      { baseDir, dryRun: true, now: TEST_NOW },
      { checkpointSqlite: () => undefined, log: (message) => logs.push(message) },
    );

    assert.equal(result.sourceDir, sourceDir);
    assert.equal(result.targetDir, targetDir);
    assert.equal(result.backupDir, path.join(targetDir, BACKUP_SEGMENT));
    assert.ok(logs.some((line) => line.includes(`Source: ${sourceDir}`)));
    assert.ok(logs.some((line) => line.includes(`Target: ${targetDir}`)));
    assert.ok(
      logs.some((line) => line.includes(`Backup: ${path.join(targetDir, BACKUP_SEGMENT)}`)),
    );
    assert.equal(fs.existsSync(targetDir), false);
  });

  it("missing source DB exits with actionable error", () => {
    const baseDir = makeTempDir();
    fs.mkdirSync(path.join(baseDir, "userdata"), { recursive: true });

    assert.throws(
      () =>
        syncDesktopHistory(
          { baseDir, now: TEST_NOW },
          { checkpointSqlite: () => undefined, log: () => undefined },
        ),
      /installed database is missing/,
    );
  });

  it("backs up existing dev DB before replacement", () => {
    const { baseDir, sourceDir, targetDir } = createStateDirs();
    fs.writeFileSync(path.join(sourceDir, "state.sqlite"), "source-db");
    fs.writeFileSync(path.join(targetDir, "state.sqlite"), "dev-db");

    syncDesktopHistory(
      { baseDir, now: TEST_NOW },
      { checkpointSqlite: () => undefined, log: () => undefined },
    );

    assert.equal(
      fs.readFileSync(path.join(targetDir, BACKUP_SEGMENT, "state.sqlite"), "utf8"),
      "dev-db",
    );
    assert.equal(fs.readFileSync(path.join(targetDir, "state.sqlite"), "utf8"), "source-db");
  });

  it("copies source DB files to target DB", () => {
    const { baseDir, sourceDir, targetDir } = createStateDirs();
    fs.writeFileSync(path.join(sourceDir, "state.sqlite"), "source-db");
    fs.writeFileSync(path.join(sourceDir, "state.sqlite-wal"), "source-wal");
    fs.writeFileSync(path.join(sourceDir, "state.sqlite-shm"), "source-shm");

    syncDesktopHistory(
      { baseDir, now: TEST_NOW },
      { checkpointSqlite: () => undefined, log: () => undefined },
    );

    assert.equal(fs.readFileSync(path.join(targetDir, "state.sqlite"), "utf8"), "source-db");
    assert.equal(fs.readFileSync(path.join(targetDir, "state.sqlite-wal"), "utf8"), "source-wal");
    assert.equal(fs.readFileSync(path.join(targetDir, "state.sqlite-shm"), "utf8"), "source-shm");
  });

  it("copies attachments when present", () => {
    const { baseDir, sourceDir, targetDir } = createStateDirs();
    fs.writeFileSync(path.join(sourceDir, "state.sqlite"), "source-db");
    fs.mkdirSync(path.join(sourceDir, "attachments", "thread-1"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "attachments", "thread-1", "image.png"), "image");
    fs.mkdirSync(path.join(targetDir, "attachments"), { recursive: true });
    fs.writeFileSync(path.join(targetDir, "attachments", "old.txt"), "old");

    syncDesktopHistory(
      { baseDir, now: TEST_NOW },
      { checkpointSqlite: () => undefined, log: () => undefined },
    );

    assert.equal(
      fs.readFileSync(path.join(targetDir, "attachments", "thread-1", "image.png"), "utf8"),
      "image",
    );
    assert.equal(fs.existsSync(path.join(targetDir, "attachments", "old.txt")), false);
    assert.equal(
      fs.readFileSync(path.join(targetDir, BACKUP_SEGMENT, "attachments", "old.txt"), "utf8"),
      "old",
    );
  });

  it("preserves target environment-id, secrets, settings, and keybindings", () => {
    const { baseDir, sourceDir, targetDir } = createStateDirs();
    fs.writeFileSync(path.join(sourceDir, "state.sqlite"), "source-db");
    fs.writeFileSync(path.join(sourceDir, "environment-id"), "installed-env");
    fs.writeFileSync(path.join(targetDir, "environment-id"), "dev-env");
    fs.mkdirSync(path.join(targetDir, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(targetDir, "secrets", "token"), "secret");
    fs.writeFileSync(path.join(targetDir, "settings.json"), '{"theme":"dev"}');
    fs.writeFileSync(path.join(targetDir, "keybindings.json"), '{"save":"cmd+s"}');

    syncDesktopHistory(
      { baseDir, now: TEST_NOW },
      { checkpointSqlite: () => undefined, log: () => undefined },
    );

    assert.equal(fs.readFileSync(path.join(targetDir, "environment-id"), "utf8"), "dev-env");
    assert.equal(fs.readFileSync(path.join(targetDir, "secrets", "token"), "utf8"), "secret");
    assert.equal(fs.readFileSync(path.join(targetDir, "settings.json"), "utf8"), '{"theme":"dev"}');
    assert.equal(
      fs.readFileSync(path.join(targetDir, "keybindings.json"), "utf8"),
      '{"save":"cmd+s"}',
    );
  });

  it("refuses to sync when source runtime is active", () => {
    const { baseDir, sourceDir } = createStateDirs();
    fs.writeFileSync(path.join(sourceDir, "state.sqlite"), "source-db");
    fs.writeFileSync(path.join(sourceDir, "server-runtime.json"), JSON.stringify({ pid: 123 }));

    assert.throws(
      () =>
        syncDesktopHistory(
          { baseDir, now: TEST_NOW },
          { checkpointSqlite: () => undefined, isPidActive: () => "running", log: () => undefined },
        ),
      /installed server is running/,
    );
  });

  it("refuses to sync when target runtime is active", () => {
    const { baseDir, sourceDir, targetDir } = createStateDirs();
    fs.writeFileSync(path.join(sourceDir, "state.sqlite"), "source-db");
    fs.writeFileSync(path.join(targetDir, "server-runtime.json"), JSON.stringify({ pid: 123 }));

    assert.throws(
      () =>
        syncDesktopHistory(
          { baseDir, now: TEST_NOW },
          { checkpointSqlite: () => undefined, isPidActive: () => "running", log: () => undefined },
        ),
      /dev server is running/,
    );
  });

  it("source-dir and target-dir override defaults", () => {
    const baseDir = makeTempDir();
    const sourceDir = path.join(baseDir, "custom-source");
    const targetDir = path.join(baseDir, "custom-target");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "state.sqlite"), "source-db");

    const result = syncDesktopHistory(
      { baseDir, sourceDir, targetDir, now: TEST_NOW },
      { checkpointSqlite: () => undefined, log: () => undefined },
    );

    assert.equal(result.sourceDir, sourceDir);
    assert.equal(result.targetDir, targetDir);
    assert.equal(fs.readFileSync(path.join(targetDir, "state.sqlite"), "utf8"), "source-db");
    assert.equal(fs.existsSync(path.join(baseDir, "dev", "state.sqlite")), false);
  });

  it("refuses when source and target resolve to the same directory", () => {
    const baseDir = makeTempDir();
    const stateDir = path.join(baseDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "state.sqlite"), "source-db");

    assert.throws(
      () =>
        syncDesktopHistory(
          { sourceDir: stateDir, targetDir: stateDir, now: TEST_NOW },
          { checkpointSqlite: () => undefined, log: () => undefined },
        ),
      /source and target are the same directory/,
    );
  });

  it("parses CLI flags and T3CODE_HOME default", () => {
    const parsed = parseSyncDesktopHistoryArgs(
      ["--source-dir", "/source", "--target-dir", "/target", "--dry-run", "--force"],
      { T3CODE_HOME: "/base" },
    );

    assert.deepStrictEqual(parsed, {
      baseDir: "/base",
      sourceDir: "/source",
      targetDir: "/target",
      dryRun: true,
      force: true,
    });
  });
});

function createStateDirs() {
  const baseDir = makeTempDir();
  const sourceDir = path.join(baseDir, "userdata");
  const targetDir = path.join(baseDir, "dev");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });
  return { baseDir, sourceDir, targetDir };
}

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-sync-history-"));
  tempDirs.push(dir);
  return dir;
}
