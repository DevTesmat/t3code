import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN latest_pending_user_input_at TEXT
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    UPDATE projection_threads
    SET latest_pending_user_input_at = (
      WITH latest_user_input_states AS (
        SELECT
          latest.request_id,
          latest.kind,
          latest.created_at,
          latest.detail
        FROM (
          SELECT
            json_extract(activity.payload_json, '$.requestId') AS request_id,
            activity.kind,
            activity.created_at,
            lower(COALESCE(json_extract(activity.payload_json, '$.detail'), '')) AS detail,
            ROW_NUMBER() OVER (
              PARTITION BY json_extract(activity.payload_json, '$.requestId')
              ORDER BY activity.created_at DESC, activity.activity_id DESC
            ) AS row_number
          FROM projection_thread_activities AS activity
          WHERE activity.thread_id = projection_threads.thread_id
            AND json_extract(activity.payload_json, '$.requestId') IS NOT NULL
            AND activity.kind IN (
              'user-input.requested',
              'user-input.resolved',
              'provider.user-input.respond.failed'
            )
        ) AS latest
        WHERE latest.row_number = 1
      )
      SELECT MAX(latest_user_input_states.created_at)
      FROM latest_user_input_states
      WHERE latest_user_input_states.kind = 'user-input.requested'
        OR (
          latest_user_input_states.kind = 'provider.user-input.respond.failed'
          AND latest_user_input_states.detail NOT LIKE '%stale pending user-input request%'
          AND latest_user_input_states.detail NOT LIKE '%unknown pending user-input request%'
        )
    )
  `;
});
