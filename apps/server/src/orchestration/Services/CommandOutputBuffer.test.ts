import { describe, expect, it, beforeEach } from "vitest";
import { Effect } from "effect";
import { EventId, ProviderItemId, ThreadId, TurnId } from "@t3tools/contracts";

import {
  appendCommandOutputBufferDelta,
  readCommandOutputSnapshot,
  readCommandOutputSnapshotsForThread,
  resetCommandOutputBufferForTests,
} from "./CommandOutputBuffer.ts";

const threadId = ThreadId.make("thread-1");
const toolCallId = ProviderItemId.make("tool-1");

describe("CommandOutputBuffer", () => {
  beforeEach(() => {
    resetCommandOutputBufferForTests();
  });

  it("stores and dedupes command output snapshots by chunk id", async () => {
    const delta = {
      threadId,
      turnId: TurnId.make("turn-1"),
      toolCallId,
      chunkId: EventId.make("chunk-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      delta: "same\n",
    };

    await Effect.runPromise(appendCommandOutputBufferDelta(delta));
    await Effect.runPromise(appendCommandOutputBufferDelta(delta));

    const snapshots = await Effect.runPromise(readCommandOutputSnapshotsForThread(threadId));
    expect(snapshots).toEqual([
      {
        threadId,
        turnId: TurnId.make("turn-1"),
        toolCallId,
        updatedAt: "2026-01-01T00:00:00.000Z",
        text: "same\n",
        truncated: false,
      },
    ]);
  });

  it("resets buffered text for synthetic file-change reset chunks", async () => {
    await Effect.runPromise(
      appendCommandOutputBufferDelta({
        threadId,
        turnId: TurnId.make("turn-1"),
        toolCallId,
        chunkId: EventId.make("chunk-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        delta: "old text",
      }),
    );
    await Effect.runPromise(
      appendCommandOutputBufferDelta({
        threadId,
        turnId: TurnId.make("turn-1"),
        toolCallId,
        chunkId: EventId.make("event-1:file-change-reset:0"),
        createdAt: "2026-01-01T00:00:01.000Z",
        delta: "new",
      }),
    );
    await Effect.runPromise(
      appendCommandOutputBufferDelta({
        threadId,
        turnId: TurnId.make("turn-1"),
        toolCallId,
        chunkId: EventId.make("event-1:file-change:1"),
        createdAt: "2026-01-01T00:00:01.000Z",
        delta: " text",
      }),
    );

    const snapshots = await Effect.runPromise(readCommandOutputSnapshotsForThread(threadId));
    expect(snapshots).toEqual([
      {
        threadId,
        turnId: TurnId.make("turn-1"),
        toolCallId,
        updatedAt: "2026-01-01T00:00:01.000Z",
        text: "new text",
        truncated: false,
      },
    ]);
  });

  it("reads one command output snapshot by thread and tool call", async () => {
    await Effect.runPromise(
      appendCommandOutputBufferDelta({
        threadId,
        turnId: TurnId.make("turn-1"),
        toolCallId,
        chunkId: EventId.make("chunk-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        delta: "hello",
      }),
    );

    await expect(
      Effect.runPromise(readCommandOutputSnapshot({ threadId, toolCallId })),
    ).resolves.toEqual({
      threadId,
      turnId: TurnId.make("turn-1"),
      toolCallId,
      updatedAt: "2026-01-01T00:00:00.000Z",
      text: "hello",
      truncated: false,
    });
    await expect(
      Effect.runPromise(
        readCommandOutputSnapshot({
          threadId,
          toolCallId: ProviderItemId.make("missing-tool"),
        }),
      ),
    ).resolves.toBeNull();
  });
});
