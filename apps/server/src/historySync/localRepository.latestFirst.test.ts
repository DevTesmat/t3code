import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  importRemoteDeltaEvents,
  markHistorySyncThreadPriority,
  readLocalEventRefsForSequences,
  readLocalEvents,
  readHistorySyncThreadStateCounts,
  updateHistorySyncLatestFirstState,
  upsertHistorySyncThreadStates,
} from "./localRepository.ts";
import type { HistorySyncEventRow } from "./planner.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const now = "2026-05-01T00:00:00.000Z";

function event(sequence: number): HistorySyncEventRow {
  return {
    sequence,
    eventId: `event-${sequence}`,
    aggregateKind: "thread",
    streamId: "thread-a",
    streamVersion: sequence,
    eventType: "thread.message-sent",
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    actorKind: "user",
    payloadJson: JSON.stringify({
      threadId: "thread-a",
      messageId: `message-${sequence}`,
      role: "user",
      text: `message ${sequence}`,
    }),
    metadataJson: "{}",
  };
}

layer("history sync latest-first local repository", (it) => {
  it.effect("tracks thread shell counts, priority, and cursors", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });

      yield* upsertHistorySyncThreadStates(sql, [
        {
          threadId: "thread-a",
          remoteProjectId: "remote-project",
          latestRemoteSequence: 10,
          isShellLoaded: true,
          now,
        },
        {
          threadId: "thread-b",
          latestRemoteSequence: 20,
          isShellLoaded: false,
          now,
        },
      ]);
      yield* markHistorySyncThreadPriority(sql, {
        threadId: "thread-b",
        priority: 100,
        requestedAt: now,
      });
      yield* updateHistorySyncLatestFirstState(sql, {
        remoteAppliedSequence: 10,
        remoteKnownMaxSequence: 20,
        liveAppendEnabled: true,
        latestBootstrapCompletedAt: now,
      });

      assert.deepStrictEqual(yield* readHistorySyncThreadStateCounts(sql), {
        loadedThreadCount: 1,
        totalThreadCount: 2,
      });
    }),
  );

  it.effect("imports remote deltas idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });

      yield* importRemoteDeltaEvents(sql, [event(1), event(2)]);
      yield* importRemoteDeltaEvents(sql, [event(1), event(2), event(3)]);

      const rows = yield* readLocalEvents(sql);
      assert.deepStrictEqual(
        rows.map((row) => row.sequence),
        [1, 2, 3],
      );
    }),
  );

  it.effect("reads bounded local event refs for candidate remote sequences", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });

      yield* importRemoteDeltaEvents(sql, [event(1), event(2), event(3)]);

      const refs = yield* readLocalEventRefsForSequences(sql, [3, 1, 3, 99]);
      assert.deepStrictEqual(refs, [
        { sequence: 1, eventId: "event-1" },
        { sequence: 3, eventId: "event-3" },
      ]);
    }),
  );
});
