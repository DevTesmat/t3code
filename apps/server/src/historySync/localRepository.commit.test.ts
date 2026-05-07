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

layer("history sync local repository commits", (it) => {
  it.effect("commits pushed receipts and sync state together", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 36 });

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
    }),
  );

  it.effect("state-only commits preserve client id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 36 });
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
});
