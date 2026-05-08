import * as Crypto from "node:crypto";

import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  buildPushedEventReceiptRows,
  chunkHistorySyncEvents,
  selectPushedReceiptSeedEvents,
  type HistorySyncAutosyncProjectionThreadRow,
  type HistorySyncEventRow,
} from "./planner.ts";
import { HISTORY_SYNC_LOCAL_HISTORY_TABLES } from "./tableManifest.ts";

const HISTORY_SYNC_SQLITE_BATCH_SIZE = 50;
export const CLEAR_LOCAL_HISTORY_TABLES = HISTORY_SYNC_LOCAL_HISTORY_TABLES;

export type HistorySyncInitialSyncPhase =
  | "backup"
  | "push-local"
  | "push-merge"
  | "import-remote"
  | "write-state";

export interface HistorySyncStateRow {
  readonly hasCompletedInitialSync: number;
  readonly lastSyncedRemoteSequence: number;
  readonly lastSuccessfulSyncAt: string | null;
  readonly clientId?: string | null;
  readonly initialSyncPhase?: HistorySyncInitialSyncPhase | null;
  readonly initialSyncStartedAt?: string | null;
  readonly initialSyncError?: string | null;
}

export interface HistorySyncLocalProjectionCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface WriteHistorySyncStateInput {
  readonly hasCompletedInitialSync: boolean;
  readonly lastSyncedRemoteSequence: number;
  readonly lastSuccessfulSyncAt: string;
}

export function readLocalEvents(sql: SqlClient.SqlClient, sequenceExclusive = 0) {
  return sql<HistorySyncEventRow>`
    SELECT
      sequence,
      event_id AS "eventId",
      aggregate_kind AS "aggregateKind",
      stream_id AS "streamId",
      stream_version AS "streamVersion",
      event_type AS "eventType",
      occurred_at AS "occurredAt",
      command_id AS "commandId",
      causation_event_id AS "causationEventId",
      correlation_id AS "correlationId",
      actor_kind AS "actorKind",
      payload_json AS "payloadJson",
      metadata_json AS "metadataJson"
    FROM orchestration_events
    WHERE sequence > ${sequenceExclusive}
    ORDER BY sequence ASC
  `;
}

export function readUnpushedLocalEvents(sql: SqlClient.SqlClient) {
  return sql<HistorySyncEventRow>`
    SELECT
      event.sequence,
      event.event_id AS "eventId",
      event.aggregate_kind AS "aggregateKind",
      event.stream_id AS "streamId",
      event.stream_version AS "streamVersion",
      event.event_type AS "eventType",
      event.occurred_at AS "occurredAt",
      event.command_id AS "commandId",
      event.causation_event_id AS "causationEventId",
      event.correlation_id AS "correlationId",
      event.actor_kind AS "actorKind",
      event.payload_json AS "payloadJson",
      event.metadata_json AS "metadataJson"
    FROM orchestration_events AS event
    LEFT JOIN history_sync_pushed_events AS receipt
      ON receipt.sequence = event.sequence
    WHERE receipt.sequence IS NULL
    ORDER BY event.sequence ASC
  `;
}

export function readProjectionThreadAutosyncRows(sql: SqlClient.SqlClient) {
  return sql<HistorySyncAutosyncProjectionThreadRow>`
    SELECT
      thread.thread_id AS "threadId",
      thread.pending_user_input_count AS "pendingUserInputCount",
      thread.has_actionable_proposed_plan AS "hasActionableProposedPlan",
      thread.latest_turn_id AS "latestTurnId",
      session.status AS "sessionStatus",
      session.active_turn_id AS "sessionActiveTurnId"
    FROM projection_threads AS thread
    LEFT JOIN projection_thread_sessions AS session
      ON session.thread_id = thread.thread_id
    WHERE thread.deleted_at IS NULL
  `;
}

export function writePushedEventReceipts(
  sql: SqlClient.SqlClient,
  events: readonly HistorySyncEventRow[],
  pushedAt: string,
) {
  return Effect.gen(function* () {
    if (events.length === 0) return;
    const batches = chunkHistorySyncEvents(events, HISTORY_SYNC_SQLITE_BATCH_SIZE);
    yield* Effect.forEach(
      batches,
      (batch) =>
        sql`
          INSERT INTO history_sync_pushed_events ${sql.insert(
            buildPushedEventReceiptRows(batch, pushedAt).map((receipt) => ({
              sequence: receipt.sequence,
              event_id: receipt.eventId,
              stream_id: receipt.streamId,
              event_type: receipt.eventType,
              pushed_at: receipt.pushedAt,
            })),
          )}
          ON CONFLICT (sequence) DO UPDATE SET
            event_id = excluded.event_id,
            stream_id = excluded.stream_id,
            event_type = excluded.event_type,
            pushed_at = excluded.pushed_at
        `,
      { concurrency: 1 },
    );
  });
}

export function readPushedEventReceiptCount(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM history_sync_pushed_events
    `;
    return Number(rows[0]?.count ?? 0);
  });
}

export function seedPushedEventReceiptsForCompletedSync(
  sql: SqlClient.SqlClient,
  events: readonly HistorySyncEventRow[],
  input: {
    readonly hasCompletedInitialSync: boolean;
    readonly lastSyncedRemoteSequence: number;
    readonly seededAt: string;
  },
) {
  return Effect.gen(function* () {
    if (!input.hasCompletedInitialSync || input.lastSyncedRemoteSequence <= 0) return;
    const receiptCount = yield* readPushedEventReceiptCount(sql);
    const alreadySyncedEvents = selectPushedReceiptSeedEvents({
      events,
      hasCompletedInitialSync: input.hasCompletedInitialSync,
      hasExistingReceipts: receiptCount > 0,
      lastSyncedRemoteSequence: input.lastSyncedRemoteSequence,
    });
    if (alreadySyncedEvents.length === 0) return;
    console.info("[history-sync] seeding local pushed event receipts", {
      events: alreadySyncedEvents.length,
      lastSyncedRemoteSequence: input.lastSyncedRemoteSequence,
    });
    yield* writePushedEventReceipts(sql, alreadySyncedEvents, input.seededAt);
  });
}

export function readLocalProjectionCounts(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    const rows = yield* sql<{
      readonly projectCount: number;
      readonly threadCount: number;
    }>`
      SELECT
        (SELECT COUNT(*) FROM projection_projects WHERE deleted_at IS NULL) AS "projectCount",
        (SELECT COUNT(*) FROM projection_threads WHERE deleted_at IS NULL) AS "threadCount"
    `;
    return {
      projectCount: Number(rows[0]?.projectCount ?? 0),
      threadCount: Number(rows[0]?.threadCount ?? 0),
    } satisfies HistorySyncLocalProjectionCounts;
  });
}

export function readState(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    const rows = yield* sql<HistorySyncStateRow>`
      SELECT
        has_completed_initial_sync AS "hasCompletedInitialSync",
        last_synced_remote_sequence AS "lastSyncedRemoteSequence",
        last_successful_sync_at AS "lastSuccessfulSyncAt",
        client_id AS "clientId",
        initial_sync_phase AS "initialSyncPhase",
        initial_sync_started_at AS "initialSyncStartedAt",
        initial_sync_error AS "initialSyncError"
      FROM history_sync_state
      WHERE id = 1
      LIMIT 1
    `;
    return rows[0] ?? null;
  });
}

export function ensureClientId(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    const state = yield* readState(sql);
    if (state?.clientId && state.clientId.length > 0) {
      return state.clientId;
    }
    const clientId = Crypto.randomUUID();
    yield* sql`
      INSERT INTO history_sync_state (
        id,
        client_id,
        has_completed_initial_sync,
        last_synced_remote_sequence,
        last_successful_sync_at,
        initial_sync_phase,
        initial_sync_started_at,
        initial_sync_error
      )
      VALUES (
        1,
        ${clientId},
        ${state?.hasCompletedInitialSync ?? 0},
        ${state?.lastSyncedRemoteSequence ?? 0},
        ${state?.lastSuccessfulSyncAt ?? null},
        ${state?.initialSyncPhase ?? null},
        ${state?.initialSyncStartedAt ?? null},
        ${state?.initialSyncError ?? null}
      )
      ON CONFLICT (id) DO UPDATE SET
        client_id = excluded.client_id
    `;
    return clientId;
  });
}

export function writeState(sql: SqlClient.SqlClient, input: WriteHistorySyncStateInput) {
  return Effect.gen(function* () {
    const clientId = yield* ensureClientId(sql);
    yield* sql`
      INSERT INTO history_sync_state (
        id,
        client_id,
        has_completed_initial_sync,
        last_synced_remote_sequence,
        last_successful_sync_at,
        initial_sync_phase,
        initial_sync_started_at,
        initial_sync_error
      )
      VALUES (
        1,
        ${clientId},
        ${input.hasCompletedInitialSync ? 1 : 0},
        ${input.lastSyncedRemoteSequence},
        ${input.lastSuccessfulSyncAt},
        NULL,
        NULL,
        NULL
      )
      ON CONFLICT (id) DO UPDATE SET
        client_id = history_sync_state.client_id,
        has_completed_initial_sync = excluded.has_completed_initial_sync,
        last_synced_remote_sequence = excluded.last_synced_remote_sequence,
        last_successful_sync_at = excluded.last_successful_sync_at
    `;
  });
}

export function commitHistorySyncState(
  sql: SqlClient.SqlClient,
  input: WriteHistorySyncStateInput,
) {
  return writeState(sql, input);
}

export function commitPushedEventReceiptsAndState(
  sql: SqlClient.SqlClient,
  input: {
    readonly events: readonly HistorySyncEventRow[];
    readonly pushedAt: string;
    readonly state: WriteHistorySyncStateInput;
  },
) {
  return sql.withTransaction(
    Effect.gen(function* () {
      yield* writePushedEventReceipts(sql, input.events, input.pushedAt);
      yield* writeState(sql, input.state);
    }),
  );
}

export function setInitialSyncPhase(
  sql: SqlClient.SqlClient,
  input: {
    readonly phase: HistorySyncInitialSyncPhase;
    readonly startedAt: string;
  },
) {
  return Effect.gen(function* () {
    const clientId = yield* ensureClientId(sql);
    yield* sql`
      INSERT INTO history_sync_state (
        id,
        client_id,
        has_completed_initial_sync,
        last_synced_remote_sequence,
        last_successful_sync_at,
        initial_sync_phase,
        initial_sync_started_at,
        initial_sync_error
      )
      VALUES (
        1,
        ${clientId},
        0,
        0,
        NULL,
        ${input.phase},
        ${input.startedAt},
        NULL
      )
      ON CONFLICT (id) DO UPDATE SET
        client_id = history_sync_state.client_id,
        initial_sync_phase = excluded.initial_sync_phase,
        initial_sync_started_at = COALESCE(history_sync_state.initial_sync_started_at, excluded.initial_sync_started_at),
        initial_sync_error = NULL
    `;
  });
}

export function clearInitialSyncPhase(sql: SqlClient.SqlClient) {
  return sql`
    UPDATE history_sync_state
    SET
      initial_sync_phase = NULL,
      initial_sync_started_at = NULL,
      initial_sync_error = NULL
    WHERE id = 1
  `;
}

export function failInitialSyncPhase(
  sql: SqlClient.SqlClient,
  input: {
    readonly error: string;
    readonly failedAt: string;
  },
) {
  return Effect.gen(function* () {
    const state = yield* readState(sql);
    if (state?.initialSyncPhase === null || state?.initialSyncPhase === undefined) {
      return;
    }
    yield* sql`
      UPDATE history_sync_state
      SET
        initial_sync_error = ${`${input.failedAt}: ${input.error}`}
      WHERE id = 1
    `;
  });
}

export function insertLocalEvents(
  sql: SqlClient.SqlClient,
  events: readonly HistorySyncEventRow[],
) {
  return Effect.gen(function* () {
    if (events.length === 0) return;
    const batches = chunkHistorySyncEvents(events, HISTORY_SYNC_SQLITE_BATCH_SIZE);
    yield* Effect.forEach(
      batches,
      (batch) => {
        return sql`
          INSERT INTO orchestration_events ${sql.insert(
            batch.map((event) => ({
              sequence: event.sequence,
              event_id: event.eventId,
              aggregate_kind: event.aggregateKind,
              stream_id: event.streamId,
              stream_version: event.streamVersion,
              event_type: event.eventType,
              occurred_at: event.occurredAt,
              command_id: event.commandId,
              causation_event_id: event.causationEventId,
              correlation_id: event.correlationId,
              actor_kind: event.actorKind,
              payload_json: event.payloadJson,
              metadata_json: event.metadataJson,
            })),
          )}
        `;
      },
      { concurrency: 1 },
    );
  });
}

export function clearLocalHistory(sql: SqlClient.SqlClient) {
  return Effect.all(
    CLEAR_LOCAL_HISTORY_TABLES.map((tableName) => sql`DELETE FROM ${sql(tableName)}`),
    { concurrency: 1 },
  );
}

export function importRemoteEvents(
  sql: SqlClient.SqlClient,
  events: readonly HistorySyncEventRow[],
) {
  return sql.withTransaction(
    clearLocalHistory(sql).pipe(
      Effect.andThen(insertLocalEvents(sql, events)),
      Effect.andThen(sql`DELETE FROM projection_state`),
    ),
  );
}

export function importRemoteDeltaEvents(
  sql: SqlClient.SqlClient,
  events: readonly HistorySyncEventRow[],
) {
  return sql.withTransaction(insertLocalEvents(sql, events));
}
