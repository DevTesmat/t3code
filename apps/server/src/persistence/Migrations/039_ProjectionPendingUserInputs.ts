import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_pending_user_inputs (
      request_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_pending_user_inputs_thread_status
    ON projection_pending_user_inputs(thread_id, status)
  `;

  yield* sql`
    WITH requested_user_inputs AS (
      SELECT
        json_extract(activity.payload_json, '$.requestId') AS request_id,
        activity.thread_id,
        activity.turn_id,
        activity.created_at,
        ROW_NUMBER() OVER (
          PARTITION BY json_extract(activity.payload_json, '$.requestId')
          ORDER BY
            CASE WHEN activity.sequence IS NULL THEN 0 ELSE 1 END ASC,
            activity.sequence ASC,
            activity.created_at ASC,
            activity.activity_id ASC
        ) AS row_number
      FROM projection_thread_activities AS activity
      WHERE activity.kind = 'user-input.requested'
        AND json_extract(activity.payload_json, '$.requestId') IS NOT NULL
    )
    INSERT INTO projection_pending_user_inputs (
      request_id,
      thread_id,
      turn_id,
      status,
      created_at,
      resolved_at
    )
    SELECT
      requested_user_inputs.request_id,
      requested_user_inputs.thread_id,
      requested_user_inputs.turn_id,
      'pending',
      requested_user_inputs.created_at,
      NULL
    FROM requested_user_inputs
    WHERE requested_user_inputs.row_number = 1
    ON CONFLICT (request_id)
    DO UPDATE SET
      thread_id = excluded.thread_id,
      turn_id = excluded.turn_id,
      status = excluded.status,
      created_at = excluded.created_at,
      resolved_at = excluded.resolved_at
  `;

  yield* sql`
    WITH latest_resolutions AS (
      SELECT
        resolved.request_id,
        resolved.resolved_at
      FROM (
        SELECT
          json_extract(activity.payload_json, '$.requestId') AS request_id,
          activity.created_at AS resolved_at,
          ROW_NUMBER() OVER (
            PARTITION BY json_extract(activity.payload_json, '$.requestId')
            ORDER BY activity.created_at DESC, activity.activity_id DESC
          ) AS row_number
        FROM projection_thread_activities AS activity
        WHERE activity.kind = 'user-input.resolved'
          AND json_extract(activity.payload_json, '$.requestId') IS NOT NULL
      ) AS resolved
      WHERE resolved.row_number = 1
    )
    UPDATE projection_pending_user_inputs
    SET
      status = 'resolved',
      resolved_at = (
        SELECT latest_resolutions.resolved_at
        FROM latest_resolutions
        WHERE latest_resolutions.request_id = projection_pending_user_inputs.request_id
      )
    WHERE EXISTS (
      SELECT 1
      FROM latest_resolutions
      WHERE latest_resolutions.request_id = projection_pending_user_inputs.request_id
    )
  `;

  yield* sql`
    WITH latest_stale_failures AS (
      SELECT
        failure.request_id,
        failure.resolved_at
      FROM (
        SELECT
          json_extract(activity.payload_json, '$.requestId') AS request_id,
          activity.created_at AS resolved_at,
          ROW_NUMBER() OVER (
            PARTITION BY json_extract(activity.payload_json, '$.requestId')
            ORDER BY activity.created_at DESC, activity.activity_id DESC
          ) AS row_number
        FROM projection_thread_activities AS activity
        WHERE activity.kind = 'provider.user-input.respond.failed'
          AND json_extract(activity.payload_json, '$.requestId') IS NOT NULL
          AND (
            lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
              LIKE '%stale pending user-input request%'
            OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
              LIKE '%unknown pending user-input request%'
          )
      ) AS failure
      WHERE failure.row_number = 1
    )
    UPDATE projection_pending_user_inputs
    SET
      status = 'resolved',
      resolved_at = (
        SELECT latest_stale_failures.resolved_at
        FROM latest_stale_failures
        WHERE latest_stale_failures.request_id = projection_pending_user_inputs.request_id
      )
    WHERE status = 'pending'
      AND EXISTS (
        SELECT 1
        FROM latest_stale_failures
        WHERE latest_stale_failures.request_id = projection_pending_user_inputs.request_id
      )
  `;

  yield* sql`
    UPDATE projection_threads
    SET
      pending_user_input_count = COALESCE((
        SELECT COUNT(*)
        FROM projection_pending_user_inputs
        WHERE projection_pending_user_inputs.thread_id = projection_threads.thread_id
          AND projection_pending_user_inputs.status = 'pending'
      ), 0),
      latest_pending_user_input_at = (
        SELECT MAX(created_at)
        FROM projection_pending_user_inputs
        WHERE projection_pending_user_inputs.thread_id = projection_threads.thread_id
          AND projection_pending_user_inputs.status = 'pending'
      )
  `;
});
