import { describe, expect, test } from "vitest";

import type { OrchestrationEvent } from "@t3tools/contracts";

import {
  buildFirstSyncRescueEvents,
  buildPushedEventReceiptRows,
  buildFirstSyncClientMergeEvents,
  chunkHistorySyncEvents,
  classifyAutosyncThreadStates,
  collectProjectCandidates,
  countActiveThreadCreates,
  computeThreadUserSequenceHash,
  filterAlreadyImportedRemoteDeltaEvents,
  filterPushableLocalEvents,
  filterUnpushedLocalEvents,
  isAutosyncEligibleThread,
  isRemoteBehindLocal,
  maxHistoryEventSequence,
  nextSyncedRemoteSequenceAfterPush,
  normalizeRemoteEventForLocalImport,
  rewriteRemoteEventsForLocalMappings,
  selectAutosaveCandidateLocalEvents,
  selectAutosaveContiguousPushableEvents,
  selectAutosaveRemoteCoveredReceiptEvents,
  selectKnownRemoteDeltaLocalEvents,
  selectRemoteDeltaEvents,
  selectRemoteBehindLocalEvents,
  selectPushedReceiptSeedEvents,
  selectUnknownRemoteDeltaEvents,
  shouldScheduleAutosaveForDomainEvent,
  shouldRunAutomaticHistorySync,
  shouldImportRemoteIntoEmptyLocal,
  shouldPushLocalHistoryOnFirstSync,
  type HistorySyncEventRow,
} from "./historySync/planner.ts";
import { isRetryableHistorySyncConnectionFailure } from "./historySync/remoteStore.ts";
import { nextHistorySyncRetryDelayMs } from "./historySync/syncRunner.ts";

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

function domainEvent(
  sequence: number,
  streamId: string,
  type: OrchestrationEvent["type"],
  payload: Record<string, unknown>,
): OrchestrationEvent {
  return {
    ...baseEvent,
    sequence,
    eventId: `${streamId}:${sequence}`,
    aggregateKind: type.startsWith("project.") ? "project" : "thread",
    aggregateId: streamId,
    type,
    payload,
    metadata: {},
  } as unknown as OrchestrationEvent;
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

function turnStartRequested(sequence: number, threadId: string, turnId: string) {
  return event(sequence, threadId, "thread.turn-start-requested", {
    threadId,
    messageId: `${threadId}-message-${sequence}`,
    turnId,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: baseEvent.occurredAt,
  });
}

function turnDiffCompleted(
  sequence: number,
  threadId: string,
  turnId: string,
  status: "ready" | "missing" | "error" = "ready",
) {
  return event(sequence, threadId, "thread.turn-diff-completed", {
    threadId,
    turnId,
    checkpointTurnCount: 1,
    checkpointRef: `${threadId}-checkpoint-${sequence}`,
    status,
    files: [],
    assistantMessageId: null,
    completedAt: baseEvent.occurredAt,
  });
}

function projectionThreadRow(
  threadId: string,
  options: {
    readonly pendingUserInputCount?: number;
    readonly hasActionableProposedPlan?: boolean;
    readonly latestTurnId?: string | null;
  } = {},
) {
  return {
    threadId,
    pendingUserInputCount: options.pendingUserInputCount ?? 0,
    hasActionableProposedPlan: options.hasActionableProposedPlan ? 1 : 0,
    latestTurnId: options.latestTurnId ?? null,
    sessionStatus: null,
    sessionActiveTurnId: null,
  };
}

describe("history sync first-sync rescue", () => {
  test("computes max event sequence without spreading large arrays", () => {
    const events = Array.from({ length: 150_000 }, (_, index) =>
      event(index + 1, "thread-large", "thread.message-sent", {
        threadId: "thread-large",
      }),
    );

    expect(maxHistoryEventSequence(events)).toBe(150_000);
    expect(nextSyncedRemoteSequenceAfterPush(200_000, events)).toBe(200_000);
  });

  test("remote delta selection uses the last synced remote sequence", () => {
    const remote = [
      projectCreated(1, "project-a"),
      threadCreated(2, "thread-a"),
      messageSent(3, "thread-a", "remote"),
    ];

    expect(selectRemoteDeltaEvents(remote, 1).map((event) => event.sequence)).toEqual([2, 3]);
    expect(selectRemoteDeltaEvents(remote, 3)).toEqual([]);
  });

  test("remote delta import skips rows already present locally with the same event id", () => {
    const alreadyImported = messageSent(3, "thread-a", "remote");
    const remote = [alreadyImported, messageSent(4, "thread-a", "new remote")];
    const local = [projectCreated(1, "project-a"), threadCreated(2, "thread-a"), alreadyImported];

    expect(
      filterAlreadyImportedRemoteDeltaEvents(remote, local).map((event) => event.sequence),
    ).toEqual([4]);
  });

  test("unpushed local events exclude pushed receipts by sequence", () => {
    const local = [
      projectCreated(1, "project-a"),
      threadCreated(2, "thread-a"),
      messageSent(3, "thread-a", "local"),
    ];

    expect(
      filterUnpushedLocalEvents(local, new Set([1, 3])).map((event) => event.sequence),
    ).toEqual([2]);
  });

  test("running thread events are not pushable", () => {
    const local = [
      threadCreated(1, "thread-running"),
      turnStartRequested(2, "thread-running", "turn-1"),
      messageSent(3, "thread-running", "working"),
    ];

    expect(filterPushableLocalEvents(local).map((event) => event.sequence)).toEqual([]);
  });

  test("terminal thread events are pushable for ready missing and error checkpoint outcomes", () => {
    for (const status of ["ready", "missing", "error"] as const) {
      const local = [
        threadCreated(1, `thread-${status}`),
        turnStartRequested(2, `thread-${status}`, "turn-1"),
        turnDiffCompleted(3, `thread-${status}`, "turn-1", status),
      ];

      expect(filterPushableLocalEvents(local).map((event) => event.sequence)).toEqual([1, 2, 3]);
    }
  });

  test("active thread does not block completed unrelated thread", () => {
    const local = [
      threadCreated(1, "thread-running"),
      turnStartRequested(2, "thread-running", "turn-running"),
      threadCreated(3, "thread-done"),
      turnStartRequested(4, "thread-done", "turn-done"),
      turnDiffCompleted(5, "thread-done", "turn-done"),
    ];

    expect(filterPushableLocalEvents(local).map((event) => event.sequence)).toEqual([3, 4, 5]);
  });

  test("pushed receipt rows capture successfully pushed event identity", () => {
    const pushedAt = "2026-01-01T00:00:01.000Z";
    const rows = buildPushedEventReceiptRows(
      [threadCreated(2, "thread-a"), messageSent(3, "thread-a", "hello")],
      pushedAt,
    );

    expect(rows).toEqual([
      {
        sequence: 2,
        eventId: "thread-a:2",
        streamId: "thread-a",
        eventType: "thread.created",
        pushedAt,
      },
      {
        sequence: 3,
        eventId: "thread-a:3",
        streamId: "thread-a",
        eventType: "thread.message-sent",
        pushedAt,
      },
    ]);
  });

  test("completed migrated sync seeds receipts only through the old synced sequence cursor", () => {
    const local = [
      projectCreated(1, "project-a"),
      threadCreated(2, "thread-a"),
      messageSent(3, "thread-a", "already synced"),
      messageSent(4, "thread-a", "new local"),
    ];

    expect(
      selectPushedReceiptSeedEvents({
        events: local,
        hasCompletedInitialSync: true,
        hasExistingReceipts: false,
        lastSyncedRemoteSequence: 3,
      }).map((event) => event.sequence),
    ).toEqual([1, 2, 3]);
  });

  test("receipt seeding is skipped before initial sync or after receipts exist", () => {
    const local = [projectCreated(1, "project-a")];

    expect(
      selectPushedReceiptSeedEvents({
        events: local,
        hasCompletedInitialSync: false,
        hasExistingReceipts: false,
        lastSyncedRemoteSequence: 1,
      }),
    ).toEqual([]);
    expect(
      selectPushedReceiptSeedEvents({
        events: local,
        hasCompletedInitialSync: true,
        hasExistingReceipts: true,
        lastSyncedRemoteSequence: 1,
      }),
    ).toEqual([]);
  });

  test("startup automation waits for explicit initial sync", () => {
    expect(
      shouldRunAutomaticHistorySync({
        enabled: true,
        configured: true,
        hasCompletedInitialSync: false,
      }),
    ).toBe(false);
  });

  test("startup automation runs after initial sync completes", () => {
    expect(
      shouldRunAutomaticHistorySync({
        enabled: true,
        configured: true,
        hasCompletedInitialSync: true,
      }),
    ).toBe(true);
  });

  test("empty local install imports remote only by rescuing nothing", () => {
    const remote = [projectCreated(1, "project-a"), threadCreated(2, "remote-thread")];

    expect(buildFirstSyncRescueEvents([], remote)).toEqual([]);
  });

  test("completed sync reimports remote when the local event table is empty", () => {
    expect(
      shouldImportRemoteIntoEmptyLocal({
        hasCompletedInitialSync: true,
        localEventCount: 0,
        remoteEventCount: 2,
      }),
    ).toBe(true);
  });

  test("completed sync reimports remote when projections are empty after an import attempt", () => {
    expect(
      shouldImportRemoteIntoEmptyLocal({
        hasCompletedInitialSync: true,
        localEventCount: 5,
        localProjectionCount: 0,
        remoteEventCount: 5,
      }),
    ).toBe(true);
  });

  test("completed sync reimports remote when thread projection is missing after partial import", () => {
    expect(
      shouldImportRemoteIntoEmptyLocal({
        hasCompletedInitialSync: true,
        localEventCount: 5,
        localProjectionCount: 1,
        localThreadProjectionCount: 0,
        remoteEventCount: 5,
        remoteActiveThreadCount: 1,
      }),
    ).toBe(true);
  });

  test("completed sync reimports remote when project projection is missing but remote has projects", () => {
    expect(
      shouldImportRemoteIntoEmptyLocal({
        hasCompletedInitialSync: true,
        localEventCount: 5,
        localProjectionCount: 9,
        localProjectProjectionCount: 0,
        localThreadProjectionCount: 9,
        remoteEventCount: 11,
        remoteProjectCount: 1,
        remoteActiveThreadCount: 5,
      }),
    ).toBe(true);
  });

  test("completed sync does not reimport when missing remote thread creates were deleted", () => {
    expect(
      shouldImportRemoteIntoEmptyLocal({
        hasCompletedInitialSync: true,
        localEventCount: 5,
        localProjectionCount: 6,
        localThreadProjectionCount: 5,
        remoteEventCount: 11,
        remoteActiveThreadCount: 5,
      }),
    ).toBe(false);
  });

  test("existing local install pushes local history directly when remote is empty", () => {
    const local = [
      projectCreated(1, "project-a"),
      threadCreated(2, "local-thread"),
      messageSent(3, "local-thread", "local only"),
    ];

    expect(
      shouldPushLocalHistoryOnFirstSync({
        hasCompletedInitialSync: false,
        localEventCount: local.length,
        remoteEventCount: 0,
      }),
    ).toBe(true);
    expect(buildFirstSyncRescueEvents(local, [])).toEqual(local);
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

  test("first sync client merge appends backed-up client threads after imported remote history", () => {
    const clientBackup = [
      projectCreated(1, "client-project"),
      threadCreated(2, "client-thread", "client-project"),
      messageSent(3, "client-thread", "client only"),
    ];
    const importedRemote = [
      projectCreated(10, "remote-project"),
      threadCreated(11, "remote-thread", "remote-project"),
      messageSent(12, "remote-thread", "remote"),
    ];

    const merged = buildFirstSyncClientMergeEvents(clientBackup, importedRemote);

    expect(merged.map((row) => row.streamId)).toEqual([
      "client-project",
      "client-thread",
      "client-thread",
    ]);
    expect(merged.map((row) => row.sequence)).toEqual([13, 14, 15]);
  });

  test("first sync client merge rewrites colliding client thread ids", () => {
    const clientBackup = [threadCreated(1, "thread-a"), messageSent(2, "thread-a", "client")];
    const importedRemote = [threadCreated(10, "thread-a"), messageSent(11, "thread-a", "remote")];

    const merged = buildFirstSyncClientMergeEvents(clientBackup, importedRemote);
    const mergedStreamIds = new Set(merged.map((event) => event.streamId));

    expect(mergedStreamIds.size).toBe(1);
    const [mergedThreadId] = [...mergedStreamIds];
    expect(mergedThreadId).toBeDefined();
    if (!mergedThreadId) throw new Error("expected merged thread id");
    expect(mergedThreadId).toMatch(/^rescued-/);
    expect(merged.every((event) => event.payloadJson.includes(mergedThreadId))).toBe(true);
  });

  test("first sync client merge keeps client threads under mapped projects", () => {
    const clientBackup = [
      projectCreated(1, "client-project"),
      threadCreated(2, "client-thread", "client-project"),
      messageSent(3, "client-thread", "client"),
    ];
    const importedRemote = [projectCreated(10, "remote-project")];

    const merged = buildFirstSyncClientMergeEvents(clientBackup, importedRemote, [
      {
        remoteProjectId: "remote-project",
        localProjectId: "client-project",
        remoteWorkspaceRoot: "/tmp/remote-project",
        status: "mapped",
      },
    ]);

    expect(merged.map((row) => row.streamId)).toEqual(["client-thread", "client-thread"]);
    expect(JSON.parse(merged[0]?.payloadJson ?? "{}")).toMatchObject({
      projectId: "remote-project",
    });
  });

  test("matching user-message sequence hash still keeps the local client thread", () => {
    const local = [threadCreated(1, "local-thread"), messageSent(2, "local-thread", "same chat")];
    const remote = [
      threadCreated(10, "remote-thread"),
      messageSent(11, "remote-thread", "same chat"),
    ];

    expect(buildFirstSyncRescueEvents(local, remote).map((event) => event.streamId)).toEqual([
      "local-thread",
      "local-thread",
    ]);
  });

  test("local projects are rescued so their client threads remain grouped together", () => {
    const local = [
      projectCreated(1, "project-a"),
      threadCreated(2, "local-thread", "project-a"),
      messageSent(3, "local-thread", "same chat"),
    ];
    const remote = [
      projectCreated(10, "project-b"),
      threadCreated(11, "remote-thread", "project-b"),
      messageSent(12, "remote-thread", "same chat"),
    ];

    const rescued = buildFirstSyncRescueEvents(local, remote);

    expect(rescued.map((event) => event.streamId)).toEqual([
      "project-a",
      "local-thread",
      "local-thread",
    ]);
  });

  test("rewrites mapped remote projects to the local project id and path", () => {
    const remote = [
      projectCreated(10, "remote-project"),
      threadCreated(11, "remote-thread", "remote-project"),
      messageSent(12, "remote-thread", "remote message"),
    ];

    const rewritten = rewriteRemoteEventsForLocalMappings(remote, [
      {
        remoteProjectId: "remote-project",
        localProjectId: "local-project",
        localWorkspaceRoot: "C:\\Dev\\Project",
        status: "mapped",
      },
    ]);

    expect(rewritten[0]?.streamId).toBe("local-project");
    expect(JSON.parse(rewritten[0]?.payloadJson ?? "{}")).toMatchObject({
      projectId: "local-project",
      workspaceRoot: "C:\\Dev\\Project",
    });
    expect(JSON.parse(rewritten[1]?.payloadJson ?? "{}")).toMatchObject({
      projectId: "local-project",
    });
  });

  test("drops mapped remote project deletions so mapped local project remains visible", () => {
    const remote = [
      projectCreated(10, "remote-project"),
      event(13, "remote-project", "project.deleted", {
        projectId: "remote-project",
        deletedAt: baseEvent.occurredAt,
      }),
      threadCreated(14, "remote-thread", "remote-project"),
    ];

    const rewritten = rewriteRemoteEventsForLocalMappings(remote, [
      {
        remoteProjectId: "remote-project",
        localProjectId: "local-project",
        localWorkspaceRoot: "C:\\Dev\\Project",
        status: "mapped",
      },
    ]);

    expect(rewritten.map((row) => row.eventType)).toEqual(["project.created", "thread.created"]);
  });

  test("normalizes legacy remote thread.created payloads before local import", () => {
    const legacy = event(11, "remote-thread", "thread.created", {
      threadId: "remote-thread",
      projectId: "remote-project",
      title: "Remote thread",
      model: "gpt-5.4",
      createdAt: baseEvent.occurredAt,
      updatedAt: baseEvent.occurredAt,
    });

    const normalized = normalizeRemoteEventForLocalImport(legacy);
    const payload = JSON.parse(normalized.payloadJson);

    expect(payload).toMatchObject({
      threadId: "remote-thread",
      projectId: "remote-project",
      title: "Remote thread",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
  });

  test("detects remote project candidates from thread ownership when project shell is missing", () => {
    const remote = [
      threadCreated(11, "remote-thread", "remote-project"),
      messageSent(12, "remote-thread", "remote message"),
    ];

    expect(collectProjectCandidates(remote)).toEqual([
      expect.objectContaining({
        projectId: "remote-project",
        title: "remote-project",
        workspaceRoot: "",
        threadCount: 1,
      }),
    ]);
  });

  test("keeps deleted remote project candidates when active threads still reference them", () => {
    const remote = [
      projectCreated(10, "remote-project"),
      event(11, "remote-project", "project.deleted", {
        projectId: "remote-project",
        deletedAt: baseEvent.occurredAt,
      }),
      threadCreated(12, "remote-thread", "remote-project"),
    ];

    expect(collectProjectCandidates(remote)).toEqual([
      expect.objectContaining({
        projectId: "remote-project",
        deleted: false,
        threadCount: 1,
      }),
    ]);
  });

  test("rewrites mapped project events by payload project id when the stream id differs", () => {
    const remoteProject = {
      ...projectCreated(10, "remote-project"),
      streamId: "project-stream-remote-project",
    };

    const [rewritten] = rewriteRemoteEventsForLocalMappings(
      [remoteProject],
      [
        {
          remoteProjectId: "remote-project",
          localProjectId: "local-project",
          localWorkspaceRoot: "C:\\Dev\\Project",
          status: "mapped",
        },
      ],
    );

    expect(rewritten?.streamId).toBe("local-project");
    expect(JSON.parse(rewritten?.payloadJson ?? "{}")).toMatchObject({
      projectId: "local-project",
      workspaceRoot: "C:\\Dev\\Project",
    });
  });

  test("skips remote projects and their threads when mapped as skipped", () => {
    const remote = [
      projectCreated(10, "remote-project"),
      threadCreated(11, "remote-thread", "remote-project"),
      messageSent(12, "remote-thread", "remote message"),
    ];

    expect(
      rewriteRemoteEventsForLocalMappings(remote, [
        {
          remoteProjectId: "remote-project",
          localProjectId: "remote-project",
          localWorkspaceRoot: "/Users/me/project",
          status: "skipped",
        },
      ]),
    ).toEqual([]);
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

  test("counts only non-deleted remote thread creates as active", () => {
    const remote = [
      threadCreated(1, "thread-a"),
      threadCreated(2, "thread-b"),
      event(3, "thread-b", "thread.deleted", {
        threadId: "thread-b",
        deletedAt: baseEvent.occurredAt,
      }),
    ];

    expect(countActiveThreadCreates(remote)).toBe(1);
  });
});

describe("history sync remote repair", () => {
  test("autosave scheduler ignores working-thread activity events", () => {
    expect(
      shouldScheduleAutosaveForDomainEvent(
        domainEvent(1, "thread-working", "thread.activity-appended", {
          threadId: "thread-working",
          activity: {
            id: "activity-1",
            tone: "neutral",
            kind: "tool.completed",
            summary: "Read file",
            payload: {},
            turnId: "turn-1",
            createdAt: baseEvent.occurredAt,
          },
        }),
      ),
    ).toBe(false);
  });

  test("autosave scheduler only accepts explicit settled-thread boundary events", () => {
    expect(
      shouldScheduleAutosaveForDomainEvent(
        domainEvent(1, "thread-done", "thread.turn-diff-completed", {
          threadId: "thread-done",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "checkpoint-1",
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: baseEvent.occurredAt,
        }),
      ),
    ).toBe(true);
    expect(
      shouldScheduleAutosaveForDomainEvent(
        domainEvent(2, "thread-plan", "thread.proposed-plan-upserted", {
          threadId: "thread-plan",
          proposedPlan: {
            id: "plan-1",
            turnId: "turn-1",
            planMarkdown: "# Plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: baseEvent.occurredAt,
            updatedAt: baseEvent.occurredAt,
          },
        }),
      ),
    ).toBe(true);
    expect(
      shouldScheduleAutosaveForDomainEvent(
        domainEvent(3, "thread-waiting", "thread.user-input-response-requested", {
          threadId: "thread-waiting",
          requestId: "request-1",
          answers: [],
          createdAt: baseEvent.occurredAt,
        }),
      ),
    ).toBe(true);
    expect(
      shouldScheduleAutosaveForDomainEvent(
        domainEvent(4, "thread-done", "thread.session-set", {
          threadId: "thread-done",
          session: {
            threadId: "thread-done",
            status: "stopped",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: baseEvent.occurredAt,
          },
        }),
      ),
    ).toBe(true);
  });

  test("autosave scheduler accepts ready session updates after active turn clears", () => {
    expect(
      shouldScheduleAutosaveForDomainEvent(
        domainEvent(1, "thread-ready", "thread.session-set", {
          threadId: "thread-ready",
          session: {
            threadId: "thread-ready",
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: baseEvent.occurredAt,
          },
        }),
      ),
    ).toBe(true);
  });

  test("autosave scheduler ignores ready session updates while a turn is still active", () => {
    expect(
      shouldScheduleAutosaveForDomainEvent(
        domainEvent(1, "thread-running", "thread.session-set", {
          threadId: "thread-running",
          session: {
            threadId: "thread-running",
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: "turn-1",
            lastError: null,
            updatedAt: baseEvent.occurredAt,
          },
        }),
      ),
    ).toBe(false);
  });

  test("autosave treats a completed turn with ready session as a finished thread", () => {
    const local = [
      threadCreated(1, "thread-ready"),
      turnStartRequested(2, "thread-ready", "turn-1"),
      turnDiffCompleted(3, "thread-ready", "turn-1"),
    ];
    const state = classifyAutosyncThreadStates(local, [
      {
        ...projectionThreadRow("thread-ready", { latestTurnId: "turn-1" }),
        sessionStatus: "ready",
        sessionActiveTurnId: null,
      },
    ]).get("thread-ready");

    expect(state).toBeDefined();
    if (!state) throw new Error("expected thread state");
    expect(isAutosyncEligibleThread(state)).toBe(true);
  });

  test("autosave waits for ready session to clear the completed active turn", () => {
    const local = [
      threadCreated(1, "thread-active"),
      turnStartRequested(2, "thread-active", "turn-1"),
      turnDiffCompleted(3, "thread-active", "turn-1"),
      event(4, "thread-active", "thread.session-set", {
        threadId: "thread-active",
        session: {
          threadId: "thread-active",
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: baseEvent.occurredAt,
        },
      }),
    ];
    const activeProjection = [
      {
        ...projectionThreadRow("thread-active", { latestTurnId: "turn-1" }),
        sessionStatus: "ready",
        sessionActiveTurnId: "turn-1",
      },
    ];
    const readyProjection = [
      {
        ...projectionThreadRow("thread-active", { latestTurnId: "turn-1" }),
        sessionStatus: "ready",
        sessionActiveTurnId: null,
      },
    ];

    expect(
      selectAutosaveContiguousPushableEvents({
        candidateEvents: local,
        threadStates: classifyAutosyncThreadStates(local, activeProjection),
      }).map((historyEvent) => historyEvent.sequence),
    ).toEqual([]);
    expect(
      selectAutosaveContiguousPushableEvents({
        candidateEvents: local,
        threadStates: classifyAutosyncThreadStates(local, readyProjection),
      }).map((historyEvent) => historyEvent.sequence),
    ).toEqual([1, 2, 3, 4]);
  });

  test("autosave does not push completed events while projection session is running", () => {
    const local = [
      threadCreated(1, "thread-running"),
      turnStartRequested(2, "thread-running", "turn-1"),
      turnDiffCompleted(3, "thread-running", "turn-1"),
    ];

    expect(
      selectAutosaveContiguousPushableEvents({
        candidateEvents: local,
        threadStates: classifyAutosyncThreadStates(local, [
          {
            ...projectionThreadRow("thread-running", { latestTurnId: "turn-1" }),
            sessionStatus: "running",
            sessionActiveTurnId: null,
          },
        ]),
      }),
    ).toEqual([]);
  });

  test("autosave marks terminal stopped threads as done", () => {
    const local = [
      threadCreated(1, "thread-done"),
      turnStartRequested(2, "thread-done", "turn-1"),
      turnDiffCompleted(3, "thread-done", "turn-1"),
    ];
    const state = classifyAutosyncThreadStates(local, [
      {
        ...projectionThreadRow("thread-done", { latestTurnId: "turn-1" }),
        sessionStatus: "stopped",
        sessionActiveTurnId: null,
      },
    ]).get("thread-done");

    expect(state).toBeDefined();
    if (!state) throw new Error("expected thread state");
    expect(isAutosyncEligibleThread(state)).toBe(true);
  });

  test("autosave marks working threads as ineligible", () => {
    const local = [
      threadCreated(1, "thread-working"),
      turnStartRequested(2, "thread-working", "turn-1"),
      messageSent(3, "thread-working", "working"),
    ];
    const state = classifyAutosyncThreadStates(local).get("thread-working");

    expect(state).toBeDefined();
    if (!state) throw new Error("expected thread state");
    expect(isAutosyncEligibleThread(state)).toBe(false);
  });

  test("autosave marks threads waiting for user input as eligible", () => {
    const local = [
      threadCreated(1, "thread-waiting"),
      turnStartRequested(2, "thread-waiting", "turn-1"),
      messageSent(3, "thread-waiting", "working"),
    ];
    const state = classifyAutosyncThreadStates(local, [
      projectionThreadRow("thread-waiting", {
        pendingUserInputCount: 1,
        latestTurnId: "turn-1",
      }),
    ]).get("thread-waiting");

    expect(state).toBeDefined();
    if (!state) throw new Error("expected thread state");
    expect(isAutosyncEligibleThread(state)).toBe(true);
  });

  test("autosave marks plan-ready threads as eligible", () => {
    const local = [
      threadCreated(1, "thread-plan"),
      turnStartRequested(2, "thread-plan", "turn-1"),
      messageSent(3, "thread-plan", "working"),
    ];
    const state = classifyAutosyncThreadStates(local, [
      projectionThreadRow("thread-plan", {
        hasActionableProposedPlan: true,
        latestTurnId: "turn-1",
      }),
    ]).get("thread-plan");

    expect(state).toBeDefined();
    if (!state) throw new Error("expected thread state");
    expect(isAutosyncEligibleThread(state)).toBe(true);
  });

  test("autosave pushes done thread events when no earlier unsafe events exist", () => {
    const local = [
      threadCreated(1, "thread-done"),
      turnStartRequested(2, "thread-done", "turn-1"),
      turnDiffCompleted(3, "thread-done", "turn-1"),
    ];
    const candidates = selectAutosaveCandidateLocalEvents({
      localEvents: local,
      unpushedLocalEvents: local,
      remoteMaxSequence: 0,
    });

    expect(
      selectAutosaveContiguousPushableEvents({
        candidateEvents: candidates,
        threadStates: classifyAutosyncThreadStates(local, [
          {
            ...projectionThreadRow("thread-done", { latestTurnId: "turn-1" }),
            sessionStatus: "stopped",
            sessionActiveTurnId: null,
          },
        ]),
      }).map((event) => event.sequence),
    ).toEqual([1, 2, 3]);
  });

  test("autosave does not push working thread events", () => {
    const local = [
      threadCreated(1, "thread-working"),
      turnStartRequested(2, "thread-working", "turn-1"),
      messageSent(3, "thread-working", "working"),
    ];
    const candidates = selectAutosaveCandidateLocalEvents({
      localEvents: local,
      unpushedLocalEvents: local,
      remoteMaxSequence: 0,
    });

    expect(
      selectAutosaveContiguousPushableEvents({
        candidateEvents: candidates,
        threadStates: classifyAutosyncThreadStates(local, [
          {
            ...projectionThreadRow("thread-done", { latestTurnId: "turn-2" }),
            sessionStatus: "stopped",
            sessionActiveTurnId: null,
          },
        ]),
      }),
    ).toEqual([]);
  });

  test("autosave does not let a later done thread leapfrog an earlier working thread", () => {
    const local = [
      threadCreated(1, "thread-working"),
      turnStartRequested(2, "thread-working", "turn-1"),
      threadCreated(3, "thread-done"),
      turnStartRequested(4, "thread-done", "turn-2"),
      turnDiffCompleted(5, "thread-done", "turn-2"),
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
  });

  test("autosave pushes a finished thread before later working-thread events", () => {
    const local = [
      threadCreated(1, "thread-done"),
      turnStartRequested(2, "thread-done", "turn-1"),
      turnDiffCompleted(3, "thread-done", "turn-1"),
      threadCreated(4, "thread-working"),
      turnStartRequested(5, "thread-working", "turn-2"),
    ];
    const candidates = selectAutosaveCandidateLocalEvents({
      localEvents: local,
      unpushedLocalEvents: local,
      remoteMaxSequence: 0,
    });

    expect(
      selectAutosaveContiguousPushableEvents({
        candidateEvents: candidates,
        threadStates: classifyAutosyncThreadStates(local, [
          {
            ...projectionThreadRow("thread-done", { latestTurnId: "turn-1" }),
            sessionStatus: "stopped",
            sessionActiveTurnId: null,
          },
        ]),
      }).map((event) => event.sequence),
    ).toEqual([1, 2, 3]);
  });

  test("autosave caps candidates at the event that scheduled the autosave", () => {
    const local = [
      threadCreated(1, "thread-plan"),
      turnStartRequested(2, "thread-plan", "turn-1"),
      messageSent(3, "thread-plan", "plan ready"),
      event(4, "thread-plan", "thread.proposed-plan-upserted", {
        threadId: "thread-plan",
        proposedPlan: {
          id: "plan-1",
          turnId: "turn-1",
          planMarkdown: "# Plan",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: baseEvent.occurredAt,
          updatedAt: baseEvent.occurredAt,
        },
      }),
      turnStartRequested(5, "thread-plan", "turn-2"),
      messageSent(6, "thread-plan", "implementing"),
    ];
    const candidates = selectAutosaveCandidateLocalEvents({
      localEvents: local,
      unpushedLocalEvents: local,
      remoteMaxSequence: 0,
      maxSequence: 4,
    });

    expect(candidates.map((candidate) => candidate.sequence)).toEqual([1, 2, 3, 4]);
    expect(
      selectAutosaveContiguousPushableEvents({
        candidateEvents: candidates,
        threadStates: classifyAutosyncThreadStates(local, [
          projectionThreadRow("thread-plan", {
            hasActionableProposedPlan: true,
            latestTurnId: "turn-2",
          }),
        ]),
      }).map((candidate) => candidate.sequence),
    ).toEqual([1, 2, 3, 4]);
  });

  test("autosave repairs remote when local has events beyond the remote max", () => {
    const local = [
      projectCreated(1, "project-a"),
      threadCreated(2, "thread-a"),
      messageSent(3, "thread-a", "missing remotely"),
      messageSent(4, "thread-a", "also missing remotely"),
    ];

    expect(
      selectAutosaveCandidateLocalEvents({
        localEvents: local,
        unpushedLocalEvents: [],
        remoteMaxSequence: 2,
      }).map((event) => event.sequence),
    ).toEqual([3, 4]);
  });

  test("autosave does not re-push unreceipted events already covered by the remote frontier", () => {
    const local = [
      projectCreated(1, "project-a"),
      threadCreated(2, "thread-a"),
      messageSent(3, "thread-a", "already remote"),
      messageSent(4, "thread-a", "new local"),
    ];

    expect(
      selectAutosaveCandidateLocalEvents({
        localEvents: local,
        unpushedLocalEvents: local,
        remoteMaxSequence: 3,
      }).map((event) => event.sequence),
    ).toEqual([4]);
    expect(
      selectAutosaveRemoteCoveredReceiptEvents({
        unpushedLocalEvents: local,
        remoteMaxSequence: 3,
      }).map((event) => event.sequence),
    ).toEqual([1, 2, 3]);
  });

  test("autosave recovers when a previous push wrote remote events before local receipts", () => {
    const local = [
      projectCreated(1, "project-a"),
      threadCreated(2, "thread-a"),
      messageSent(3, "thread-a", "already in remote"),
    ];
    const remoteDelta = [messageSent(3, "thread-a", "already in remote")];

    expect(
      selectUnknownRemoteDeltaEvents({
        remoteEvents: remoteDelta,
        localEvents: local,
      }),
    ).toEqual([]);
    expect(
      selectKnownRemoteDeltaLocalEvents({
        remoteEvents: remoteDelta,
        localEvents: local,
      }).map((event) => event.sequence),
    ).toEqual([3]);
  });

  test("autosave advances state when remote-ahead events are already present locally", () => {
    const local = [
      projectCreated(1, "project-a"),
      threadCreated(2, "thread-a"),
      messageSent(3, "thread-a", "known remote"),
    ];
    const remoteDelta = [messageSent(3, "thread-a", "known remote")];

    expect(
      selectKnownRemoteDeltaLocalEvents({
        remoteEvents: remoteDelta,
        localEvents: local,
      }).map((event) => event.eventId),
    ).toEqual(["thread-a:3"]);
    expect(nextSyncedRemoteSequenceAfterPush(2, remoteDelta)).toBe(3);
  });

  test("autosave refuses to push when remote has unknown newer events from another device", () => {
    const local = [projectCreated(1, "project-a"), threadCreated(2, "thread-a")];
    const remoteDelta = [messageSent(3, "thread-a", "other device")];

    expect(
      selectUnknownRemoteDeltaEvents({
        remoteEvents: remoteDelta,
        localEvents: local,
      }).map((event) => event.eventId),
    ).toEqual(["thread-a:3"]);
  });

  test("autosave still defers events for open turns while repairing a remote suffix", () => {
    const local = [
      threadCreated(1, "thread-running"),
      turnStartRequested(2, "thread-running", "turn-1"),
      messageSent(3, "thread-running", "working"),
    ];
    const candidates = selectAutosaveCandidateLocalEvents({
      localEvents: local,
      unpushedLocalEvents: [],
      remoteMaxSequence: 0,
    });

    expect(candidates.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(
      selectAutosaveContiguousPushableEvents({
        candidateEvents: candidates,
        threadStates: classifyAutosyncThreadStates(local),
      }).map((event) => event.sequence),
    ).toEqual([]);
  });

  test("advances the synced remote cursor after pushing local events", () => {
    const pushed = [
      messageSent(11, "thread-a", "first local"),
      messageSent(12, "thread-a", "second local"),
    ];

    expect(nextSyncedRemoteSequenceAfterPush(10, pushed)).toBe(12);
  });

  test("keeps the synced remote cursor unchanged when nothing was pushed", () => {
    expect(nextSyncedRemoteSequenceAfterPush(10, [])).toBe(10);
  });

  test("never moves the synced remote cursor backwards after a push", () => {
    const pushed = [messageSent(9, "thread-a", "already covered")];

    expect(nextSyncedRemoteSequenceAfterPush(10, pushed)).toBe(10);
  });

  test("detects a completed sync whose remote sequence fell behind local state", () => {
    expect(
      isRemoteBehindLocal({
        hasCompletedInitialSync: true,
        localMaxSequence: 10,
        remoteMaxSequence: 0,
        lastSyncedRemoteSequence: 10,
      }),
    ).toBe(true);
  });

  test("does not treat normal pending local history as remote repair", () => {
    expect(
      isRemoteBehindLocal({
        hasCompletedInitialSync: true,
        localMaxSequence: 11,
        remoteMaxSequence: 10,
        lastSyncedRemoteSequence: 10,
      }),
    ).toBe(false);
  });

  test("selects local rows after the remote max sequence for repair", () => {
    const local = [
      projectCreated(1, "project-a"),
      threadCreated(2, "thread-a"),
      messageSent(3, "thread-a", "first"),
      messageSent(4, "thread-a", "second"),
    ];

    expect(selectRemoteBehindLocalEvents(local, 2).map((event) => event.sequence)).toEqual([3, 4]);
  });
});

describe("history sync mysql batching", () => {
  test("splits event writes into deterministic batches", () => {
    const events = Array.from({ length: 5 }, (_, index) =>
      messageSent(index + 1, "thread-a", `message ${index + 1}`),
    );

    expect(
      chunkHistorySyncEvents(events, 2).map((batch) => batch.map((event) => event.sequence)),
    ).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("rejects invalid batch sizes", () => {
    expect(() => chunkHistorySyncEvents([], 0)).toThrow(
      "History sync batch size must be a positive integer.",
    );
  });
});

describe("history sync connection retry", () => {
  test("uses the expected retry ladder", () => {
    expect([1, 2, 3, 4, 5, 6].map(nextHistorySyncRetryDelayMs)).toEqual([
      10_000,
      180_000,
      600_000,
      600_000,
      600_000,
      null,
    ]);
  });

  test("classifies wrapped mysql connection failures as retryable", () => {
    const wrapped = {
      _tag: "HistorySyncMysqlError",
      cause: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
    };

    expect(isRetryableHistorySyncConnectionFailure(wrapped)).toBe(true);
    expect(
      isRetryableHistorySyncConnectionFailure(
        Object.assign(new Error("bad data"), { code: "ER_PARSE_ERROR" }),
      ),
    ).toBe(false);
    expect(isRetryableHistorySyncConnectionFailure(new Error("unknown remote events"))).toBe(false);
  });
});
