import { describe, expect, test } from "vitest";

import {
  buildFirstSyncClientMergeEvents,
  buildPushedEventReceiptRows,
  classifyAutosyncThreadStates,
  countActiveThreadCreates,
  filterPushableLocalEvents,
  filterAlreadyImportedRemoteDeltaEvents,
  isRemoteBehindLocal,
  planAutosaveLocalPush,
  planAutosaveRemoteCoveredReceipts,
  planAutosaveRemoteDelta,
  planFirstSync,
  planLocalCommitAfterRemoteWrite,
  planFirstSyncRecovery,
  planLocalReplacementFromRemote,
  rewriteRemoteEventsForLocalMappings,
  selectAutosaveCandidateLocalEvents,
  selectAutosaveContiguousPushableEvents,
  selectPushedReceiptSeedEvents,
  selectRemoteCoveredLocalEvents,
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

function checkpointCaptured(sequence: number, threadId: string, turnId: string) {
  return event(sequence, threadId, "thread.activity-appended", {
    threadId,
    activity: {
      id: `${threadId}-checkpoint-${sequence}`,
      tone: "info",
      kind: "checkpoint.captured",
      summary: "Checkpoint captured",
      payload: {
        turnCount: 1,
        status: "ready",
      },
      turnId,
      createdAt: baseEvent.occurredAt,
    },
  });
}

function sessionSet(
  sequence: number,
  threadId: string,
  status: "starting" | "running" | "ready" | "stopped" | "interrupted" | "error",
  activeTurnId: string | null,
) {
  return event(sequence, threadId, "thread.session-set", {
    threadId,
    session: {
      threadId,
      status,
      providerName: "codex",
      providerInstanceId: "codex",
      runtimeMode: "full-access",
      activeTurnId,
      lastError: null,
      updatedAt: baseEvent.occurredAt,
    },
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

  test("first sync planner selects local push, remote import, and recovery decisions", () => {
    const local = [projectCreated(1, "project-a"), threadCreated(2, "thread-a")];
    const remote = [projectCreated(1, "project-remote")];

    expect(
      planFirstSync({
        localEvents: local,
        localEventsForRemote: local,
        remoteEvents: [],
        remoteEventsForLocal: [],
        remoteMaxSequence: 0,
        projectMappings: [],
      }),
    ).toMatchObject({
      action: "local-push",
      pushEvents: local,
      receiptEvents: local,
      nextRemoteSequence: 2,
    });

    expect(
      planFirstSync({
        localEvents: local,
        localEventsForRemote: local,
        remoteEvents: remote,
        remoteEventsForLocal: remote,
        remoteMaxSequence: 1,
        projectMappings: [],
      }),
    ).toMatchObject({
      action: "remote-import",
      importedEvents: expect.arrayContaining(remote),
      nextRemoteSequence: 3,
    });

    expect(
      planFirstSync({
        initialSyncPhase: "backup",
        localEvents: local,
        localEventsForRemote: local,
        remoteEvents: remote,
        remoteEventsForLocal: remote,
        remoteMaxSequence: 1,
        projectMappings: [],
      }),
    ).toMatchObject({
      action: "remote-import",
      importedEvents: expect.arrayContaining(remote),
    });
  });

  test("first sync recovery continues local push when remote is still empty", () => {
    const local = [projectCreated(1, "project-a"), threadCreated(2, "thread-a")];

    expect(
      planFirstSyncRecovery({
        phase: "push-local",
        localEvents: local,
        localEventsForRemote: local,
        remoteEvents: [],
        remoteEventsForLocal: [],
        remoteMaxSequence: 0,
        mergeEventsForLocal: [],
        mergeEventsForRemote: [],
      }),
    ).toMatchObject({
      action: "continue-local-push",
      pushEvents: local,
      receiptEvents: local,
      nextRemoteSequence: 2,
    });
  });

  test("first sync recovery restarts when interrupted during backup", () => {
    const local = [projectCreated(1, "project-a")];
    const remote = [projectCreated(1, "project-remote")];

    expect(
      planFirstSyncRecovery({
        phase: "backup",
        localEvents: local,
        localEventsForRemote: local,
        remoteEvents: remote,
        remoteEventsForLocal: remote,
        remoteMaxSequence: 1,
        mergeEventsForLocal: [],
        mergeEventsForRemote: [],
      }),
    ).toEqual({
      action: "restart",
      reason: "Initial sync stopped before remote or local history was changed.",
    });
  });

  test("first sync recovery finishes state when local push is already remote-covered", () => {
    const local = [projectCreated(1, "project-a"), threadCreated(2, "thread-a")];

    expect(
      planFirstSyncRecovery({
        phase: "push-local",
        localEvents: local,
        localEventsForRemote: local,
        remoteEvents: local,
        remoteEventsForLocal: local,
        remoteMaxSequence: 2,
        mergeEventsForLocal: [],
        mergeEventsForRemote: [],
      }),
    ).toMatchObject({
      action: "finish-state",
      receiptEvents: local,
      nextRemoteSequence: 2,
    });
  });

  test("first sync recovery imports when pushed merge events are already remote-covered", () => {
    const remoteBase = [projectCreated(1, "project-remote")];
    const mergeEvents = [projectCreated(2, "project-local"), threadCreated(3, "thread-local")];
    const remoteEvents = [...remoteBase, ...mergeEvents];

    expect(
      planFirstSyncRecovery({
        phase: "import-remote",
        localEvents: mergeEvents,
        localEventsForRemote: mergeEvents,
        remoteEvents,
        remoteEventsForLocal: remoteEvents,
        remoteMaxSequence: 3,
        mergeEventsForLocal: mergeEvents,
        mergeEventsForRemote: mergeEvents,
      }),
    ).toMatchObject({
      action: "continue-remote-import",
      pushEvents: [],
      importedEvents: remoteEvents,
      nextRemoteSequence: 3,
    });
  });

  test("first sync recovery uses mapped remote projects and filters skipped projects", () => {
    const local = [projectCreated(1, "local-keep"), threadCreated(2, "thread-local", "local-keep")];
    const remote = [
      projectCreated(1, "remote-keep"),
      threadCreated(2, "thread-keep", "remote-keep"),
      projectCreated(3, "remote-skip"),
      threadCreated(4, "thread-skip", "remote-skip"),
    ];
    const remoteForLocal = rewriteRemoteEventsForLocalMappings(remote, [
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
    const mergeForLocal = [projectCreated(5, "local-merge")];
    const mergeForRemote = [projectCreated(5, "remote-merge")];

    expect(
      planFirstSyncRecovery({
        phase: "import-remote",
        localEvents: local,
        localEventsForRemote: local,
        remoteEvents: [...remote, ...mergeForRemote],
        remoteEventsForLocal: remoteForLocal,
        remoteMaxSequence: 5,
        mergeEventsForLocal: mergeForLocal,
        mergeEventsForRemote: mergeForRemote,
      }),
    ).toMatchObject({
      action: "continue-remote-import",
      pushEvents: [],
      importedEvents: remoteForLocal,
      receiptEvents: remoteForLocal,
      nextRemoteSequence: 5,
    });
    expect(remoteForLocal.map((row) => row.streamId)).toEqual(["local-keep", "thread-keep"]);
    expect(remoteForLocal.map((row) => JSON.parse(row.payloadJson).projectId)).toEqual([
      "local-keep",
      "local-keep",
    ]);
  });

  test("first sync recovery requires review for partial merge coverage", () => {
    const remoteBase = [projectCreated(1, "project-remote")];
    const mergeEvents = [projectCreated(2, "project-local"), threadCreated(3, "thread-local")];

    expect(
      planFirstSyncRecovery({
        phase: "push-merge",
        localEvents: mergeEvents,
        localEventsForRemote: mergeEvents,
        remoteEvents: [...remoteBase, mergeEvents[0]!],
        remoteEventsForLocal: [...remoteBase, mergeEvents[0]!],
        remoteMaxSequence: 2,
        mergeEventsForLocal: mergeEvents,
        mergeEventsForRemote: mergeEvents,
      }),
    ).toMatchObject({
      action: "require-review",
    });
  });

  test("first sync recovery requires review when merge involved thread collision rescue", () => {
    const local = [
      {
        ...threadCreated(1, "thread-collision", "project-local"),
        eventId: "local-thread-created",
      },
    ];
    const remoteBase = [
      {
        ...threadCreated(1, "thread-collision", "project-remote"),
        eventId: "remote-thread-created",
      },
    ];
    const mergeEvents = [
      {
        ...threadCreated(2, "thread-collision-rescued", "project-local"),
        eventId: "thread-collision:1:rescued:fixed",
      },
    ];

    expect(
      planFirstSyncRecovery({
        phase: "push-merge",
        localEvents: local,
        localEventsForRemote: local,
        remoteEvents: remoteBase,
        remoteEventsForLocal: remoteBase,
        remoteMaxSequence: 1,
        mergeEventsForLocal: mergeEvents,
        mergeEventsForRemote: mergeEvents,
      }),
    ).toMatchObject({
      action: "require-review",
      message:
        "Initial sync cannot safely resume because the failed merge involved thread ID collision rescue.",
    });
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

  test("plans local commit from remote-covered event IDs and freshly pushed events", () => {
    const local = [
      projectCreated(1, "project-a"),
      threadCreated(2, "thread-a"),
      messageSent(3, "thread-a", "hello"),
    ];
    const remote = [{ ...local[1]!, sequence: 10 }];

    expect(
      selectRemoteCoveredLocalEvents({
        localEvents: local,
        remoteEvents: remote,
      }),
    ).toEqual([local[1]]);

    expect(
      planLocalCommitAfterRemoteWrite({
        previousRemoteSequence: 1,
        remoteCoveredEvents: [local[1]!],
        pushedEvents: [local[2]!],
      }),
    ).toEqual({
      receiptEvents: [local[1], local[2]],
      lastSyncedRemoteSequence: 3,
    });
  });

  test("local commit plan does not advance past partial proven coverage", () => {
    const local = [
      projectCreated(1, "project-a"),
      threadCreated(2, "thread-a"),
      messageSent(3, "thread-a", "hello"),
    ];

    expect(
      planLocalCommitAfterRemoteWrite({
        previousRemoteSequence: 1,
        remoteCoveredEvents: [local[2]!],
      }),
    ).toEqual({
      receiptEvents: [local[2]],
      lastSyncedRemoteSequence: 1,
    });
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

  test("autosave treats a settled no-diff text turn as completed after an observed active turn", () => {
    const local = [
      threadCreated(1, "thread-text"),
      messageSent(2, "thread-text", "write text"),
      turnStartRequested(3, "thread-text", "turn-text"),
      sessionSet(4, "thread-text", "ready", null),
      sessionSet(5, "thread-text", "running", "turn-text"),
      messageSent(6, "thread-text", "assistant text"),
      sessionSet(7, "thread-text", "ready", null),
    ];

    expect(
      planAutosaveLocalPush({
        localEvents: local,
        unpushedLocalEvents: local,
        remoteMaxSequence: 0,
        projectionThreadRows: [
          {
            threadId: "thread-text",
            pendingUserInputCount: 0,
            hasActionableProposedPlan: 0,
            latestTurnId: "turn-text",
            sessionStatus: "ready",
            sessionActiveTurnId: null,
          },
        ],
      }),
    ).toMatchObject({
      action: "push-local",
      candidateEvents: local,
      pushableEvents: local,
    });
    expect(filterPushableLocalEvents(local, local)).toEqual(local);
  });

  test("autosave can push checkpoint activity immediately after a remotely synced turn completion", () => {
    const previousCompletion = turnDiffCompleted(1, "thread-done", "turn-done");
    const pendingCheckpoint = checkpointCaptured(2, "thread-done", "turn-done");

    expect(
      planAutosaveLocalPush({
        localEvents: [previousCompletion, pendingCheckpoint],
        unpushedLocalEvents: [pendingCheckpoint],
        remoteMaxSequence: 1,
        projectionThreadRows: [
          {
            threadId: "thread-done",
            pendingUserInputCount: 0,
            hasActionableProposedPlan: 0,
            latestTurnId: "turn-done",
            sessionStatus: "ready",
            sessionActiveTurnId: null,
          },
        ],
      }),
    ).toMatchObject({
      action: "push-local",
      candidateEvents: [pendingCheckpoint],
      pushableEvents: [pendingCheckpoint],
    });
  });

  test("autosave keeps a no-diff text turn deferred while the session is still active", () => {
    const local = [
      threadCreated(1, "thread-running"),
      messageSent(2, "thread-running", "write text"),
      turnStartRequested(3, "thread-running", "turn-running"),
      sessionSet(4, "thread-running", "running", "turn-running"),
      messageSent(5, "thread-running", "assistant text"),
    ];

    expect(
      planAutosaveLocalPush({
        localEvents: local,
        unpushedLocalEvents: local,
        remoteMaxSequence: 0,
        projectionThreadRows: [
          {
            threadId: "thread-running",
            pendingUserInputCount: 0,
            hasActionableProposedPlan: 0,
            latestTurnId: "turn-running",
            sessionStatus: "running",
            sessionActiveTurnId: "turn-running",
          },
        ],
      }),
    ).toEqual({ action: "idle" });
  });

  test("autosave planner separates remote conflict, covered receipts, and local push decisions", () => {
    const local = [threadCreated(1, "thread-done"), turnDiffCompleted(2, "thread-done", "turn")];
    const remoteDelta = [{ ...local[1]!, sequence: 3 }];
    const unknownRemoteDelta = [messageSent(4, "thread-remote", "remote")];

    expect(
      planAutosaveRemoteDelta({
        remoteDeltaEvents: remoteDelta,
        localEvents: local,
      }),
    ).toEqual({
      action: "accept-remote-delta",
      remoteCoveredEvents: [local[1]],
    });
    expect(
      planAutosaveRemoteDelta({
        remoteDeltaEvents: unknownRemoteDelta,
        localEvents: local,
      }),
    ).toMatchObject({
      action: "remote-conflict",
      unknownRemoteDeltaEvents: unknownRemoteDelta,
    });
    expect(
      planAutosaveRemoteCoveredReceipts({
        unpushedLocalEvents: local,
        remoteMaxSequence: 1,
      }),
    ).toEqual([local[0]]);
    expect(
      planAutosaveLocalPush({
        localEvents: local,
        unpushedLocalEvents: local,
        remoteMaxSequence: 0,
        projectionThreadRows: [
          {
            threadId: "thread-done",
            pendingUserInputCount: 0,
            hasActionableProposedPlan: 0,
            latestTurnId: null,
            sessionStatus: "ready",
            sessionActiveTurnId: null,
          },
        ],
      }),
    ).toMatchObject({
      action: "push-local",
      candidateEvents: local,
      pushableEvents: local,
    });
  });

  test.each([
    [
      "local-events-empty",
      {
        hasCompletedInitialSync: true,
        localEventCount: 0,
        localProjectionCount: 2,
        localProjectProjectionCount: 1,
        localThreadProjectionCount: 1,
        remoteEventCount: 1,
      },
    ],
    [
      "local-projections-empty",
      {
        hasCompletedInitialSync: true,
        localEventCount: 1,
        localProjectionCount: 0,
        localProjectProjectionCount: 0,
        localThreadProjectionCount: 0,
        remoteEventCount: 1,
      },
    ],
    [
      "missing-project-projections",
      {
        hasCompletedInitialSync: true,
        localEventCount: 1,
        localProjectionCount: 1,
        localProjectProjectionCount: 0,
        localThreadProjectionCount: 1,
        remoteEventCount: 1,
        remoteProjectCount: 1,
      },
    ],
    [
      "remote-has-more-active-threads",
      {
        hasCompletedInitialSync: true,
        localEventCount: 1,
        localProjectionCount: 2,
        localProjectProjectionCount: 1,
        localThreadProjectionCount: 1,
        remoteEventCount: 1,
        remoteActiveThreadCount: 2,
      },
    ],
  ] as const)("plans local replacement when reason is %s", (reason, input) => {
    expect(planLocalReplacementFromRemote(input)).toEqual({
      shouldReplace: true,
      reason,
    });
  });

  test.each([
    [
      "initial sync incomplete",
      {
        hasCompletedInitialSync: false,
        localEventCount: 0,
        remoteEventCount: 1,
      },
    ],
    [
      "remote has no events",
      {
        hasCompletedInitialSync: true,
        localEventCount: 0,
        remoteEventCount: 0,
      },
    ],
    [
      "local projections are healthy",
      {
        hasCompletedInitialSync: true,
        localEventCount: 2,
        localProjectionCount: 2,
        localProjectProjectionCount: 1,
        localThreadProjectionCount: 1,
        remoteEventCount: 2,
        remoteProjectCount: 1,
        remoteActiveThreadCount: 1,
      },
    ],
    [
      "remote active thread count does not exceed local projections",
      {
        hasCompletedInitialSync: true,
        localEventCount: 2,
        localProjectionCount: 2,
        localProjectProjectionCount: 1,
        localThreadProjectionCount: 2,
        remoteEventCount: 2,
        remoteActiveThreadCount: 2,
      },
    ],
  ] as const)("does not plan local replacement when %s", (_name, input) => {
    expect(planLocalReplacementFromRemote(input)).toEqual({
      shouldReplace: false,
      reason: null,
    });
  });
});
