import { describe, expect, test } from "vitest";

import {
  buildFirstSyncRescueEvents,
  buildFirstSyncClientMergeEvents,
  chunkHistorySyncEvents,
  collectProjectCandidates,
  countActiveThreadCreates,
  computeThreadUserSequenceHash,
  isRemoteBehindLocal,
  normalizeRemoteEventForLocalImport,
  rewriteRemoteEventsForLocalMappings,
  selectRemoteBehindLocalEvents,
  shouldRunAutomaticHistorySync,
  shouldImportRemoteIntoEmptyLocal,
  shouldPushLocalHistoryOnFirstSync,
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
