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
  setInitialSyncPhase,
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

layer("history sync local repository commits", (it) => {
  it.effect("commits pushed receipts and sync state together", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 36 });
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

      assert.strictEqual(yield* readPushedEventReceiptCount(sql), 1);
      const state = yield* readState(sql);
      assert.strictEqual(state?.hasCompletedInitialSync, 1);
      assert.strictEqual(state?.lastSyncedRemoteSequence, 1);
    }),
  );

  it.effect("rolls back receipts when the local commit fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 36 });
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

  it.effect("restores previous receipt rows when a mixed old and new commit fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 36 });
      yield* commitPushedEventReceiptsAndState(sql, {
        events: [event(1, "old-event-1"), event(3, "old-event-3")],
        pushedAt: "2026-05-01T00:00:00.000Z",
        state: {
          hasCompletedInitialSync: true,
          lastSyncedRemoteSequence: 3,
          lastSuccessfulSyncAt: "2026-05-01T00:00:00.000Z",
        },
      });
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
      yield* runMigrations({ toMigrationInclusive: 36 });
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
      yield* runMigrations({ toMigrationInclusive: 36 });
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
      yield* runMigrations({ toMigrationInclusive: 36 });
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
