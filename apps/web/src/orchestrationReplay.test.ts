import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { replayAllOrchestrationEvents } from "./orchestrationReplay";

function makeMessageEvent(
  sequence: number,
): Extract<OrchestrationEvent, { type: "thread.message-sent" }> {
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: "2026-04-05T00:00:00.000Z",
    commandId: CommandId.make(`cmd-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.message-sent",
    payload: {
      threadId: ThreadId.make("thread-1"),
      messageId: MessageId.make(`message-${sequence}`),
      turnId: null,
      role: "user",
      source: "user",
      text: `message ${sequence}`,
      streaming: false,
      createdAt: "2026-04-05T00:00:00.000Z",
      updatedAt: "2026-04-05T00:00:00.000Z",
    },
  };
}

describe("replayAllOrchestrationEvents", () => {
  it("replays pages until the server reports completion", async () => {
    const replayEvents = vi
      .fn()
      .mockResolvedValueOnce({
        events: [makeMessageEvent(4), makeMessageEvent(5)],
        nextSequence: 5,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        events: [makeMessageEvent(6)],
        nextSequence: 6,
        hasMore: false,
      });

    const events = await replayAllOrchestrationEvents(
      { replayEvents },
      { fromSequenceExclusive: 3 },
    );

    expect(replayEvents).toHaveBeenNthCalledWith(1, { fromSequenceExclusive: 3 });
    expect(replayEvents).toHaveBeenNthCalledWith(2, { fromSequenceExclusive: 5 });
    expect(events.map((event) => event.sequence)).toEqual([4, 5, 6]);
  });

  it("stops on an empty final page", async () => {
    const replayEvents = vi.fn().mockResolvedValueOnce({
      events: [],
      nextSequence: 3,
      hasMore: false,
    });

    await expect(
      replayAllOrchestrationEvents({ replayEvents }, { fromSequenceExclusive: 3 }),
    ).resolves.toEqual([]);
    expect(replayEvents).toHaveBeenCalledOnce();
  });

  it("rejects a continuation page that does not advance the cursor", async () => {
    const replayEvents = vi.fn().mockResolvedValueOnce({
      events: [makeMessageEvent(4)],
      nextSequence: 3,
      hasMore: true,
    });

    await expect(
      replayAllOrchestrationEvents({ replayEvents }, { fromSequenceExclusive: 3 }),
    ).rejects.toThrow("Replay cursor did not advance.");
  });
});
