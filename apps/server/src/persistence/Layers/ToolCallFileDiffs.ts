import { ProviderItemId, ThreadId, TurnId } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect, Layer } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ToolCallFileDiffRepository,
  type ToolCallFileDiff,
  type ToolCallFileDiffRepositoryShape,
} from "../Services/ToolCallFileDiffs.ts";

const TextEncoderCtor = globalThis.TextEncoder;
const textEncoder = TextEncoderCtor ? new TextEncoderCtor() : null;

function byteLength(value: string): number {
  return textEncoder?.encode(value).byteLength ?? Buffer.byteLength(value, "utf8");
}

function staleCutoffIso(now: string, staleAfterMs: number): string {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) {
    return new Date(Date.now() - staleAfterMs).toISOString();
  }
  return new Date(timestamp - staleAfterMs).toISOString();
}

interface ToolCallFileDiffRow {
  readonly threadId: string;
  readonly turnId: string | null;
  readonly toolCallId: string;
  readonly diff: string;
  readonly truncated: number;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastAccessedAt: string;
}

function toToolCallFileDiff(row: ToolCallFileDiffRow): ToolCallFileDiff {
  return {
    threadId: ThreadId.make(row.threadId),
    turnId: row.turnId === null ? null : TurnId.make(row.turnId),
    toolCallId: ProviderItemId.make(row.toolCallId),
    diff: row.diff,
    truncated: row.truncated === 1,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastAccessedAt: row.lastAccessedAt,
  };
}

const makeToolCallFileDiffRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsert: ToolCallFileDiffRepositoryShape["upsert"] = (row) =>
    sql`
      INSERT INTO tool_call_file_diffs (
        thread_id,
        turn_id,
        tool_call_id,
        diff,
        truncated,
        size_bytes,
        created_at,
        updated_at,
        last_accessed_at
      )
      VALUES (
        ${row.threadId},
        ${row.turnId},
        ${row.toolCallId},
        ${row.diff},
        ${row.truncated ? 1 : 0},
        ${byteLength(row.diff)},
        ${row.updatedAt},
        ${row.updatedAt},
        ${row.updatedAt}
      )
      ON CONFLICT (thread_id, tool_call_id)
      DO UPDATE SET
        turn_id = excluded.turn_id,
        diff = excluded.diff,
        truncated = excluded.truncated,
        size_bytes = excluded.size_bytes,
        updated_at = excluded.updated_at,
        last_accessed_at = excluded.last_accessed_at
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ToolCallFileDiffRepository.upsert")),
    );

  const listByThread: ToolCallFileDiffRepositoryShape["listByThread"] = ({
    threadId,
    accessedAt,
  }) =>
    sql
      .withTransaction(
        sql`
        UPDATE tool_call_file_diffs
        SET last_accessed_at = ${accessedAt}
        WHERE thread_id = ${threadId}
      `.pipe(
          Effect.andThen(
            sql<ToolCallFileDiffRow>`
            SELECT
              thread_id AS "threadId",
              turn_id AS "turnId",
              tool_call_id AS "toolCallId",
              diff,
              truncated,
              size_bytes AS "sizeBytes",
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              last_accessed_at AS "lastAccessedAt"
            FROM tool_call_file_diffs
            WHERE thread_id = ${threadId}
            ORDER BY updated_at ASC, tool_call_id ASC
          `,
          ),
        ),
      )
      .pipe(
        Effect.map((rows) => rows.map(toToolCallFileDiff)),
        Effect.mapError(toPersistenceSqlError("ToolCallFileDiffRepository.listByThread")),
      );

  const cleanupIfOverBudget: ToolCallFileDiffRepositoryShape["cleanupIfOverBudget"] = (input) =>
    Effect.gen(function* () {
      const [{ totalBytes = 0 } = { totalBytes: 0 }] = yield* sql<{
        readonly totalBytes: number | null;
      }>`
        SELECT COALESCE(SUM(size_bytes), 0) AS "totalBytes"
        FROM tool_call_file_diffs
      `;
      if ((totalBytes ?? 0) <= input.maxTotalBytes) {
        return;
      }

      const cutoff = staleCutoffIso(input.now, input.staleAfterMs);
      let remainingBytes = totalBytes ?? 0;
      while (remainingBytes > input.targetTotalBytes) {
        const staleRows = yield* sql<{
          readonly threadId: string;
          readonly toolCallId: string;
          readonly sizeBytes: number;
        }>`
          SELECT
            thread_id AS "threadId",
            tool_call_id AS "toolCallId",
            size_bytes AS "sizeBytes"
          FROM tool_call_file_diffs
          WHERE updated_at < ${cutoff}
             OR last_accessed_at < ${cutoff}
          ORDER BY last_accessed_at ASC, updated_at ASC
          LIMIT ${input.batchSize}
        `;
        if (staleRows.length === 0) {
          return;
        }
        yield* Effect.forEach(
          staleRows,
          (row) =>
            sql`
              DELETE FROM tool_call_file_diffs
              WHERE thread_id = ${row.threadId}
                AND tool_call_id = ${row.toolCallId}
            `,
          { discard: true },
        );
        remainingBytes -= staleRows.reduce((sum, row) => sum + row.sizeBytes, 0);
      }
    }).pipe(
      Effect.mapError(toPersistenceSqlError("ToolCallFileDiffRepository.cleanupIfOverBudget")),
    );

  return {
    upsert,
    listByThread,
    cleanupIfOverBudget,
  } satisfies ToolCallFileDiffRepositoryShape;
});

export const ToolCallFileDiffRepositoryLive = Layer.effect(
  ToolCallFileDiffRepository,
  makeToolCallFileDiffRepository,
);
