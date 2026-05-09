import { describe, expect, it, beforeEach } from "vitest";
import { EnvironmentId, EventId, ProviderItemId, ThreadId, TurnId } from "@t3tools/contracts";

import {
  appendLiveCommandOutputDelta,
  hydrateLiveCommandOutputSnapshot,
  readLiveCommandOutputSnapshot,
  resetLiveCommandOutputForTests,
  sweepLiveCommandOutputForTests,
} from "./liveCommandOutput";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");
const toolCallId = ProviderItemId.make("tool-1");

describe("liveCommandOutput", () => {
  beforeEach(() => {
    resetLiveCommandOutputForTests();
  });

  it("appends command output deltas by thread and tool call", () => {
    appendLiveCommandOutputDelta(environmentId, {
      threadId,
      turnId: TurnId.make("turn-1"),
      toolCallId,
      chunkId: EventId.make("chunk-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      delta: "first\n",
    });
    appendLiveCommandOutputDelta(environmentId, {
      threadId,
      turnId: TurnId.make("turn-1"),
      toolCallId,
      chunkId: EventId.make("chunk-2"),
      createdAt: "2026-01-01T00:00:01.000Z",
      delta: "second",
    });

    expect(
      readLiveCommandOutputSnapshot({
        environmentId,
        threadId,
        toolCallId,
      }),
    ).toMatchObject({
      text: "first\nsecond",
      version: 2,
      truncated: false,
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
  });

  it("dedupes repeated chunks", () => {
    const delta = {
      threadId,
      turnId: null,
      toolCallId,
      chunkId: EventId.make("chunk-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      delta: "same\n",
    };

    appendLiveCommandOutputDelta(environmentId, delta);
    appendLiveCommandOutputDelta(environmentId, delta);

    expect(
      readLiveCommandOutputSnapshot({
        environmentId,
        threadId,
        toolCallId,
      }).text,
    ).toBe("same\n");
  });

  it("hydrates command output snapshots after a refresh", () => {
    hydrateLiveCommandOutputSnapshot(environmentId, {
      threadId,
      turnId: TurnId.make("turn-1"),
      toolCallId,
      updatedAt: "2026-01-01T00:00:02.000Z",
      text: "full\ncompleted\noutput",
      truncated: false,
    });

    expect(
      readLiveCommandOutputSnapshot({
        environmentId,
        threadId,
        toolCallId,
      }),
    ).toMatchObject({
      text: "full\ncompleted\noutput",
      version: 1,
      truncated: false,
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
  });

  it("replaces older streamed text with newer snapshots", () => {
    appendLiveCommandOutputDelta(environmentId, {
      threadId,
      turnId: TurnId.make("turn-1"),
      toolCallId,
      chunkId: EventId.make("chunk-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      delta: "partial",
    });
    hydrateLiveCommandOutputSnapshot(environmentId, {
      threadId,
      turnId: TurnId.make("turn-1"),
      toolCallId,
      updatedAt: "2026-01-01T00:00:01.000Z",
      text: "final patch",
      truncated: false,
    });

    expect(
      readLiveCommandOutputSnapshot({
        environmentId,
        threadId,
        toolCallId,
      }).text,
    ).toBe("final patch");
  });

  it("publishes a new immutable snapshot object for external-store updates", () => {
    const key = {
      environmentId,
      threadId,
      toolCallId,
    };
    hydrateLiveCommandOutputSnapshot(environmentId, {
      threadId,
      turnId: TurnId.make("turn-1"),
      toolCallId,
      updatedAt: "2026-01-01T00:00:01.000Z",
      text: "first patch",
      truncated: false,
    });
    const firstRead = readLiveCommandOutputSnapshot(key);
    const stableRead = readLiveCommandOutputSnapshot(key);

    hydrateLiveCommandOutputSnapshot(environmentId, {
      threadId,
      turnId: TurnId.make("turn-1"),
      toolCallId,
      updatedAt: "2026-01-01T00:00:02.000Z",
      text: "first patch\nsecond patch",
      truncated: false,
    });
    const secondRead = readLiveCommandOutputSnapshot(key);

    expect(stableRead).toBe(firstRead);
    expect(secondRead).not.toBe(firstRead);
    expect(secondRead).toMatchObject({
      text: "first patch\nsecond patch",
      version: 2,
    });
  });

  it("evicts inactive entries after retention", () => {
    const startedAt = Date.now();
    hydrateLiveCommandOutputSnapshot(environmentId, {
      threadId,
      turnId: TurnId.make("turn-1"),
      toolCallId,
      updatedAt: "2026-01-01T00:00:02.000Z",
      text: "retained briefly",
      truncated: false,
    });

    sweepLiveCommandOutputForTests(startedAt + 11 * 60_000);

    expect(
      readLiveCommandOutputSnapshot({
        environmentId,
        threadId,
        toolCallId,
      }).text,
    ).toBe("");
  });

  it("keeps more than the old live line preview limit", () => {
    const output = Array.from({ length: 2_100 }, (_, index) => `line ${index + 1}`).join("\n");

    appendLiveCommandOutputDelta(environmentId, {
      threadId,
      turnId: TurnId.make("turn-1"),
      toolCallId,
      chunkId: EventId.make("chunk-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      delta: output,
    });

    const snapshot = readLiveCommandOutputSnapshot({
      environmentId,
      threadId,
      toolCallId,
    });
    expect(snapshot.text.startsWith("line 1\nline 2")).toBe(true);
    expect(snapshot.text).toContain("line 2100");
    expect(snapshot.truncated).toBe(false);
  });
});
