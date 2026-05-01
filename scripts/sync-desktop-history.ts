import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type RuntimeRole = "installed" | "dev";

type ProcessStatus = "running" | "inactive" | "inconclusive";

export interface SyncDesktopHistoryOptions {
  readonly baseDir?: string;
  readonly sourceDir?: string;
  readonly targetDir?: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly now?: Date;
}

interface SyncDesktopHistoryDeps {
  readonly isPidActive?: (pid: number) => ProcessStatus;
  readonly checkpointSqlite?: (dbPath: string) => void;
  readonly log?: (message: string) => void;
}

interface ParsedArgs extends SyncDesktopHistoryOptions {
  readonly help?: boolean;
}

interface MutableParsedArgs {
  baseDir?: string;
  sourceDir?: string;
  targetDir?: string;
  dryRun?: boolean;
  force?: boolean;
  help?: boolean;
}

const DB_FILES = ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"] as const;
const BACKUP_FILES = [...DB_FILES, "attachments"] as const;

const padTimestampPart = (value: number) => value.toString().padStart(2, "0");

class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function parseSyncDesktopHistoryArgs(
  args: ReadonlyArray<string>,
  env = process.env,
): ParsedArgs {
  const parsed: MutableParsedArgs = {};
  if (env.T3CODE_HOME !== undefined) parsed.baseDir = env.T3CODE_HOME;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      return { ...parsed, help: true };
    }

    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (arg === "--force") {
      parsed.force = true;
      continue;
    }

    if (arg === "--base-dir" || arg === "--source-dir" || arg === "--target-dir") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliError(`Missing value for ${arg}`);
      }

      if (arg === "--base-dir") parsed.baseDir = value;
      if (arg === "--source-dir") parsed.sourceDir = value;
      if (arg === "--target-dir") parsed.targetDir = value;
      index += 1;
      continue;
    }

    throw new CliError(`Unknown argument: ${arg}`);
  }

  return parsed;
}

export function syncDesktopHistory(
  options: SyncDesktopHistoryOptions = {},
  deps: SyncDesktopHistoryDeps = {},
) {
  const log = deps.log ?? console.log;
  const baseDir = path.resolve(options.baseDir ?? path.join(os.homedir(), ".t3"));
  const sourceDir = path.resolve(options.sourceDir ?? path.join(baseDir, "userdata"));
  const targetDir = path.resolve(options.targetDir ?? path.join(baseDir, "dev"));
  const sourceDb = path.join(sourceDir, "state.sqlite");
  const backupDir = path.join(
    targetDir,
    "backups",
    "history-sync",
    formatTimestamp(options.now ?? new Date()),
  );

  log(`T3Code history sync`);
  log(`Source: ${sourceDir}`);
  log(`Target: ${targetDir}`);
  log(`Backup: ${backupDir}`);

  if (sourceDir === targetDir) {
    throw new CliError(
      `T3Code history sync refused because source and target are the same directory: ${sourceDir}`,
    );
  }

  if (!fs.existsSync(sourceDb)) {
    throw new CliError(
      `T3Code history sync refused because the installed database is missing: ${sourceDb}`,
    );
  }

  assertRuntimeInactive(
    "installed",
    sourceDir,
    options.force === true,
    deps.isPidActive ?? defaultPidStatus,
  );
  assertRuntimeInactive(
    "dev",
    targetDir,
    options.force === true,
    deps.isPidActive ?? defaultPidStatus,
  );

  const plannedActions = buildPlannedActions({ sourceDir, targetDir, backupDir });
  for (const action of plannedActions) log(action);

  if (options.dryRun === true) {
    log("Dry run complete. No files were changed.");
    return { sourceDir, targetDir, backupDir };
  }

  fs.mkdirSync(backupDir, { recursive: true });
  backupExistingTargetFiles(targetDir, backupDir);

  (deps.checkpointSqlite ?? checkpointSqlite)(sourceDb);

  for (const dbFile of DB_FILES) {
    removePath(path.join(targetDir, dbFile));
  }

  fs.mkdirSync(targetDir, { recursive: true });
  for (const dbFile of DB_FILES) {
    const sourcePath = path.join(sourceDir, dbFile);
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, path.join(targetDir, dbFile));
    }
  }

  removePath(path.join(targetDir, "attachments"));
  const sourceAttachments = path.join(sourceDir, "attachments");
  if (fs.existsSync(sourceAttachments)) {
    copyDirectory(sourceAttachments, path.join(targetDir, "attachments"));
  }

  log("T3Code history sync complete.");
  return { sourceDir, targetDir, backupDir };
}

function buildPlannedActions(input: { sourceDir: string; targetDir: string; backupDir: string }) {
  const actions = [`Will create backup directory: ${input.backupDir}`];

  for (const fileName of BACKUP_FILES) {
    const targetPath = path.join(input.targetDir, fileName);
    if (fs.existsSync(targetPath)) {
      actions.push(`Will back up: ${targetPath}`);
    }
  }

  for (const dbFile of DB_FILES) {
    actions.push(`Will replace: ${path.join(input.targetDir, dbFile)}`);
  }

  actions.push(`Will replace: ${path.join(input.targetDir, "attachments")}`);
  return actions;
}

function assertRuntimeInactive(
  role: RuntimeRole,
  stateDir: string,
  force: boolean,
  isPidActive: (pid: number) => ProcessStatus,
) {
  const runtimePath = path.join(stateDir, "server-runtime.json");
  if (!fs.existsSync(runtimePath)) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
  } catch {
    if (!force) {
      throw new CliError(
        `T3Code history sync refused because ${runtimePath} could not be parsed. Use --force only after confirming T3Code is quit.`,
      );
    }
    return;
  }

  const pid =
    typeof parsed === "object" && parsed !== null && "pid" in parsed ? parsed.pid : undefined;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return;

  const status = isPidActive(pid);
  if (status === "running") {
    throw new CliError(
      `T3Code history sync refused because ${role} server is running.\nQuit T3Code and retry.`,
    );
  }

  if (status === "inconclusive" && !force) {
    throw new CliError(
      `T3Code history sync refused because ${role} server runtime status was inconclusive. Use --force only after confirming T3Code is quit.`,
    );
  }
}

function defaultPidStatus(pid: number): ProcessStatus {
  try {
    process.kill(pid, 0);
    return "running";
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ESRCH") return "inactive";
    if (code === "EPERM") return "running";
    return "inconclusive";
  }
}

function backupExistingTargetFiles(targetDir: string, backupDir: string) {
  for (const fileName of BACKUP_FILES) {
    const targetPath = path.join(targetDir, fileName);
    if (!fs.existsSync(targetPath)) continue;

    const backupPath = path.join(backupDir, fileName);
    if (fs.statSync(targetPath).isDirectory()) {
      copyDirectory(targetPath, backupPath);
    } else {
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(targetPath, backupPath);
    }
  }
}

function checkpointSqlite(dbPath: string) {
  const result = childProcess.spawnSync("sqlite3", [dbPath, "PRAGMA wal_checkpoint(FULL);"], {
    encoding: "utf8",
  });

  if (result.error !== undefined) {
    throw new CliError(
      `Failed to checkpoint source database with sqlite3: ${result.error.message}`,
    );
  }

  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.status}`;
    throw new CliError(`Failed to checkpoint source database with sqlite3: ${detail}`);
  }
}

function copyDirectory(source: string, target: string) {
  fs.cpSync(source, target, { recursive: true, force: true, errorOnExist: false });
}

function removePath(targetPath: string) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function formatTimestamp(date: Date) {
  return [
    date.getFullYear().toString(),
    padTimestampPart(date.getMonth() + 1),
    padTimestampPart(date.getDate()),
    "-",
    padTimestampPart(date.getHours()),
    padTimestampPart(date.getMinutes()),
    padTimestampPart(date.getSeconds()),
  ].join("");
}

function usage() {
  return `Usage: node scripts/sync-desktop-history.ts [options]

Options:
  --base-dir <path>    Base T3Code dir. Defaults to T3CODE_HOME or ~/.t3.
  --source-dir <path>  Source state dir. Defaults to <base-dir>/userdata.
  --target-dir <path>  Target state dir. Defaults to <base-dir>/dev.
  --dry-run            Print planned work without changing files.
  --force              Allow stale/inconclusive runtime files, but never confirmed live processes.
  --help               Show this help.
`;
}

function main() {
  try {
    const parsed = parseSyncDesktopHistoryArgs(process.argv.slice(2));
    if (parsed.help === true) {
      console.log(usage());
      return;
    }
    syncDesktopHistory(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === currentFile) {
  main();
}
