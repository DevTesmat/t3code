import { describe, expect, test } from "vitest";

import {
  buildFirstSyncClientMergeEvents,
  buildPushedEventReceiptRows,
  classifyAutosyncThreadStates,
  countActiveThreadCreates,
  filterAlreadyImportedRemoteDeltaEvents,
  isRemoteBehindLocal,
  rewriteRemoteEventsForLocalMappings,
  selectAutosaveCandidateLocalEvents,
  selectAutosaveContiguousPushableEvents,
  selectPushedReceiptSeedEvents,
  selectRemoteBehindLocalEvents,
  selectRemoteDeltaEvents,
  type HistorySyncEventRow,
} from "./planner.ts";

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

function messageSent(sequence: number, threadId: string, text: string) {
  return event(sequence, threadId, "thread.message-sent", {
    threadId,
    messageId: `${threadId}-message-${sequence}`,
    role: "user",
    source: "user",
    text,
    attachments: [],
    turnId: null,
    streaming: false,
    createdAt: baseEvent.occurredAt,
  });
}

function turnStartRequested(sequence: number, threadId: string, turnId: string) {
  return event(sequence, threadId, "thread.turn-start-requested", {
    threadId,
    messageId: `${threadId}-message-${sequence}`,
    turnId,
    createdAt: baseEvent.occurredAt,
  });
}

function turnDiffCompleted(sequence: number, threadId: string, turnId: string) {
  return event(sequence, threadId, "thread.turn-diff-completed", {
    threadId,
    turnId,
    status: "ready",
    files: [],
    completedAt: baseEvent.occurredAt,
  });
}

describe("history sync planner", () => {
  test("selects remote deltas and filters rows already imported at the same sequence", () => {
    const alreadyImported = messageSent(3, "thread-a", "remote");
    const project = projectCreated(1, "project-a");
    const thread = threadCreated(2, "thread-a");
    const remote = [project, thread, alreadyImported];
    const local = [project, thread, alreadyImported];

    expect(selectRemoteDeltaEvents(remote, 1).map((row) => row.sequence)).toEqual([2, 3]);
    expect(filterAlreadyImportedRemoteDeltaEvents(remote, local)).toEqual([]);
  });

  test("rewrites mapped projects and filters skipped remote projects with their threads", () => {
    const remote = [
      projectCreated(1, "remote-keep"),
      threadCreated(2, "thread-keep", "remote-keep"),
      projectCreated(3, "remote-skip"),
      threadCreated(4, "thread-skip", "remote-skip"),
    ];

    const rewritten = rewriteRemoteEventsForLocalMappings(remote, [
      {
        remoteProjectId: "remote-keep",
        localProjectId: "local-keep",
        localWorkspaceRoot: "/tmp/local-keep",
        status: "mapped",
      },
      {
        remoteProjectId: "remote-skip",
        localProjectId: "local-skip",
        localWorkspaceRoot: "/tmp/local-skip",
        status: "skipped",
      },
    ]);

    expect(rewritten.map((row) => row.streamId)).toEqual(["local-keep", "thread-keep"]);
    expect(rewritten.map((row) => JSON.parse(row.payloadJson).projectId)).toEqual([
      "local-keep",
      "local-keep",
    ]);
  });

  test("first sync client merge appends local client rows after imported remote rows", () => {
    const merged = buildFirstSyncClientMergeEvents(
      [projectCreated(1, "project-local"), threadCreated(2, "thread-local", "project-local")],
      [projectCreated(1, "project-remote"), threadCreated(2, "thread-remote", "project-remote")],
    );

    expect(merged.map((row) => row.sequence)).toEqual([3, 4]);
    expect(merged.map((row) => row.streamId)).toEqual(["project-local", "thread-local"]);
  });

  test("receipts seed through the synced cursor and repair picks local rows beyond remote max", () => {
    const local = [projectCreated(1, "project-a"), threadCreated(2, "thread-a")];

    expect(
      selectPushedReceiptSeedEvents({
        events: local,
        hasCompletedInitialSync: true,
        hasExistingReceipts: false,
        lastSyncedRemoteSequence: 1,
      }).map((row) => row.sequence),
    ).toEqual([1]);
    expect(buildPushedEventReceiptRows(local, baseEvent.occurredAt)).toHaveLength(2);
    expect(
      isRemoteBehindLocal({
        hasCompletedInitialSync: true,
        localMaxSequence: 2,
        remoteMaxSequence: 1,
        lastSyncedRemoteSequence: 2,
      }),
    ).toBe(true);
    expect(selectRemoteBehindLocalEvents(local, 1).map((row) => row.sequence)).toEqual([2]);
  });

  test("autosave stops at the first ineligible thread and does not leapfrog later events", () => {
    const local = [
      threadCreated(1, "thread-working"),
      turnStartRequested(2, "thread-working", "turn-working"),
      threadCreated(3, "thread-done"),
      turnStartRequested(4, "thread-done", "turn-done"),
      turnDiffCompleted(5, "thread-done", "turn-done"),
    ];
    const candidates = selectAutosaveCandidateLocalEvents({
      localEvents: local,
      unpushedLocalEvents: local,
      remoteMaxSequence: 0,
    });

    expect(
      selectAutosaveContiguousPushableEvents({
        candidateEvents: candidates,
        threadStates: classifyAutosyncThreadStates(local),
      }),
    ).toEqual([]);
    expect(countActiveThreadCreates(local)).toBe(2);
  });
});
