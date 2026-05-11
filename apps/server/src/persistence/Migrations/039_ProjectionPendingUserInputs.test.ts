import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0039 from "./039_ProjectionPendingUserInputs.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("039_ProjectionPendingUserInputs", (it) => {
  it.effect("backfills pending user-input rows and thread shell summaries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 38 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          latest_pending_user_input_at,
          has_actionable_proposed_plan,
          pinned_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"instanceId":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          '2026-03-07T00:00:00.000Z',
          '2026-03-07T00:00:00.000Z',
          NULL,
          NULL,
          0,
          0,
          NULL,
          0,
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at,
          sequence
        )
        VALUES
          (
            'activity-request-1',
            'thread-1',
            NULL,
            'info',
            'user-input.requested',
            'Input requested',
            '{"requestId":"request-open"}',
            '2026-03-07T10:00:00.000Z',
            1
          ),
          (
            'activity-request-1-duplicate',
            'thread-1',
            NULL,
            'info',
            'user-input.requested',
            'Input requested again',
            '{"requestId":"request-open"}',
            '2026-03-07T10:01:00.000Z',
            2
          ),
          (
            'activity-request-2',
            'thread-1',
            NULL,
            'info',
            'user-input.requested',
            'Input requested',
            '{"requestId":"request-resolved"}',
            '2026-03-07T10:05:00.000Z',
            3
          ),
          (
            'activity-resolved',
            'thread-1',
            NULL,
            'info',
            'user-input.resolved',
            'Input resolved',
            '{"requestId":"request-resolved"}',
            '2026-03-07T10:06:00.000Z',
            4
          ),
          (
            'activity-request-3',
            'thread-1',
            NULL,
            'info',
            'user-input.requested',
            'Input requested',
            '{"requestId":"request-stale"}',
            '2026-03-07T10:10:00.000Z',
            5
          ),
          (
            'activity-stale',
            'thread-1',
            NULL,
            'error',
            'provider.user-input.respond.failed',
            'Input failed',
            '{"requestId":"request-stale","detail":"Unknown pending user-input request"}',
            '2026-03-07T10:11:00.000Z',
            6
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 39 });
      yield* Migration0039;
      yield* Migration0039;

      const userInputRows = yield* sql<{
        readonly requestId: string;
        readonly createdAt: string;
        readonly status: string;
        readonly resolvedAt: string | null;
      }>`
        SELECT
          request_id AS "requestId",
          created_at AS "createdAt",
          status,
          resolved_at AS "resolvedAt"
        FROM projection_pending_user_inputs
        ORDER BY request_id ASC
      `;
      assert.deepStrictEqual(userInputRows, [
        {
          requestId: "request-open",
          createdAt: "2026-03-07T10:00:00.000Z",
          status: "pending",
          resolvedAt: null,
        },
        {
          requestId: "request-resolved",
          createdAt: "2026-03-07T10:05:00.000Z",
          status: "resolved",
          resolvedAt: "2026-03-07T10:06:00.000Z",
        },
        {
          requestId: "request-stale",
          createdAt: "2026-03-07T10:10:00.000Z",
          status: "resolved",
          resolvedAt: "2026-03-07T10:11:00.000Z",
        },
      ]);

      const threadRows = yield* sql<{
        readonly pendingUserInputCount: number;
        readonly latestPendingUserInputAt: string | null;
      }>`
        SELECT
          pending_user_input_count AS "pendingUserInputCount",
          latest_pending_user_input_at AS "latestPendingUserInputAt"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepStrictEqual(threadRows, [
        {
          pendingUserInputCount: 1,
          latestPendingUserInputAt: "2026-03-07T10:00:00.000Z",
        },
      ]);
    }),
  );
});
