import { ProviderItemId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ToolCallFileDiffRepositoryLive } from "./ToolCallFileDiffs.ts";
import { ToolCallFileDiffRepository } from "../Services/ToolCallFileDiffs.ts";

const layer = it.layer(
  Layer.mergeAll(
    ToolCallFileDiffRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

layer("ToolCallFileDiffRepository", (it) => {
  it.effect("upserts and lists file diffs by thread", () =>
    Effect.gen(function* () {
      const repository = yield* ToolCallFileDiffRepository;
      const threadId = ThreadId.make("thread-file-diffs");
      const toolCallId = ProviderItemId.make("tool-1");

      yield* repository.upsert({
        threadId,
        turnId: TurnId.make("turn-1"),
        toolCallId,
        diff: "diff --git a/src/app.ts b/src/app.ts\n+first\n",
        truncated: false,
        updatedAt: "2026-03-17T19:12:31.000Z",
      });
      yield* repository.upsert({
        threadId,
        turnId: TurnId.make("turn-1"),
        toolCallId,
        diff: "diff --git a/src/app.ts b/src/app.ts\n+second\n",
        truncated: false,
        updatedAt: "2026-03-17T19:12:32.000Z",
      });

      const rows = yield* repository.listByThread({
        threadId,
        accessedAt: "2026-03-17T19:12:33.000Z",
      });

      assert.deepStrictEqual(rows, [
        {
          threadId,
          turnId: TurnId.make("turn-1"),
          toolCallId,
          diff: "diff --git a/src/app.ts b/src/app.ts\n+second\n",
          truncated: false,
          sizeBytes: 45,
          createdAt: "2026-03-17T19:12:31.000Z",
          updatedAt: "2026-03-17T19:12:32.000Z",
          lastAccessedAt: "2026-03-17T19:12:33.000Z",
        },
      ]);
    }),
  );

  it.effect("cleans stale rows only when over the size budget", () =>
    Effect.gen(function* () {
      const repository = yield* ToolCallFileDiffRepository;
      const threadId = ThreadId.make("thread-cleanup");

      yield* repository.upsert({
        threadId,
        turnId: null,
        toolCallId: ProviderItemId.make("old-1"),
        diff: "old-one",
        truncated: false,
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      yield* repository.upsert({
        threadId,
        turnId: null,
        toolCallId: ProviderItemId.make("old-2"),
        diff: "old-two",
        truncated: false,
        updatedAt: "2026-03-02T00:00:00.000Z",
      });
      yield* repository.upsert({
        threadId,
        turnId: null,
        toolCallId: ProviderItemId.make("fresh"),
        diff: "fresh",
        truncated: false,
        updatedAt: "2026-03-17T00:00:00.000Z",
      });

      yield* repository.cleanupIfOverBudget({
        now: "2026-03-17T00:00:00.000Z",
        staleAfterMs: 7 * 24 * 60 * 60_000,
        maxTotalBytes: 1_000,
        targetTotalBytes: 500,
        batchSize: 10,
      });
      assert.equal(
        (yield* repository.listByThread({
          threadId,
          accessedAt: "2026-03-17T00:00:01.000Z",
        })).length,
        3,
      );

      yield* repository.cleanupIfOverBudget({
        now: "2026-03-17T00:00:02.000Z",
        staleAfterMs: 7 * 24 * 60 * 60_000,
        maxTotalBytes: 10,
        targetTotalBytes: 5,
        batchSize: 10,
      });
      const remainingRows = yield* repository.listByThread({
        threadId,
        accessedAt: "2026-03-17T00:00:03.000Z",
      });
      assert.deepStrictEqual(
        remainingRows.map((row) => row.toolCallId),
        [ProviderItemId.make("fresh")],
      );
    }),
  );

  it.effect("lists the latest file diffs by thread without touching older rows", () =>
    Effect.gen(function* () {
      const repository = yield* ToolCallFileDiffRepository;
      const threadId = ThreadId.make("thread-latest-file-diffs");

      for (let index = 1; index <= 4; index += 1) {
        yield* repository.upsert({
          threadId,
          turnId: TurnId.make(`turn-${index}`),
          toolCallId: ProviderItemId.make(`tool-${index}`),
          diff: `diff-${index}`,
          truncated: false,
          updatedAt: `2026-03-17T19:12:3${index}.000Z`,
        });
      }

      const latestRows = yield* repository.listLatestByThread({
        threadId,
        accessedAt: "2026-03-17T19:13:00.000Z",
        limit: 2,
      });

      assert.deepStrictEqual(
        latestRows.map((row) => row.toolCallId),
        [ProviderItemId.make("tool-3"), ProviderItemId.make("tool-4")],
      );
      assert.deepStrictEqual(
        latestRows.map((row) => row.lastAccessedAt),
        ["2026-03-17T19:13:00.000Z", "2026-03-17T19:13:00.000Z"],
      );

      const allRows = yield* repository.listByThread({
        threadId,
        accessedAt: "2026-03-17T19:13:01.000Z",
      });
      assert.deepStrictEqual(
        allRows.map((row) => row.toolCallId),
        [
          ProviderItemId.make("tool-1"),
          ProviderItemId.make("tool-2"),
          ProviderItemId.make("tool-3"),
          ProviderItemId.make("tool-4"),
        ],
      );
    }),
  );

  it.effect("loads a single file diff by thread and tool call", () =>
    Effect.gen(function* () {
      const repository = yield* ToolCallFileDiffRepository;
      const threadId = ThreadId.make("thread-single-file-diff");
      const toolCallId = ProviderItemId.make("tool-single");

      yield* repository.upsert({
        threadId,
        turnId: TurnId.make("turn-single"),
        toolCallId,
        diff: "diff --git a/src/app.ts b/src/app.ts\n+single\n",
        truncated: false,
        updatedAt: "2026-03-17T19:12:31.000Z",
      });

      const row = yield* repository.getByThreadAndToolCall({
        threadId,
        toolCallId,
        accessedAt: "2026-03-17T19:13:00.000Z",
      });

      assert.deepStrictEqual(row, {
        threadId,
        turnId: TurnId.make("turn-single"),
        toolCallId,
        diff: "diff --git a/src/app.ts b/src/app.ts\n+single\n",
        truncated: false,
        sizeBytes: 45,
        createdAt: "2026-03-17T19:12:31.000Z",
        updatedAt: "2026-03-17T19:12:31.000Z",
        lastAccessedAt: "2026-03-17T19:13:00.000Z",
      });

      const missing = yield* repository.getByThreadAndToolCall({
        threadId,
        toolCallId: ProviderItemId.make("missing"),
        accessedAt: "2026-03-17T19:13:00.000Z",
      });
      assert.equal(missing, null);
    }),
  );
});
