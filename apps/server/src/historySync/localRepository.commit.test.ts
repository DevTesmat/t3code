import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import type { HistorySyncEventRow } from "./planner.ts";
import {
  commitHistorySyncState,
  commitPushedEventReceiptsAndState,
  ensureClientId,
  readPushedEventReceiptCount,
  readState,
  readUnpushedLocalEvents,
  setInitialSyncPhase,
  writePushedEventReceipts,
} from "./localRepository.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const baseEvent = {
  aggregateKind: "project",
  streamId: "project-1",
  streamVersion: 1,
  eventType: "project.created",
  occurredAt: "2026-05-01T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  actorKind: "system",
  payloadJson: "{}",
  metadataJson: "{}",
} as const;

function event(sequence: number, eventId = `event-${sequence}`): HistorySyncEventRow {
  return {
    ...baseEvent,
    sequence,
    eventId,
  };
}

function readReceiptRows(sql: SqlClient.SqlClient) {
  return sql<{
    readonly sequence: number;
    readonly eventId: string;
    readonly pushedAt: string;
  }>`
    SELECT
      sequence,
      event_id AS "eventId",
      pushed_at AS "pushedAt"
    FROM history_sync_pushed_events
    ORDER BY sequence ASC
  `;
}

function insertEvents(sql: SqlClient.SqlClient, events: readonly HistorySyncEventRow[]) {
  return sql`
    INSERT INTO orchestration_events ${sql.insert(
      events.map((row) => ({
        sequence: row.sequence,
        event_id: row.eventId,
        aggregate_kind: row.aggregateKind,
        stream_id: row.streamId,
        stream_version: row.sequence,
        event_type: row.eventType,
        occurred_at: row.occurredAt,
        command_id: row.commandId,
        causation_event_id: row.causationEventId,
        correlation_id: row.correlationId,
        actor_kind: row.actorKind,
        payload_json: row.payloadJson,
        metadata_json: row.metadataJson,
      })),
    )}
  `;
}

layer("history sync local repository commits", (it) => {
  it.effect("commits pushed receipts and sync state together", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`DELETE FROM history_sync_pushed_events`;
      yield* sql`DELETE FROM history_sync_state`;

      yield* commitPushedEventReceiptsAndState(sql, {
        events: [event(1)],
        pushedAt: "2026-05-01T00:00:01.000Z",
        state: {
          hasCompletedInitialSync: true,
          lastSyncedRemoteSequence: 1,
          lastSuccessfulSyncAt: "2026-05-01T00:00:01.000Z",
        },
      });

      assert.strictEqual(yield* readPushedEventReceiptCount(sql), 0);
      const state = yield* readState(sql);
      assert.strictEqual(state?.hasCompletedInitialSync, 1);
      assert.strictEqual(state?.lastSyncedRemoteSequence, 1);
    }),
  );

  it.effect("compacts receipt rows covered by the synced cursor", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`DELETE FROM history_sync_pushed_events`;
      yield* sql`DELETE FROM history_sync_state`;

      yield* writePushedEventReceipts(
        sql,
        [event(1), event(2), event(5)],
        "2026-05-01T00:00:00.000Z",
      );

      yield* commitPushedEventReceiptsAndState(sql, {
        events: [event(3)],
        pushedAt: "2026-05-01T00:00:01.000Z",
        state: {
          hasCompletedInitialSync: true,
          lastSyncedRemoteSequence: 3,
          lastSuccessfulSyncAt: "2026-05-01T00:00:01.000Z",
        },
      });

      assert.deepStrictEqual(yield* readReceiptRows(sql), [
        {
          sequence: 5,
          eventId: "event-5",
          pushedAt: "2026-05-01T00:00:00.000Z",
        },
      ]);
    }),
  );

  it.effect("treats events at or below the synced cursor as already pushed without receipts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`DELETE FROM history_sync_pushed_events`;
      yield* sql`DELETE FROM history_sync_state`;
      yield* insertEvents(sql, [event(1), event(2), event(3), event(4)]);

      yield* commitHistorySyncState(sql, {
        hasCompletedInitialSync: true,
        lastSyncedRemoteSequence: 3,
        lastSuccessfulSyncAt: "2026-05-01T00:00:01.000Z",
      });

      assert.deepStrictEqual(
        (yield* readUnpushedLocalEvents(sql)).map((row) => row.sequence),
        [4],
      );
    }),
  );

  it.effect("rolls back receipts when the local commit fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`DELETE FROM history_sync_pushed_events`;
      yield* sql`DELETE FROM history_sync_state`;
      yield* sql`
        CREATE TRIGGER fail_history_sync_state_insert
        BEFORE INSERT ON history_sync_state
        BEGIN
          SELECT RAISE(ABORT, 'state write failed');
        END
      `;

      const exit = yield* Effect.exit(
        commitPushedEventReceiptsAndState(sql, {
          events: [event(1), event(2)],
          pushedAt: "2026-05-01T00:00:01.000Z",
          state: {
            hasCompletedInitialSync: true,
            lastSyncedRemoteSequence: 2,
            lastSuccessfulSyncAt: "2026-05-01T00:00:01.000Z",
          },
        }),
      );

      assert.strictEqual(Exit.isFailure(exit), true);
      assert.strictEqual(yield* readPushedEventReceiptCount(sql), 0);
      assert.strictEqual(yield* readState(sql), null);
      yield* sql`DROP TRIGGER fail_history_sync_state_insert`;
    }),
  );

  it.effect("rolls back mixed old and new receipt rows when the transaction fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* commitHistorySyncState(sql, {
        hasCompletedInitialSync: true,
        lastSyncedRemoteSequence: 0,
        lastSuccessfulSyncAt: "2026-05-01T00:00:00.000Z",
      });
      yield* writePushedEventReceipts(
        sql,
        [event(1, "old-event-1"), event(3, "old-event-3")],
        "2026-05-01T00:00:00.000Z",
      );
      yield* sql`
        CREATE TRIGGER fail_history_sync_state_update
        BEFORE UPDATE ON history_sync_state
        BEGIN
          SELECT RAISE(ABORT, 'state update failed');
        END
      `;

      const exit = yield* Effect.exit(
        commitPushedEventReceiptsAndState(sql, {
          events: [event(1, "new-event-1"), event(2, "new-event-2"), event(3, "new-event-3")],
          pushedAt: "2026-05-01T00:00:01.000Z",
          state: {
            hasCompletedInitialSync: true,
            lastSyncedRemoteSequence: 3,
            lastSuccessfulSyncAt: "2026-05-01T00:00:01.000Z",
          },
        }),
      );

      assert.strictEqual(Exit.isFailure(exit), true);
      assert.deepStrictEqual(yield* readReceiptRows(sql), [
        {
          sequence: 1,
          eventId: "old-event-1",
          pushedAt: "2026-05-01T00:00:00.000Z",
        },
        {
          sequence: 3,
          eventId: "old-event-3",
          pushedAt: "2026-05-01T00:00:00.000Z",
        },
      ]);
      yield* sql`DROP TRIGGER fail_history_sync_state_update`;
    }),
  );

  it.effect("tolerates empty receipt commits while writing state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`DELETE FROM history_sync_pushed_events`;
      yield* sql`DELETE FROM history_sync_state`;

      yield* commitPushedEventReceiptsAndState(sql, {
        events: [],
        pushedAt: "2026-05-01T00:00:01.000Z",
        state: {
          hasCompletedInitialSync: true,
          lastSyncedRemoteSequence: 7,
          lastSuccessfulSyncAt: "2026-05-01T00:00:01.000Z",
        },
      });

      assert.strictEqual(yield* readPushedEventReceiptCount(sql), 0);
      assert.strictEqual((yield* readState(sql))?.lastSyncedRemoteSequence, 7);
    }),
  );

  it.effect("state-only commits preserve client id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`DROP TRIGGER IF EXISTS fail_history_sync_state_insert`;
      const clientId = yield* ensureClientId(sql);

      yield* commitHistorySyncState(sql, {
        hasCompletedInitialSync: true,
        lastSyncedRemoteSequence: 42,
        lastSuccessfulSyncAt: "2026-05-01T00:00:01.000Z",
      });

      const state = yield* readState(sql);
      assert.strictEqual(state?.clientId, clientId);
      assert.strictEqual(state?.lastSyncedRemoteSequence, 42);
    }),
  );

  it.effect("state commits preserve client id and recovery fields until phase is cleared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      const clientId = yield* ensureClientId(sql);
      yield* setInitialSyncPhase(sql, {
        phase: "push-local",
        startedAt: "2026-05-01T00:00:00.000Z",
      });

      yield* commitHistorySyncState(sql, {
        hasCompletedInitialSync: true,
        lastSyncedRemoteSequence: 42,
        lastSuccessfulSyncAt: "2026-05-01T00:00:01.000Z",
      });

      const state = yield* readState(sql);
      assert.strictEqual(state?.clientId, clientId);
      assert.strictEqual(state?.initialSyncPhase, "push-local");
      assert.strictEqual(state?.initialSyncStartedAt, "2026-05-01T00:00:00.000Z");
    }),
  );
});
