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

export interface HistorySyncLocalEventRef {
  readonly sequence: number;
  readonly eventId: string;
}

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
  readonly remoteAppliedSequence?: number | null;
  readonly remoteKnownMaxSequence?: number | null;
  readonly latestBootstrapCompletedAt?: string | null;
  readonly backfillCursorUpdatedAt?: string | null;
  readonly liveAppendEnabled?: number | null;
}

export interface HistorySyncLocalProjectionCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface HistorySyncThreadStateRow {
  readonly threadId: string;
  readonly remoteProjectId: string | null;
  readonly localProjectId: string | null;
  readonly latestRemoteSequence: number;
  readonly importedThroughSequence: number;
  readonly isShellLoaded: number;
  readonly isFullLoaded: number;
  readonly priority: number;
  readonly lastRequestedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertHistorySyncThreadStateInput {
  readonly threadId: string;
  readonly remoteProjectId?: string | null;
  readonly localProjectId?: string | null;
  readonly latestRemoteSequence: number;
  readonly importedThroughSequence?: number;
  readonly isShellLoaded?: boolean;
  readonly isFullLoaded?: boolean;
  readonly priority?: number;
  readonly lastRequestedAt?: string | null;
  readonly now: string;
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

export function readLocalEventRefsForSequences(
  sql: SqlClient.SqlClient,
  sequences: readonly number[],
) {
  return Effect.gen(function* () {
    const uniqueSequences = [...new Set(sequences)]
      .filter((sequence) => Number.isInteger(sequence) && sequence > 0)
      .toSorted((left, right) => left - right);
    if (uniqueSequences.length === 0) {
      return [] satisfies HistorySyncLocalEventRef[];
    }

    const batches: number[][] = [];
    for (let index = 0; index < uniqueSequences.length; index += HISTORY_SYNC_SQLITE_BATCH_SIZE) {
      batches.push(uniqueSequences.slice(index, index + HISTORY_SYNC_SQLITE_BATCH_SIZE));
    }
    const rows = yield* Effect.forEach(
      batches,
      (batch) =>
        sql<HistorySyncLocalEventRef>`
          SELECT
            sequence,
            event_id AS "eventId"
          FROM orchestration_events
          WHERE sequence IN ${sql.in(batch)}
          ORDER BY sequence ASC
        `,
      { concurrency: 1 },
    );
    return rows.flat();
  });
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
      initial_sync_error AS "initialSyncError",
      remote_applied_sequence AS "remoteAppliedSequence",
      remote_known_max_sequence AS "remoteKnownMaxSequence",
      latest_bootstrap_completed_at AS "latestBootstrapCompletedAt",
      backfill_cursor_updated_at AS "backfillCursorUpdatedAt",
      live_append_enabled AS "liveAppendEnabled"
      FROM history_sync_state
      WHERE id = 1
      LIMIT 1
    `;
    return rows[0] ?? null;
  });
}

export function upsertHistorySyncThreadStates(
  sql: SqlClient.SqlClient,
  inputs: readonly UpsertHistorySyncThreadStateInput[],
) {
  return Effect.gen(function* () {
    if (inputs.length === 0) return;
    yield* sql`
      INSERT INTO history_sync_thread_state ${sql.insert(
        inputs.map((input) => ({
          thread_id: input.threadId,
          remote_project_id: input.remoteProjectId ?? null,
          local_project_id: input.localProjectId ?? null,
          latest_remote_sequence: input.latestRemoteSequence,
          imported_through_sequence: input.importedThroughSequence ?? 0,
          is_shell_loaded: input.isShellLoaded === true ? 1 : 0,
          is_full_loaded: input.isFullLoaded === true ? 1 : 0,
          priority: input.priority ?? 0,
          last_requested_at: input.lastRequestedAt ?? null,
          created_at: input.now,
          updated_at: input.now,
        })),
      )}
      ON CONFLICT (thread_id) DO UPDATE SET
        remote_project_id = COALESCE(excluded.remote_project_id, history_sync_thread_state.remote_project_id),
        local_project_id = COALESCE(excluded.local_project_id, history_sync_thread_state.local_project_id),
        latest_remote_sequence = MAX(history_sync_thread_state.latest_remote_sequence, excluded.latest_remote_sequence),
        imported_through_sequence = MAX(history_sync_thread_state.imported_through_sequence, excluded.imported_through_sequence),
        is_shell_loaded = MAX(history_sync_thread_state.is_shell_loaded, excluded.is_shell_loaded),
        is_full_loaded = MAX(history_sync_thread_state.is_full_loaded, excluded.is_full_loaded),
        priority = MAX(history_sync_thread_state.priority, excluded.priority),
        last_requested_at = COALESCE(excluded.last_requested_at, history_sync_thread_state.last_requested_at),
        updated_at = excluded.updated_at
    `;
  });
}

export function markHistorySyncThreadPriority(
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: string;
    readonly priority: number;
    readonly requestedAt: string;
  },
) {
  return sql`
    INSERT INTO history_sync_thread_state (
      thread_id,
      latest_remote_sequence,
      imported_through_sequence,
      is_shell_loaded,
      is_full_loaded,
      priority,
      last_requested_at,
      created_at,
      updated_at
    )
    VALUES (
      ${input.threadId},
      0,
      0,
      0,
      0,
      ${input.priority},
      ${input.requestedAt},
      ${input.requestedAt},
      ${input.requestedAt}
    )
    ON CONFLICT (thread_id) DO UPDATE SET
      priority = MAX(history_sync_thread_state.priority, excluded.priority),
      last_requested_at = excluded.last_requested_at,
      updated_at = excluded.updated_at
  `;
}

export function deferHistorySyncThreadPriority(
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: string;
    readonly requestedAt: string;
  },
) {
  return sql`
    UPDATE history_sync_thread_state
    SET
      priority = 0,
      last_requested_at = ${input.requestedAt},
      updated_at = ${input.requestedAt}
    WHERE thread_id = ${input.threadId}
  `;
}

export function recoverStaleHistorySyncThreadStates(sql: SqlClient.SqlClient, now: string) {
  return sql`
    UPDATE history_sync_thread_state
    SET
      priority = 0,
      updated_at = ${now}
    WHERE is_shell_loaded = 0
      AND is_full_loaded = 0
      AND latest_remote_sequence = 0
      AND imported_through_sequence = 0
      AND priority > 0
  `;
}

export function readHistorySyncThreadStateCounts(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    const rows = yield* sql<{
      readonly loadedThreadCount: number;
      readonly totalThreadCount: number;
    }>`
      SELECT
        COALESCE(SUM(CASE WHEN is_shell_loaded = 1 THEN 1 ELSE 0 END), 0) AS "loadedThreadCount",
        COUNT(*) AS "totalThreadCount"
      FROM history_sync_thread_state
    `;
    return {
      loadedThreadCount: Number(rows[0]?.loadedThreadCount ?? 0),
      totalThreadCount: Number(rows[0]?.totalThreadCount ?? 0),
    };
  });
}

export function readHistorySyncThreadState(sql: SqlClient.SqlClient, threadId: string) {
  return Effect.gen(function* () {
    const rows = yield* sql<HistorySyncThreadStateRow>`
      SELECT
        thread_id AS "threadId",
        remote_project_id AS "remoteProjectId",
        local_project_id AS "localProjectId",
        latest_remote_sequence AS "latestRemoteSequence",
        imported_through_sequence AS "importedThroughSequence",
        is_shell_loaded AS "isShellLoaded",
        is_full_loaded AS "isFullLoaded",
        priority,
        last_requested_at AS "lastRequestedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM history_sync_thread_state
      WHERE thread_id = ${threadId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  });
}

export function updateHistorySyncLatestFirstState(
  sql: SqlClient.SqlClient,
  input: {
    readonly remoteAppliedSequence: number;
    readonly remoteKnownMaxSequence: number;
    readonly liveAppendEnabled: boolean;
    readonly latestBootstrapCompletedAt?: string | null;
    readonly backfillCursorUpdatedAt?: string | null;
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
        remote_applied_sequence,
        remote_known_max_sequence,
        latest_bootstrap_completed_at,
        backfill_cursor_updated_at,
        live_append_enabled
      )
      VALUES (
        1,
        ${clientId},
        0,
        0,
        NULL,
        ${input.remoteAppliedSequence},
        ${input.remoteKnownMaxSequence},
        ${input.latestBootstrapCompletedAt ?? null},
        ${input.backfillCursorUpdatedAt ?? null},
        ${input.liveAppendEnabled ? 1 : 0}
      )
      ON CONFLICT (id) DO UPDATE SET
        remote_applied_sequence = MAX(history_sync_state.remote_applied_sequence, excluded.remote_applied_sequence),
        remote_known_max_sequence = MAX(history_sync_state.remote_known_max_sequence, excluded.remote_known_max_sequence),
        latest_bootstrap_completed_at = COALESCE(excluded.latest_bootstrap_completed_at, history_sync_state.latest_bootstrap_completed_at),
        backfill_cursor_updated_at = COALESCE(excluded.backfill_cursor_updated_at, history_sync_state.backfill_cursor_updated_at),
        live_append_enabled = excluded.live_append_enabled
    `;
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
  options: { readonly ignoreConflicts?: boolean } = {},
) {
  return Effect.gen(function* () {
    if (events.length === 0) return;
    const batches = chunkHistorySyncEvents(events, HISTORY_SYNC_SQLITE_BATCH_SIZE);
    yield* Effect.forEach(
      batches,
      (batch) => {
        const rows = batch.map((event) => ({
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
        }));
        return options.ignoreConflicts === true
          ? sql`INSERT OR IGNORE INTO orchestration_events ${sql.insert(rows)}`
          : sql`INSERT INTO orchestration_events ${sql.insert(rows)}`;
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
  return sql.withTransaction(insertLocalEvents(sql, events, { ignoreConflicts: true }));
}
