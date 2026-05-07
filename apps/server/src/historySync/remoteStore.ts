import { type HistorySyncMysqlFields, type OrchestrationEvent } from "@t3tools/contracts";
import { Data, Effect } from "effect";
import type { Pool, RowDataPacket } from "mysql2/promise";

import { chunkHistorySyncEvents, type HistorySyncEventRow } from "./planner.ts";

const HISTORY_SYNC_MYSQL_BATCH_SIZE = 500;
const HISTORY_SYNC_MYSQL_CONNECT_TIMEOUT_MS = 10_000;

const MYSQL_SCHEMA = `
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
)`;

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

export const ensureRemoteSchema = (pool: Pool) => pool.query(MYSQL_SCHEMA);

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
      await insertRemoteEventBatch(pool, batches[index] ?? [], index + 1, batches.length);
    }
  });
