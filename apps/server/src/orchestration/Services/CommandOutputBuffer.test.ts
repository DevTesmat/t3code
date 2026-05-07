import { describe, expect, it, beforeEach } from "vitest";
import { Effect } from "effect";
import { EventId, ProviderItemId, ThreadId, TurnId } from "@t3tools/contracts";

import {
  appendCommandOutputBufferDelta,
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
});
