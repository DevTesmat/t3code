import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("029_ProjectionThreadsLatestPendingUserInputAt", (it) => {
  it.effect("backfills the latest open pending user-input request timestamp", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 28 });

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
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES
          (
            'thread-open',
            'project-1',
            'Open',
            '{"instanceId":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:00.000Z',
            NULL,
            NULL,
            0,
            2,
            0,
            NULL
          ),
          (
            'thread-resolved',
            'project-1',
            'Resolved',
            '{"instanceId":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:00.000Z',
            NULL,
            NULL,
            0,
            0,
            0,
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
            'activity-open-1',
            'thread-open',
            NULL,
            'info',
            'user-input.requested',
            'Input requested',
            '{"requestId":"request-open-1"}',
            '2026-03-01T10:00:00.000Z',
            1
          ),
          (
            'activity-open-2',
            'thread-open',
            NULL,
            'info',
            'user-input.requested',
            'Input requested',
            '{"requestId":"request-open-2"}',
            '2026-03-01T10:05:00.000Z',
            2
          ),
          (
            'activity-resolved-1',
            'thread-resolved',
            NULL,
            'info',
            'user-input.requested',
            'Input requested',
            '{"requestId":"request-resolved-1"}',
            '2026-03-01T10:00:00.000Z',
            3
          ),
          (
            'activity-resolved-2',
            'thread-resolved',
            NULL,
            'info',
            'user-input.resolved',
            'Input resolved',
            '{"requestId":"request-resolved-1"}',
            '2026-03-01T10:01:00.000Z',
            4
          ),
          (
            'activity-stale-1',
            'thread-open',
            NULL,
            'info',
            'user-input.requested',
            'Input requested',
            '{"requestId":"request-stale-1"}',
            '2026-03-01T10:10:00.000Z',
            5
          ),
          (
            'activity-stale-2',
            'thread-open',
            NULL,
            'error',
            'provider.user-input.respond.failed',
            'Input failed',
            '{"requestId":"request-stale-1","detail":"Unknown pending user-input request"}',
            '2026-03-01T10:11:00.000Z',
            6
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 29 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly latestPendingUserInputAt: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          latest_pending_user_input_at AS "latestPendingUserInputAt"
        FROM projection_threads
        ORDER BY thread_id ASC
      `;

      assert.deepStrictEqual(rows, [
        {
          threadId: "thread-open",
          latestPendingUserInputAt: "2026-03-01T10:05:00.000Z",
        },
        {
          threadId: "thread-resolved",
          latestPendingUserInputAt: null,
        },
      ]);
    }),
  );
});
