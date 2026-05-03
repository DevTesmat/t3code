import { describe, expect, test } from "vitest";

import {
  buildFirstSyncRescueEvents,
  computeThreadUserSequenceHash,
  type HistorySyncEventRow,
} from "./historySync.ts";

const baseEvent = {
  occurredAt: "2026-01-01T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  actorKind: "user",
  metadataJson: "{}",
} as const;

function event(
  sequence: number,
  streamId: string,
  eventType: HistorySyncEventRow["eventType"],
  payload: Record<string, unknown>,
): HistorySyncEventRow {
  return {
    ...baseEvent,
    sequence,
    eventId: `${streamId}:${sequence}`,
    aggregateKind: eventType.startsWith("project.") ? "project" : "thread",
    streamId,
    streamVersion: sequence,
    eventType,
    payloadJson: JSON.stringify(payload),
  };
}

function projectCreated(sequence: number, projectId: string) {
  return event(sequence, projectId, "project.created", {
    projectId,
    title: projectId,
    workspaceRoot: `/tmp/${projectId}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: baseEvent.occurredAt,
    updatedAt: baseEvent.occurredAt,
  });
}

function threadCreated(sequence: number, threadId: string, projectId = "project-a") {
  return event(sequence, threadId, "thread.created", {
    threadId,
    projectId,
    title: threadId,
    modelSelection: null,
    createdAt: baseEvent.occurredAt,
    updatedAt: baseEvent.occurredAt,
  });
}

function messageSent(
  sequence: number,
  threadId: string,
  text: string,
  role: "user" | "assistant" = "user",
  source: "user" | "harness" = "user",
) {
  return event(sequence, threadId, "thread.message-sent", {
    threadId,
    messageId: `${threadId}-message-${sequence}`,
    role,
    source,
    text,
    attachments: [],
    turnId: null,
    streaming: false,
    createdAt: baseEvent.occurredAt,
  });
}

describe("history sync first-sync rescue", () => {
  test("empty local install imports remote only by rescuing nothing", () => {
    const remote = [projectCreated(1, "project-a"), threadCreated(2, "remote-thread")];

    expect(buildFirstSyncRescueEvents([], remote)).toEqual([]);
  });

  test("whole user-message sequence hash ignores assistant and harness messages", () => {
    const thread = [
      threadCreated(1, "thread-a"),
      messageSent(2, "thread-a", "  hello\r\nworld  "),
      messageSent(3, "thread-a", "ignored assistant", "assistant"),
      messageSent(4, "thread-a", "ignored harness", "user", "harness"),
    ];
    const sameUserSequence = [
      threadCreated(1, "thread-b"),
      messageSent(2, "thread-b", "hello\nworld"),
    ];

    expect(computeThreadUserSequenceHash(thread)).toBe(
      computeThreadUserSequenceHash(sameUserSequence),
    );
  });

  test("existing install rescues local-only threads after the remote sequence", () => {
    const local = [
      projectCreated(1, "project-a"),
      threadCreated(2, "local-thread"),
      messageSent(3, "local-thread", "local only"),
    ];
    const remote = [
      projectCreated(10, "project-a"),
      threadCreated(11, "remote-thread"),
      messageSent(12, "remote-thread", "remote"),
    ];

    const rescued = buildFirstSyncRescueEvents(local, remote);

    expect(rescued.map((event) => event.streamId)).toEqual(["local-thread", "local-thread"]);
    expect(rescued.map((event) => event.sequence)).toEqual([13, 14]);
  });

  test("matching user-message sequence hash does not duplicate a local thread", () => {
    const local = [threadCreated(1, "local-thread"), messageSent(2, "local-thread", "same chat")];
    const remote = [
      threadCreated(10, "remote-thread"),
      messageSent(11, "remote-thread", "same chat"),
    ];

    expect(buildFirstSyncRescueEvents(local, remote)).toEqual([]);
  });

  test("thread id collision with different hash is rescued under a new thread id", () => {
    const local = [threadCreated(1, "thread-a"), messageSent(2, "thread-a", "local")];
    const remote = [threadCreated(10, "thread-a"), messageSent(11, "thread-a", "remote")];

    const rescued = buildFirstSyncRescueEvents(local, remote);
    const rescuedStreamIds = new Set(rescued.map((event) => event.streamId));

    expect(rescuedStreamIds.size).toBe(1);
    const [rescuedThreadId] = [...rescuedStreamIds];
    expect(rescuedThreadId).toBeDefined();
    if (!rescuedThreadId) throw new Error("expected rescued thread id");
    expect(rescuedThreadId).toMatch(/^rescued-/);
    expect(rescued.every((event) => event.payloadJson.includes(rescuedThreadId))).toBe(true);
  });
});
