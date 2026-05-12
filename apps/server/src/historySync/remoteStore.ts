import { type HistorySyncMysqlFields, type OrchestrationEvent } from "@t3tools/contracts";
import { Data, Effect } from "effect";
import type { Pool, RowDataPacket } from "mysql2/promise";

import {
  chunkHistorySyncEvents,
  collectProjectCandidates,
  type HistorySyncEventRow,
  type ProjectCandidate,
} from "./planner.ts";

const HISTORY_SYNC_MYSQL_BATCH_SIZE = 500;
const HISTORY_SYNC_MYSQL_CONNECT_TIMEOUT_MS = 10_000;

const MYSQL_SCHEMA_STATEMENTS = [
  `
CREATE TABLE IF NOT EXISTS orchestration_events (
  sequence BIGINT NOT NULL PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL UNIQUE,
  aggregate_kind VARCHAR(32) NOT NULL,
  stream_id VARCHAR(255) NOT NULL,
  stream_version BIGINT NOT NULL,
  event_type VARCHAR(128) NOT NULL,
  occurred_at VARCHAR(64) NOT NULL,
  command_id VARCHAR(255) NULL,
  causation_event_id VARCHAR(255) NULL,
  correlation_id VARCHAR(255) NULL,
  actor_kind VARCHAR(32) NOT NULL,
  payload_json JSON NOT NULL,
  metadata_json JSON NOT NULL,
  UNIQUE KEY idx_orch_events_stream_version (aggregate_kind, stream_id, stream_version),
  KEY idx_orch_events_stream_sequence (aggregate_kind, stream_id, sequence),
  KEY idx_orch_events_command_id (command_id),
  KEY idx_orch_events_correlation_id (correlation_id)
)`,
  `
CREATE TABLE IF NOT EXISTS history_sync_projects (
  project_id VARCHAR(255) NOT NULL PRIMARY KEY,
  title VARCHAR(512) NOT NULL,
  workspace_root TEXT NOT NULL,
  deleted_at VARCHAR(64) NULL,
  first_sequence BIGINT NOT NULL,
  latest_sequence BIGINT NOT NULL,
  updated_at VARCHAR(64) NOT NULL,
  KEY idx_history_sync_projects_latest (latest_sequence),
  KEY idx_history_sync_projects_updated (updated_at)
)`,
  `
CREATE TABLE IF NOT EXISTS history_sync_threads (
  thread_id VARCHAR(255) NOT NULL PRIMARY KEY,
  project_id VARCHAR(255) NULL,
  title VARCHAR(512) NOT NULL,
  created_at VARCHAR(64) NOT NULL,
  updated_at VARCHAR(64) NOT NULL,
  latest_event_sequence BIGINT NOT NULL,
  deleted_at VARCHAR(64) NULL,
  archived_at VARCHAR(64) NULL,
  KEY idx_history_sync_threads_latest (updated_at, latest_event_sequence),
  KEY idx_history_sync_threads_project (project_id, updated_at)
)`,
  `
CREATE TABLE IF NOT EXISTS history_sync_thread_events (
  thread_id VARCHAR(255) NOT NULL,
  sequence BIGINT NOT NULL,
  PRIMARY KEY (thread_id, sequence),
  KEY idx_history_sync_thread_events_sequence (sequence)
)`,
  `
CREATE TABLE IF NOT EXISTS history_sync_clients (
  client_id VARCHAR(255) NOT NULL PRIMARY KEY,
  label VARCHAR(255) NULL,
  last_seen_at VARCHAR(64) NOT NULL
)`,
  `
CREATE TABLE IF NOT EXISTS history_sync_conflicts (
  conflict_id VARCHAR(255) NOT NULL PRIMARY KEY,
  thread_id VARCHAR(255) NOT NULL,
  base_remote_sequence BIGINT NOT NULL,
  local_event_count BIGINT NOT NULL,
  remote_event_count BIGINT NOT NULL,
  resolution VARCHAR(64) NOT NULL,
  created_at VARCHAR(64) NOT NULL,
  KEY idx_history_sync_conflicts_thread (thread_id, created_at)
)`,
] as const;

export interface HistorySyncRemoteThreadShellRow {
  readonly threadId: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestEventSequence: number;
  readonly deletedAt: string | null;
  readonly archivedAt: string | null;
}

export class HistorySyncMysqlError extends Data.TaggedError("HistorySyncMysqlError")<{
  readonly cause: unknown;
}> {}

function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function getErrorNumber(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("errno" in error)) {
    return null;
  }
  const errno = (error as { readonly errno?: unknown }).errno;
  return typeof errno === "number" ? errno : null;
}

function unwrapHistorySyncMysqlCause(error: unknown): unknown {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error as { readonly _tag?: unknown })._tag === "HistorySyncMysqlError" &&
    "cause" in error
  ) {
    return (error as { readonly cause?: unknown }).cause;
  }
  if (error instanceof HistorySyncMysqlError) {
    return error.cause;
  }
  return error;
}

export function isRetryableHistorySyncConnectionFailure(error: unknown): boolean {
  const cause = unwrapHistorySyncMysqlCause(error);
  const code = getErrorCode(cause);
  return (
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND"
  );
}

export function isHistorySyncMysqlAccessDenied(error: unknown): boolean {
  const cause = unwrapHistorySyncMysqlCause(error);
  return getErrorCode(cause) === "ER_TABLEACCESS_DENIED_ERROR" || getErrorNumber(cause) === 1142;
}

export function validateMysqlFields(input: HistorySyncMysqlFields): HistorySyncMysqlFields {
  const host = input.host.trim();
  const database = input.database.trim();
  const username = input.username.trim();
  const password = input.password;
  if (!host) throw new Error("MySQL host is required.");
  if (!database) throw new Error("MySQL database is required.");
  if (!username) throw new Error("MySQL username is required.");
  if (!password) throw new Error("MySQL password is required.");
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error("MySQL port must be between 1 and 65535.");
  }
  return { ...input, host, database, username };
}

export function buildMysqlConnectionString(input: HistorySyncMysqlFields): string {
  const validated = validateMysqlFields(input);
  const url = new URL("mysql://");
  url.hostname = validated.host;
  url.port = String(validated.port);
  url.pathname = `/${encodeURIComponent(validated.database)}`;
  url.username = validated.username;
  url.password = validated.password;
  url.searchParams.set("connectTimeout", String(HISTORY_SYNC_MYSQL_CONNECT_TIMEOUT_MS));
  if (validated.tlsEnabled) {
    url.searchParams.set("ssl", "{}");
  }
  return url.toString();
}

export function toConnectionSummary(input: HistorySyncMysqlFields) {
  const validated = validateMysqlFields(input);
  return {
    host: validated.host,
    port: validated.port,
    database: validated.database,
    username: validated.username,
    tlsEnabled: validated.tlsEnabled,
  };
}

export const withHistorySyncMysqlPool = <A>(
  connectionString: string,
  use: (pool: Pool) => Promise<A>,
) =>
  Effect.tryPromise({
    try: async () => {
      const mysql = await import("mysql2/promise");
      const pool = mysql.createPool(connectionString);
      try {
        return await use(pool);
      } finally {
        await pool.end();
      }
    },
    catch: (cause) => new HistorySyncMysqlError({ cause }),
  });

function readPayload(row: HistorySyncEventRow): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(row.payloadJson);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readString(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function eventProjectId(
  event: HistorySyncEventRow,
  payload: Record<string, unknown> | null,
): string {
  return readString(payload, "projectId") ?? event.streamId;
}

function eventThreadId(
  event: HistorySyncEventRow,
  payload: Record<string, unknown> | null,
): string {
  return readString(payload, "threadId") ?? event.streamId;
}

export const ensureRemoteSchema = async (pool: Pool) => {
  for (const statement of MYSQL_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
};

export const testConnectionString = (connectionString: string) =>
  withHistorySyncMysqlPool(connectionString, async (pool) => {
    console.info("[history-sync:mysql] ensuring remote schema for connection test");
    await ensureRemoteSchema(pool);
    await pool.query("SELECT 1");
  });

export const readRemoteEvents = (connectionString: string, sequenceExclusive = 0) =>
  withHistorySyncMysqlPool(connectionString, async (pool) => {
    console.info("[history-sync:mysql] ensuring remote schema before reading events", {
      sequenceExclusive,
    });
    await ensureRemoteSchema(pool);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
                  occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
                  JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$')) AS payload_json,
                  JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$')) AS metadata_json
           FROM orchestration_events
           WHERE sequence > ?
           ORDER BY sequence ASC`,
      [sequenceExclusive],
    );
    console.info("[history-sync:mysql] remote events read", {
      sequenceExclusive,
      rows: rows.length,
    });
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      eventId: String(row.event_id),
      aggregateKind: row.aggregate_kind as "project" | "thread",
      streamId: String(row.stream_id),
      streamVersion: Number(row.stream_version),
      eventType: row.event_type as OrchestrationEvent["type"],
      occurredAt: String(row.occurred_at),
      commandId: row.command_id === null ? null : String(row.command_id),
      causationEventId: row.causation_event_id === null ? null : String(row.causation_event_id),
      correlationId: row.correlation_id === null ? null : String(row.correlation_id),
      actorKind: String(row.actor_kind),
      payloadJson:
        typeof row.payload_json === "string" ? row.payload_json : JSON.stringify(row.payload_json),
      metadataJson:
        typeof row.metadata_json === "string"
          ? row.metadata_json
          : JSON.stringify(row.metadata_json),
    })) satisfies HistorySyncEventRow[];
  });

export const readRemoteLatestThreadShells = (
  connectionString: string,
  input: {
    readonly limit: number;
    readonly offset?: number;
  },
) =>
  withHistorySyncMysqlPool(connectionString, async (pool) => {
    await ensureRemoteSchema(pool);
    const canUseIndexes = await ensureRemoteIndexesBackfilled(pool);
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    if (!canUseIndexes) {
      const events = await readAllRemoteEventsFromPool(pool);
      return buildRemoteThreadShellsFromEvents(events).slice(offset, offset + limit);
    }
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT thread_id, project_id, title, created_at, updated_at, latest_event_sequence,
              deleted_at, archived_at
         FROM history_sync_threads
        WHERE deleted_at IS NULL
        ORDER BY updated_at DESC, latest_event_sequence DESC
        LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows.map(
      (row): HistorySyncRemoteThreadShellRow => ({
        threadId: String(row.thread_id),
        projectId: row.project_id === null ? null : String(row.project_id),
        title: String(row.title),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        latestEventSequence: Number(row.latest_event_sequence),
        deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
        archivedAt: row.archived_at === null ? null : String(row.archived_at),
      }),
    );
  });

export const readRemoteProjectMappingCandidates = (connectionString: string) =>
  withHistorySyncMysqlPool(connectionString, async (pool) => {
    await ensureRemoteSchema(pool);
    const canUseIndexes = await ensureRemoteIndexesBackfilled(pool);
    if (!canUseIndexes) {
      return collectProjectCandidates(await readAllRemoteEventsFromPool(pool));
    }
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT
          project.project_id,
          project.title,
          project.workspace_root,
          project.deleted_at,
          COUNT(thread.thread_id) AS thread_count
         FROM history_sync_projects AS project
         LEFT JOIN history_sync_threads AS thread
           ON thread.project_id = project.project_id
          AND thread.deleted_at IS NULL
        GROUP BY
          project.project_id,
          project.title,
          project.workspace_root,
          project.deleted_at
        ORDER BY project.project_id ASC`,
    );
    return rows.map(
      (row): ProjectCandidate => ({
        projectId: String(row.project_id),
        title: String(row.title),
        workspaceRoot: String(row.workspace_root),
        deleted: row.deleted_at !== null,
        threadCount: Number(row.thread_count),
      }),
    );
  });

export const readRemoteEventsForThreadIds = (
  connectionString: string,
  threadIds: readonly string[],
) =>
  withHistorySyncMysqlPool(connectionString, async (pool) => {
    await ensureRemoteSchema(pool);
    const canUseIndexes = await ensureRemoteIndexesBackfilled(pool);
    const uniqueThreadIds = [...new Set(threadIds)].filter((threadId) => threadId.length > 0);
    if (uniqueThreadIds.length === 0) return [] satisfies HistorySyncEventRow[];
    if (!canUseIndexes) {
      const threadIdSet = new Set(uniqueThreadIds);
      return (await readAllRemoteEventsFromPool(pool)).filter(
        (event) =>
          event.aggregateKind === "thread" &&
          threadIdSet.has(eventThreadId(event, readPayload(event))),
      );
    }
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
              occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
              JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$')) AS payload_json,
              JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$')) AS metadata_json
         FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id IN (?)`,
      [uniqueThreadIds],
    );
    return rows
      .map((row) => ({
        sequence: Number(row.sequence),
        eventId: String(row.event_id),
        aggregateKind: row.aggregate_kind as "project" | "thread",
        streamId: String(row.stream_id),
        streamVersion: Number(row.stream_version),
        eventType: row.event_type as OrchestrationEvent["type"],
        occurredAt: String(row.occurred_at),
        commandId: row.command_id === null ? null : String(row.command_id),
        causationEventId: row.causation_event_id === null ? null : String(row.causation_event_id),
        correlationId: row.correlation_id === null ? null : String(row.correlation_id),
        actorKind: String(row.actor_kind),
        payloadJson:
          typeof row.payload_json === "string"
            ? row.payload_json
            : JSON.stringify(row.payload_json),
        metadataJson:
          typeof row.metadata_json === "string"
            ? row.metadata_json
            : JSON.stringify(row.metadata_json),
      }))
      .toSorted((left, right) => left.sequence - right.sequence) satisfies HistorySyncEventRow[];
  });

export const readRemoteProjectEventsForProjectIds = (
  connectionString: string,
  projectIds: readonly string[],
) =>
  withHistorySyncMysqlPool(connectionString, async (pool) => {
    await ensureRemoteSchema(pool);
    const uniqueProjectIds = [...new Set(projectIds)].filter((projectId) => projectId.length > 0);
    if (uniqueProjectIds.length === 0) return [] satisfies HistorySyncEventRow[];
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
              occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
              JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$')) AS payload_json,
              JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$')) AS metadata_json
         FROM orchestration_events
        WHERE aggregate_kind = 'project'
          AND stream_id IN (?)
        ORDER BY sequence ASC`,
      [uniqueProjectIds],
    );
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      eventId: String(row.event_id),
      aggregateKind: row.aggregate_kind as "project" | "thread",
      streamId: String(row.stream_id),
      streamVersion: Number(row.stream_version),
      eventType: row.event_type as OrchestrationEvent["type"],
      occurredAt: String(row.occurred_at),
      commandId: row.command_id === null ? null : String(row.command_id),
      causationEventId: row.causation_event_id === null ? null : String(row.causation_event_id),
      correlationId: row.correlation_id === null ? null : String(row.correlation_id),
      actorKind: String(row.actor_kind),
      payloadJson:
        typeof row.payload_json === "string" ? row.payload_json : JSON.stringify(row.payload_json),
      metadataJson:
        typeof row.metadata_json === "string"
          ? row.metadata_json
          : JSON.stringify(row.metadata_json),
    })) satisfies HistorySyncEventRow[];
  });

async function upsertRemoteIndexes(pool: Pool, events: readonly HistorySyncEventRow[]) {
  const projects = new Map<
    string,
    {
      title: string;
      workspaceRoot: string;
      deletedAt: string | null;
      firstSequence: number;
      latestSequence: number;
      updatedAt: string;
    }
  >();
  const threads = new Map<
    string,
    {
      projectId: string | null;
      title: string;
      createdAt: string;
      updatedAt: string;
      latestEventSequence: number;
      deletedAt: string | null;
      archivedAt: string | null;
    }
  >();
  const threadEvents: Array<[string, number]> = [];

  for (const event of events.toSorted((left, right) => left.sequence - right.sequence)) {
    const payload = readPayload(event);
    if (event.aggregateKind === "project") {
      const projectId = eventProjectId(event, payload);
      const existing = projects.get(projectId);
      projects.set(projectId, {
        title: readString(payload, "title") ?? existing?.title ?? projectId,
        workspaceRoot: readString(payload, "workspaceRoot") ?? existing?.workspaceRoot ?? "",
        deletedAt:
          event.eventType === "project.deleted" ? event.occurredAt : (existing?.deletedAt ?? null),
        firstSequence: Math.min(existing?.firstSequence ?? event.sequence, event.sequence),
        latestSequence: Math.max(existing?.latestSequence ?? event.sequence, event.sequence),
        updatedAt: event.occurredAt,
      });
    }

    if (event.aggregateKind !== "thread") continue;
    const threadId = eventThreadId(event, payload);
    threadEvents.push([threadId, event.sequence]);
    const existing = threads.get(threadId);
    threads.set(threadId, {
      projectId: readString(payload, "projectId") ?? existing?.projectId ?? null,
      title: readString(payload, "title") ?? existing?.title ?? threadId,
      createdAt: readString(payload, "createdAt") ?? existing?.createdAt ?? event.occurredAt,
      updatedAt: readString(payload, "updatedAt") ?? event.occurredAt,
      latestEventSequence: Math.max(
        existing?.latestEventSequence ?? event.sequence,
        event.sequence,
      ),
      deletedAt:
        event.eventType === "thread.deleted" ? event.occurredAt : (existing?.deletedAt ?? null),
      archivedAt:
        event.eventType === "thread.archived"
          ? event.occurredAt
          : event.eventType === "thread.unarchived"
            ? null
            : (existing?.archivedAt ?? null),
    });
  }

  if (projects.size > 0) {
    await pool.query(
      `INSERT INTO history_sync_projects
         (project_id, title, workspace_root, deleted_at, first_sequence, latest_sequence, updated_at)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         workspace_root = VALUES(workspace_root),
         deleted_at = VALUES(deleted_at),
         first_sequence = LEAST(first_sequence, VALUES(first_sequence)),
         latest_sequence = GREATEST(latest_sequence, VALUES(latest_sequence)),
         updated_at = VALUES(updated_at)`,
      [
        [...projects.entries()].map(([projectId, project]) => [
          projectId,
          project.title,
          project.workspaceRoot,
          project.deletedAt,
          project.firstSequence,
          project.latestSequence,
          project.updatedAt,
        ]),
      ],
    );
  }

  if (threads.size > 0) {
    await pool.query(
      `INSERT INTO history_sync_threads
         (thread_id, project_id, title, created_at, updated_at, latest_event_sequence,
          deleted_at, archived_at)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         project_id = COALESCE(VALUES(project_id), project_id),
         title = VALUES(title),
         created_at = LEAST(created_at, VALUES(created_at)),
         updated_at = VALUES(updated_at),
         latest_event_sequence = GREATEST(latest_event_sequence, VALUES(latest_event_sequence)),
         deleted_at = VALUES(deleted_at),
         archived_at = VALUES(archived_at)`,
      [
        [...threads.entries()].map(([threadId, thread]) => [
          threadId,
          thread.projectId,
          thread.title,
          thread.createdAt,
          thread.updatedAt,
          thread.latestEventSequence,
          thread.deletedAt,
          thread.archivedAt,
        ]),
      ],
    );
  }

  if (threadEvents.length > 0) {
    await pool.query(
      `INSERT IGNORE INTO history_sync_thread_events (thread_id, sequence) VALUES ?`,
      [threadEvents],
    );
  }
}

async function tryUpsertRemoteIndexes(
  pool: Pool,
  events: readonly HistorySyncEventRow[],
  context: Record<string, unknown>,
): Promise<boolean> {
  try {
    await upsertRemoteIndexes(pool, events);
    return true;
  } catch (error) {
    if (!isHistorySyncMysqlAccessDenied(error)) {
      throw error;
    }
    console.warn("[history-sync:mysql] remote index maintenance skipped: missing privileges", {
      ...context,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function buildRemoteThreadShellsFromEvents(
  events: readonly HistorySyncEventRow[],
): readonly HistorySyncRemoteThreadShellRow[] {
  const threads = new Map<string, HistorySyncRemoteThreadShellRow>();

  for (const event of events.toSorted((left, right) => left.sequence - right.sequence)) {
    if (event.aggregateKind !== "thread") continue;
    const payload = readPayload(event);
    const threadId = eventThreadId(event, payload);
    const existing = threads.get(threadId);
    const deletedAt =
      event.eventType === "thread.deleted" ? event.occurredAt : (existing?.deletedAt ?? null);
    threads.set(threadId, {
      threadId,
      projectId: readString(payload, "projectId") ?? existing?.projectId ?? null,
      title: readString(payload, "title") ?? existing?.title ?? threadId,
      createdAt: readString(payload, "createdAt") ?? existing?.createdAt ?? event.occurredAt,
      updatedAt: readString(payload, "updatedAt") ?? event.occurredAt,
      latestEventSequence: Math.max(
        existing?.latestEventSequence ?? event.sequence,
        event.sequence,
      ),
      deletedAt,
      archivedAt:
        event.eventType === "thread.archived"
          ? event.occurredAt
          : event.eventType === "thread.unarchived"
            ? null
            : (existing?.archivedAt ?? null),
    });
  }

  return [...threads.values()]
    .filter((thread) => thread.deletedAt === null)
    .toSorted((left, right) => {
      const updatedAtOrder = right.updatedAt.localeCompare(left.updatedAt);
      return updatedAtOrder !== 0
        ? updatedAtOrder
        : right.latestEventSequence - left.latestEventSequence;
    });
}

async function readAllRemoteEventsFromPool(pool: Pool): Promise<HistorySyncEventRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
            JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$')) AS payload_json,
            JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$')) AS metadata_json
       FROM orchestration_events
      ORDER BY sequence ASC`,
  );
  return rows.map((row) => ({
    sequence: Number(row.sequence),
    eventId: String(row.event_id),
    aggregateKind: row.aggregate_kind as "project" | "thread",
    streamId: String(row.stream_id),
    streamVersion: Number(row.stream_version),
    eventType: row.event_type as OrchestrationEvent["type"],
    occurredAt: String(row.occurred_at),
    commandId: row.command_id === null ? null : String(row.command_id),
    causationEventId: row.causation_event_id === null ? null : String(row.causation_event_id),
    correlationId: row.correlation_id === null ? null : String(row.correlation_id),
    actorKind: String(row.actor_kind),
    payloadJson:
      typeof row.payload_json === "string" ? row.payload_json : JSON.stringify(row.payload_json),
    metadataJson:
      typeof row.metadata_json === "string" ? row.metadata_json : JSON.stringify(row.metadata_json),
  }));
}

async function ensureRemoteIndexesBackfilled(pool: Pool): Promise<boolean> {
  const [counts] = await pool.query<RowDataPacket[]>(
    `SELECT
       (SELECT COUNT(*) FROM orchestration_events) AS event_count,
       (SELECT COUNT(*) FROM history_sync_threads) AS thread_count,
       (SELECT COUNT(*) FROM orchestration_events WHERE aggregate_kind = 'thread')
         AS canonical_thread_event_count,
       (SELECT COUNT(*) FROM history_sync_thread_events) AS indexed_thread_event_count`,
  );
  const eventCount = Number(counts[0]?.event_count ?? 0);
  const threadCount = Number(counts[0]?.thread_count ?? 0);
  const canonicalThreadEventCount = Number(counts[0]?.canonical_thread_event_count ?? 0);
  const indexedThreadEventCount = Number(counts[0]?.indexed_thread_event_count ?? 0);
  if (
    eventCount === 0 ||
    (threadCount > 0 && indexedThreadEventCount >= canonicalThreadEventCount)
  ) {
    return true;
  }
  const events = await readAllRemoteEventsFromPool(pool);
  for (const batch of chunkHistorySyncEvents(events, HISTORY_SYNC_MYSQL_BATCH_SIZE)) {
    const updated = await tryUpsertRemoteIndexes(pool, batch, {
      operation: "backfill",
      events: batch.length,
    });
    if (!updated) return false;
  }
  return true;
}

export const readRemoteMaxSequence = (connectionString: string) =>
  withHistorySyncMysqlPool(connectionString, async (pool) => {
    console.info("[history-sync:mysql] ensuring remote schema before reading max sequence");
    await ensureRemoteSchema(pool);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM orchestration_events`,
    );
    const maxSequence = Number(rows[0]?.max_sequence ?? 0);
    console.info("[history-sync:mysql] remote max sequence read", { maxSequence });
    return maxSequence;
  });

function insertRemoteEventBatch(
  pool: Pool,
  events: readonly HistorySyncEventRow[],
  batchIndex: number,
  batchCount: number,
) {
  if (events.length === 0) return Promise.resolve();
  const firstSequence = events[0]?.sequence ?? null;
  const lastSequence = events.at(-1)?.sequence ?? null;
  console.info("[history-sync] pushing remote batch", {
    batchIndex,
    batchCount,
    events: events.length,
    firstSequence,
    lastSequence,
  });
  const values = events.map((event) => [
    event.sequence,
    event.eventId,
    event.aggregateKind,
    event.streamId,
    event.streamVersion,
    event.eventType,
    event.occurredAt,
    event.commandId,
    event.causationEventId,
    event.correlationId,
    event.actorKind,
    event.payloadJson,
    event.metadataJson,
  ]);
  return pool.query(
    `INSERT IGNORE INTO orchestration_events
       (sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
        payload_json, metadata_json)
     VALUES ?`,
    [values],
  );
}

export const pushRemoteEventsBatched = (
  connectionString: string,
  events: readonly HistorySyncEventRow[],
) =>
  withHistorySyncMysqlPool(connectionString, async (pool) => {
    console.info("[history-sync:mysql] ensuring remote schema before pushing events", {
      events: events.length,
    });
    await ensureRemoteSchema(pool);
    if (events.length === 0) return;
    const batches = chunkHistorySyncEvents(events, HISTORY_SYNC_MYSQL_BATCH_SIZE);
    const firstSequence = events[0]?.sequence ?? null;
    const lastSequence = events.at(-1)?.sequence ?? null;
    console.info("[history-sync] pushing remote history", {
      events: events.length,
      batches: batches.length,
      firstSequence,
      lastSequence,
    });
    for (let index = 0; index < batches.length; index++) {
      const batch = batches[index] ?? [];
      await insertRemoteEventBatch(pool, batch, index + 1, batches.length);
      await tryUpsertRemoteIndexes(pool, batch, {
        operation: "push",
        batchIndex: index + 1,
        batchCount: batches.length,
        events: batch.length,
      });
    }
  });
