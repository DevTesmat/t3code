import type { HistorySyncStatus } from "@t3tools/contracts";
import { Effect, Ref } from "effect";
import { describe, expect, test } from "vitest";

import {
  createHistorySyncRunner,
  describeAutosaveRemoteConflict,
  HISTORY_SYNC_AUTOSAVE_REMOTE_CONFLICT_MESSAGE,
  nextHistorySyncRetryDelayMs,
  shouldRetryHistorySyncFailure,
  type HistorySyncRunnerDependencies,
} from "./syncRunner.ts";
import type { HistorySyncEventRow } from "./planner.ts";

const remoteEvent: HistorySyncEventRow = {
  sequence: 1,
  eventId: "event-1",
  aggregateKind: "project",
  streamId: "project-1",
  streamVersion: 1,
  eventType: "project.created",
  occurredAt: "2026-05-01T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  actorKind: "system",
  payloadJson: JSON.stringify({
    projectId: "project-1",
    title: "Project",
    workspaceRoot: "/repo",
  }),
  metadataJson: "{}",
};

const localEvent: HistorySyncEventRow = {
  ...remoteEvent,
  sequence: 2,
  eventId: "event-2",
  streamId: "project-2",
  payloadJson: JSON.stringify({
    projectId: "project-2",
    title: "Local project",
    workspaceRoot: "/local-repo",
  }),
};

function projectEvent(input: {
  readonly sequence: number;
  readonly projectId: string;
  readonly title?: string;
  readonly workspaceRoot?: string;
}): HistorySyncEventRow {
  return {
    ...remoteEvent,
    sequence: input.sequence,
    eventId: `${input.projectId}:${input.sequence}`,
    streamId: input.projectId,
    streamVersion: input.sequence,
    eventType: "project.created",
    aggregateKind: "project",
    payloadJson: JSON.stringify({
      projectId: input.projectId,
      title: input.title ?? input.projectId,
      workspaceRoot: input.workspaceRoot ?? `/${input.projectId}`,
    }),
  };
}

function threadCreatedEvent(input: {
  readonly sequence: number;
  readonly threadId: string;
  readonly projectId: string;
  readonly eventId?: string;
}): HistorySyncEventRow {
  return {
    ...remoteEvent,
    sequence: input.sequence,
    eventId: input.eventId ?? `${input.threadId}:${input.sequence}`,
    aggregateKind: "thread",
    streamId: input.threadId,
    streamVersion: input.sequence,
    eventType: "thread.created",
    payloadJson: JSON.stringify({
      threadId: input.threadId,
      projectId: input.projectId,
      title: input.threadId,
      modelSelection: null,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    }),
  };
}

function makeRunner(overrides: Partial<HistorySyncRunnerDependencies> = {}, calls: string[] = []) {
  return Effect.gen(function* () {
    const statuses: HistorySyncStatus[] = [];
    const statusRef = yield* Ref.make<HistorySyncStatus>({
      state: "idle",
      configured: true,
      lastSyncedAt: null,
    });
    const deps: HistorySyncRunnerDependencies = {
      getSettings: Effect.succeed({ historySync: { enabled: true } }),
      getConnectionString: Effect.succeed("mysql://history"),
      statusRef,
      publishStatus: (status) =>
        Effect.sync(() => {
          statuses.push(status);
        }).pipe(Effect.andThen(Ref.set(statusRef, status))),
      createBackup: Effect.sync(() => calls.push("backup")).pipe(Effect.asVoid),
      reloadProjections: () => Effect.sync(() => calls.push("reload")).pipe(Effect.asVoid),
      readLocalEvents: () => Effect.succeed([]),
      readLocalEventRefsForSequences: () => Effect.succeed([]),
      readLocalEventsForSequences: () => Effect.succeed([]),
      readUnpushedLocalEvents: Effect.succeed([]),
      readProjectionThreadAutosyncRows: Effect.succeed([]),
      readLocalProjectionCounts: Effect.succeed({ projectCount: 0, threadCount: 0 }),
      readState: Effect.succeed(null),
      commitHistorySyncState: () =>
        Effect.sync(() => calls.push("commitState")).pipe(Effect.asVoid),
      commitPushedEventReceiptsAndState: () =>
        Effect.sync(() => calls.push("commitReceiptsState")).pipe(Effect.asVoid),
      setInitialSyncPhase: (input) =>
        Effect.sync(() => calls.push(`phase:${input.phase}`)).pipe(Effect.asVoid),
      clearInitialSyncPhase: Effect.sync(() => calls.push("clearPhase")).pipe(Effect.asVoid),
      failInitialSyncPhase: (input) =>
        Effect.sync(() => calls.push(`failPhase:${input.error}`)).pipe(Effect.asVoid),
      importRemoteEvents: () => Effect.sync(() => calls.push("import")).pipe(Effect.asVoid),
      importRemoteDeltaEvents: () =>
        Effect.sync(() => calls.push("importDelta")).pipe(Effect.asVoid),
      writePushedEventReceipts: () =>
        Effect.sync(() => calls.push("writeReceipts")).pipe(Effect.asVoid),
      seedPushedEventReceiptsForCompletedSync: () =>
        Effect.sync(() => calls.push("seedReceipts")).pipe(Effect.asVoid),
      readRemoteEvents: () => Effect.succeed([]),
      readRemoteMaxSequence: () => Effect.succeed(0),
      readRemoteLatestThreadShells: () => Effect.succeed([]),
      readRemoteEventsForThreadIds: () => Effect.succeed([]),
      readRemoteProjectEventsForProjectIds: () => Effect.succeed([]),
      pushRemoteEventsBatched: () => Effect.sync(() => calls.push("push")).pipe(Effect.asVoid),
      isRetryableConnectionFailure: () => false,
      readProjectMappings: Effect.succeed([]),
      buildProjectMappingPlanFromEvents: () =>
        Effect.succeed({
          syncId: "client:0",
          remoteMaxSequence: 0,
          candidates: [],
          localProjects: [],
        }),
      autoPersistExactProjectMappings: () =>
        Effect.sync(() => calls.push("autoMap")).pipe(Effect.asVoid),
      upsertHistorySyncThreadStates: () =>
        Effect.sync(() => calls.push("upsertThreadState")).pipe(Effect.asVoid),
      readHistorySyncThreadStateCounts: Effect.succeed({
        loadedThreadCount: 0,
        totalThreadCount: 0,
      }),
      readHistorySyncThreadState: () =>
        Effect.succeed({
          latestRemoteSequence: 2,
          importedThroughSequence: 1,
          isShellLoaded: 1,
          isFullLoaded: 0,
          lastRequestedAt: null,
        }),
      updateHistorySyncLatestFirstState: () =>
        Effect.sync(() => calls.push("latestFirstState")).pipe(Effect.asVoid),
      markHistorySyncThreadPriority: () =>
        Effect.sync(() => calls.push("markThreadPriority")).pipe(Effect.asVoid),
      deferHistorySyncThreadPriority: () =>
        Effect.sync(() => calls.push("deferThreadPriority")).pipe(Effect.asVoid),
      ...overrides,
    };
    return { runner: createHistorySyncRunner(deps), statuses };
  });
}

describe("history sync runner", () => {
  test("keeps retry delay selection stable", () => {
    expect(nextHistorySyncRetryDelayMs(0)).toBeNull();
    expect(nextHistorySyncRetryDelayMs(1)).toBe(10_000);
    expect(nextHistorySyncRetryDelayMs(2)).toBe(180_000);
    expect(nextHistorySyncRetryDelayMs(6)).toBeNull();
  });

  test("keeps retry scope limited to autosave retryable connection failures", () => {
    const retryable = new Error("connection reset");
    const semantic = new Error("remote conflict");
    const isRetryableConnectionFailure = (error: unknown) => error === retryable;

    expect(
      shouldRetryHistorySyncFailure({
        mode: "autosave",
        cause: retryable,
        isRetryableConnectionFailure,
      }),
    ).toBe(true);
    expect(
      shouldRetryHistorySyncFailure({
        mode: "full",
        cause: retryable,
        isRetryableConnectionFailure,
      }),
    ).toBe(false);
    expect(
      shouldRetryHistorySyncFailure({
        mode: "initial",
        cause: retryable,
        isRetryableConnectionFailure,
      }),
    ).toBe(false);
    expect(
      shouldRetryHistorySyncFailure({
        mode: "autosave",
        cause: semantic,
        isRetryableConnectionFailure,
      }),
    ).toBe(false);
  });

  test("publishes disabled when unconfigured", async () => {
    const { runner, statuses } = await Effect.runPromise(
      makeRunner({ getConnectionString: Effect.succeed(null) }),
    );

    await Effect.runPromise(runner.performSync({ mode: "full", markStopped: Effect.void }));

    expect(statuses).toEqual([{ state: "disabled", configured: false }]);
  });

  test("describes autosave remote conflicts with stable copy and log metadata", () => {
    expect(
      describeAutosaveRemoteConflict({
        remoteMaxSequence: 12,
        lastSyncedRemoteSequence: 7,
        remoteDeltaEventCount: 5,
        unknownRemoteEventCount: 2,
      }),
    ).toEqual({
      message: HISTORY_SYNC_AUTOSAVE_REMOTE_CONFLICT_MESSAGE,
      remoteMaxSequence: 12,
      lastSyncedRemoteSequence: 7,
      remoteDeltaEventCount: 5,
      unknownRemoteEventCount: 2,
    });
  });

  test("skips priority thread sync for marker-only thread state", async () => {
    const calls: string[] = [];
    const { runner, statuses } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 1,
            lastSyncedRemoteSequence: 1,
            lastSuccessfulSyncAt: "2026-05-01T00:00:00.000Z",
          }),
          readHistorySyncThreadState: () =>
            Effect.succeed({
              latestRemoteSequence: 0,
              importedThroughSequence: 0,
              isShellLoaded: 0,
              isFullLoaded: 0,
              lastRequestedAt: null,
            }),
          readRemoteEventsForThreadIds: () =>
            Effect.sync(() => calls.push("readRemoteThread")).pipe(Effect.as([])),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.runPriorityThreadImport("thread-marker-only"));

    expect(calls).not.toContain("markThreadPriority");
    expect(calls).not.toContain("readRemoteThread");
    expect(statuses).toEqual([]);
  });

  test("skips priority thread sync when thread is already fully imported", async () => {
    const calls: string[] = [];
    const { runner } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 1,
            lastSyncedRemoteSequence: 1,
            lastSuccessfulSyncAt: "2026-05-01T00:00:00.000Z",
          }),
          readHistorySyncThreadState: () =>
            Effect.succeed({
              latestRemoteSequence: 10,
              importedThroughSequence: 10,
              isShellLoaded: 1,
              isFullLoaded: 1,
              lastRequestedAt: null,
            }),
          readRemoteEventsForThreadIds: () =>
            Effect.sync(() => calls.push("readRemoteThread")).pipe(Effect.as([])),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.runPriorityThreadImport("thread-full"));

    expect(calls).not.toContain("markThreadPriority");
    expect(calls).not.toContain("readRemoteThread");
  });

  test("autosave pauses on unknown remote events without pushing local history", async () => {
    const calls: string[] = [];
    const markStoppedCalls: string[] = [];
    const localReadSequences: Array<number | undefined> = [];
    const { runner, statuses } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 1,
            lastSyncedRemoteSequence: 1,
            lastSuccessfulSyncAt: "2026-05-01T00:00:00.000Z",
          }),
          readLocalEvents: (sequenceExclusive) =>
            Effect.sync(() => {
              localReadSequences.push(sequenceExclusive);
              return [remoteEvent];
            }),
          readRemoteMaxSequence: () => Effect.succeed(2),
          readRemoteEvents: () =>
            Effect.succeed([
              {
                ...remoteEvent,
                sequence: 2,
                eventId: "remote-only-event",
                streamVersion: 2,
              },
            ]),
        },
        calls,
      ),
    );

    await Effect.runPromise(
      runner.performSync({
        mode: "autosave",
        markStopped: Effect.sync(() => markStoppedCalls.push("stopped")).pipe(Effect.asVoid),
      }),
    );

    expect(markStoppedCalls).toEqual(["stopped"]);
    expect(localReadSequences).toEqual([1]);
    expect(calls).not.toContain("push");
    expect(statuses.at(-1)).toEqual({
      state: "error",
      configured: true,
      message: HISTORY_SYNC_AUTOSAVE_REMOTE_CONFLICT_MESSAGE,
      lastSyncedAt: null,
    });
  });

  test("autosave accepts known remote deltas from the local tail without reading full local history", async () => {
    const calls: string[] = [];
    const localReadSequences: Array<number | undefined> = [];
    let remoteMaxReads = 0;
    const localTailEvent = projectEvent({ sequence: 8, projectId: "project-local" });
    const remoteDeltaEvent = {
      ...localTailEvent,
      sequence: 8,
      streamVersion: 8,
    };
    const { runner, statuses } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 1,
            lastSyncedRemoteSequence: 7,
            lastSuccessfulSyncAt: "2026-05-01T00:00:00.000Z",
          }),
          readRemoteMaxSequence: () =>
            Effect.sync(() => {
              remoteMaxReads += 1;
              return 8;
            }),
          readRemoteEvents: () => Effect.succeed([remoteDeltaEvent]),
          readLocalEvents: (sequenceExclusive) =>
            Effect.sync(() => {
              localReadSequences.push(sequenceExclusive);
              return [localTailEvent];
            }),
          readUnpushedLocalEvents: Effect.succeed([localTailEvent]),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "autosave", markStopped: Effect.void }));

    expect(remoteMaxReads).toBe(1);
    expect(localReadSequences).toEqual([7]);
    expect(calls).not.toContain("push");
    expect(calls).toContain("commitReceiptsState");
    expect(statuses.map((status) => status.state)).toEqual(["syncing", "idle"]);
  });

  test("autosave skips visible syncing status when nothing is pushable", async () => {
    const calls: string[] = [];
    const { runner, statuses } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 1,
            lastSyncedRemoteSequence: 7,
            lastSuccessfulSyncAt: "2026-05-01T00:00:00.000Z",
          }),
          readRemoteMaxSequence: () => Effect.succeed(7),
          readUnpushedLocalEvents: Effect.sync(() => {
            calls.push("readUnpushed");
            return [];
          }),
          readLocalEvents: () =>
            Effect.sync(() => {
              calls.push("readLocalEvents");
              return [remoteEvent];
            }),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "autosave", markStopped: Effect.void }));

    expect(calls).toContain("readUnpushed");
    expect(calls).not.toContain("readLocalEvents");
    expect(calls).not.toContain("push");
    expect(statuses).toEqual([]);
  });

  test("autosave still asks for initial sync before reading local history", async () => {
    const calls: string[] = [];
    const { runner, statuses } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 0,
            lastSyncedRemoteSequence: 0,
            lastSuccessfulSyncAt: null,
          }),
          readLocalEvents: () =>
            Effect.sync(() => {
              calls.push("readLocalEvents");
              return [remoteEvent];
            }),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "autosave", markStopped: Effect.void }));

    expect(calls).not.toContain("readLocalEvents");
    expect(statuses.at(-1)).toEqual({
      state: "needs-initial-sync",
      configured: true,
      lastSyncedAt: null,
    });
  });

  test("autosave pushes local events without reading full local history when remote is current", async () => {
    const calls: string[] = [];
    let remoteMaxReads = 0;
    const local = [projectEvent({ sequence: 8, projectId: "project-local" })];
    const { runner, statuses } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 1,
            lastSyncedRemoteSequence: 7,
            lastSuccessfulSyncAt: "2026-05-01T00:00:00.000Z",
          }),
          readRemoteMaxSequence: () =>
            Effect.sync(() => {
              remoteMaxReads += 1;
              return 7;
            }),
          readUnpushedLocalEvents: Effect.sync(() => {
            calls.push("readUnpushed");
            return local;
          }),
          readLocalEvents: () =>
            Effect.sync(() => {
              calls.push("readLocalEvents");
              return [remoteEvent, ...local];
            }),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "autosave", markStopped: Effect.void }));

    expect(remoteMaxReads).toBe(1);
    expect(calls).toContain("readUnpushed");
    expect(calls).not.toContain("readLocalEvents");
    expect(calls).toContain("push");
    expect(calls).toContain("commitReceiptsState");
    expect(statuses.map((status) => status.state)).toEqual(["syncing", "idle"]);
  });

  test("full sync skips latest-first bootstrap for small remote deltas", async () => {
    const calls: string[] = [];
    const { runner, statuses } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 1,
            lastSyncedRemoteSequence: 1,
            lastSuccessfulSyncAt: "2026-05-01T00:00:00.000Z",
          }),
          readLocalEvents: () => Effect.succeed([remoteEvent]),
          readLocalProjectionCounts: Effect.succeed({ projectCount: 1, threadCount: 1 }),
          readRemoteMaxSequence: () => Effect.succeed(2),
          readRemoteEvents: () => Effect.succeed([localEvent]),
          readRemoteLatestThreadShells: () =>
            Effect.sync(() => calls.push("readLatestThreads")).pipe(Effect.as([])),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "full", markStopped: Effect.void }));

    expect(calls).not.toContain("readLatestThreads");
    expect(calls).toContain("importDelta");
    expect(statuses.at(-1)).toMatchObject({ state: "idle", configured: true });
  });

  test("completed full sync skips full local history load when remote and receipts are current", async () => {
    const calls: string[] = [];
    const { runner, statuses } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 1,
            lastSyncedRemoteSequence: 7,
            lastSuccessfulSyncAt: "2026-05-01T00:00:00.000Z",
          }),
          readRemoteMaxSequence: () => Effect.succeed(7),
          readUnpushedLocalEvents: Effect.sync(() => {
            calls.push("readUnpushed");
            return [];
          }),
          readLocalEvents: () =>
            Effect.sync(() => {
              calls.push("readLocalEvents");
              return [remoteEvent];
            }),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "full", markStopped: Effect.void }));

    expect(calls).toContain("readUnpushed");
    expect(calls).not.toContain("readLocalEvents");
    expect(calls).toContain("commitState");
    expect(statuses.at(-1)).toMatchObject({ state: "idle", configured: true });
  });

  test("completed full sync pushes local pending events without reading full local history", async () => {
    const calls: string[] = [];
    const local = [projectEvent({ sequence: 8, projectId: "project-local" })];
    const { runner, statuses } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 1,
            lastSyncedRemoteSequence: 7,
            lastSuccessfulSyncAt: "2026-05-01T00:00:00.000Z",
          }),
          readRemoteMaxSequence: () => Effect.succeed(7),
          readUnpushedLocalEvents: Effect.sync(() => {
            calls.push("readUnpushed");
            return local;
          }),
          readLocalEvents: () =>
            Effect.sync(() => {
              calls.push("readLocalEvents");
              return [remoteEvent, ...local];
            }),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "full", markStopped: Effect.void }));

    expect(calls).toContain("readUnpushed");
    expect(calls).not.toContain("readLocalEvents");
    expect(calls).toContain("push");
    expect(calls).toContain("commitReceiptsState");
    expect(statuses.map((status) => status.state)).toEqual(["syncing", "idle"]);
  });

  test("latest-first bootstrap dedupes page imports with bounded local refs", async () => {
    const calls: string[] = [];
    const localReadCalls: string[] = [];
    const localRefSequenceBatches: number[][] = [];
    const remoteDeltaEvents = Array.from({ length: 500 }, (_, index) =>
      threadCreatedEvent({
        sequence: index + 2,
        threadId: `thread-${index + 1}`,
        projectId: "project-1",
      }),
    );
    const latestThreadEvent = remoteDeltaEvents.at(-1)!;
    const { runner } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 1,
            lastSyncedRemoteSequence: 1,
            lastSuccessfulSyncAt: "2026-05-01T00:00:00.000Z",
          }),
          readLocalEvents: () =>
            Effect.sync(() => {
              localReadCalls.push("readLocalEvents");
              return [remoteEvent];
            }),
          readLocalEventRefsForSequences: (sequences) =>
            Effect.sync(() => {
              localRefSequenceBatches.push([...sequences]);
              return [{ sequence: remoteEvent.sequence, eventId: remoteEvent.eventId }];
            }),
          readLocalProjectionCounts: Effect.succeed({ projectCount: 1, threadCount: 1 }),
          readRemoteMaxSequence: () => Effect.succeed(latestThreadEvent.sequence),
          readRemoteEvents: () => Effect.succeed(remoteDeltaEvents),
          readRemoteLatestThreadShells: (_connectionString, input) =>
            Effect.succeed(
              input.offset === 0
                ? [
                    {
                      threadId: latestThreadEvent.streamId,
                      projectId: "project-1",
                      title: latestThreadEvent.streamId,
                      createdAt: latestThreadEvent.occurredAt,
                      updatedAt: latestThreadEvent.occurredAt,
                      latestEventSequence: latestThreadEvent.sequence,
                      deletedAt: null,
                      archivedAt: null,
                    },
                  ]
                : [],
            ),
          readRemoteEventsForThreadIds: () => Effect.succeed([latestThreadEvent]),
          readRemoteProjectEventsForProjectIds: () => Effect.succeed([remoteEvent]),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "full", markStopped: Effect.void }));

    expect(localReadCalls).toHaveLength(2);
    expect(localRefSequenceBatches).toEqual([[remoteEvent.sequence, latestThreadEvent.sequence]]);
    expect(calls).toContain("importDelta");
  });

  test("full sync waits for explicit initial sync before initialization", async () => {
    const { runner, statuses } = await Effect.runPromise(makeRunner());

    await Effect.runPromise(runner.performSync({ mode: "full", markStopped: Effect.void }));

    expect(statuses.at(-1)).toEqual({
      state: "needs-initial-sync",
      configured: true,
      lastSyncedAt: null,
    });
  });

  test("initial sync creates backup before destructive remote import", async () => {
    const calls: string[] = [];
    const { runner } = await Effect.runPromise(
      makeRunner(
        {
          readRemoteEvents: () => Effect.succeed([remoteEvent]),
          buildProjectMappingPlanFromEvents: () =>
            Effect.succeed({
              syncId: "client:1",
              remoteMaxSequence: 1,
              candidates: [],
              localProjects: [],
            }),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "initial", markStopped: Effect.void }));

    expect(calls.indexOf("phase:backup")).toBeLessThan(calls.indexOf("backup"));
    expect(calls.indexOf("backup")).toBeLessThan(calls.indexOf("import"));
    expect(calls).toContain("reload");
    expect(calls).toContain("commitReceiptsState");
    expect(calls.indexOf("commitReceiptsState")).toBeLessThan(calls.indexOf("clearPhase"));
  });

  test("initial sync records empty-remote local push phases in order", async () => {
    const calls: string[] = [];
    const { runner } = await Effect.runPromise(
      makeRunner(
        {
          readLocalEvents: () => Effect.succeed([remoteEvent]),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "initial", markStopped: Effect.void }));

    expect(calls).toEqual(
      expect.arrayContaining([
        "phase:backup",
        "backup",
        "seedReceipts",
        "autoMap",
        "phase:push-local",
        "push",
        "phase:write-state",
        "commitReceiptsState",
        "clearPhase",
      ]),
    );
    expect(calls.indexOf("phase:backup")).toBeLessThan(calls.indexOf("backup"));
    expect(calls.indexOf("phase:push-local")).toBeLessThan(calls.indexOf("push"));
    expect(calls.indexOf("phase:write-state")).toBeLessThan(calls.indexOf("commitReceiptsState"));
    expect(calls.indexOf("commitReceiptsState")).toBeLessThan(calls.indexOf("clearPhase"));
  });

  test("initial sync records remote-import phases in order", async () => {
    const calls: string[] = [];
    const { runner } = await Effect.runPromise(
      makeRunner(
        {
          readRemoteEvents: () => Effect.succeed([remoteEvent]),
          buildProjectMappingPlanFromEvents: () =>
            Effect.succeed({
              syncId: "client:1",
              remoteMaxSequence: 1,
              candidates: [],
              localProjects: [],
            }),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "initial", markStopped: Effect.void }));

    expect(calls.indexOf("phase:backup")).toBeLessThan(calls.indexOf("backup"));
    expect(calls.indexOf("phase:push-merge")).toBeLessThan(calls.indexOf("push"));
    expect(calls.indexOf("phase:import-remote")).toBeLessThan(calls.indexOf("import"));
    expect(calls.indexOf("phase:write-state")).toBeLessThan(calls.indexOf("commitReceiptsState"));
    expect(calls.indexOf("commitReceiptsState")).toBeLessThan(calls.indexOf("clearPhase"));
  });

  test("initial sync failure records failed phase without completing state", async () => {
    const calls: string[] = [];
    const { runner, statuses } = await Effect.runPromise(
      makeRunner(
        {
          readRemoteEvents: () => Effect.succeed([remoteEvent]),
          buildProjectMappingPlanFromEvents: () =>
            Effect.succeed({
              syncId: "client:1",
              remoteMaxSequence: 1,
              candidates: [],
              localProjects: [],
            }),
          importRemoteEvents: () =>
            Effect.sync(() => calls.push("import")).pipe(
              Effect.andThen(Effect.fail(new Error("projection import failed"))),
            ),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "initial", markStopped: Effect.void }));

    expect(calls).toContain("phase:import-remote");
    expect(calls.some((call) => call.startsWith("failPhase:"))).toBe(true);
    expect(calls).not.toContain("commitReceiptsState");
    expect(calls).not.toContain("clearPhase");
    expect(statuses.at(-1)).toMatchObject({
      state: "error",
      configured: true,
    });
  });

  test("completed no-op full sync commits state atomically", async () => {
    const calls: string[] = [];
    const { runner } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 1,
            lastSyncedRemoteSequence: 0,
            lastSuccessfulSyncAt: null,
          }),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "full", markStopped: Effect.void }));

    expect(calls).toContain("commitState");
    expect(calls).not.toContain("writeState");
  });

  test("remote-behind-local repair uses atomic receipt and state commit after push", async () => {
    const calls: string[] = [];
    const { runner } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 1,
            lastSyncedRemoteSequence: 2,
            lastSuccessfulSyncAt: null,
          }),
          readLocalEvents: () =>
            Effect.succeed([
              remoteEvent,
              {
                ...remoteEvent,
                sequence: 2,
                eventId: "event-2",
                streamVersion: 2,
              },
            ]),
          readRemoteMaxSequence: () => Effect.succeed(1),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "full", markStopped: Effect.void }));

    expect(calls.indexOf("push")).toBeLessThan(calls.indexOf("commitReceiptsState"));
    expect(calls).not.toContain("writeState");
  });

  test("full sync replay commits remote-covered receipts after a previous post-push local failure", async () => {
    const calls: string[] = [];
    let remoteEvents: readonly HistorySyncEventRow[] = [];
    let commitAttempts = 0;
    const { runner } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 1,
            lastSyncedRemoteSequence: 0,
            lastSuccessfulSyncAt: null,
          }),
          readLocalEvents: () => Effect.succeed([remoteEvent]),
          readUnpushedLocalEvents: Effect.succeed([remoteEvent]),
          readRemoteEvents: () => Effect.succeed(remoteEvents),
          readRemoteMaxSequence: () => Effect.succeed(remoteEvents.length === 0 ? 0 : 1),
          pushRemoteEventsBatched: (_connectionString, events) =>
            Effect.sync(() => {
              calls.push("push");
              remoteEvents = events;
            }).pipe(Effect.asVoid),
          commitPushedEventReceiptsAndState: (input) =>
            Effect.gen(function* () {
              calls.push(`commit:${input.state.lastSyncedRemoteSequence}`);
              commitAttempts += 1;
              if (commitAttempts === 1) {
                return yield* Effect.fail(new Error("local commit failed"));
              }
            }),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "full", markStopped: Effect.void }));
    await Effect.runPromise(runner.performSync({ mode: "full", markStopped: Effect.void }));

    expect(calls.filter((call) => call === "push")).toHaveLength(1);
    expect(calls).toContain("commit:1");
  });

  test("full sync replay with partial remote coverage does not advance past the proven cursor", async () => {
    const calls: string[] = [];
    const local = [
      remoteEvent,
      {
        ...remoteEvent,
        sequence: 2,
        eventId: "event-2",
        streamVersion: 2,
      },
    ];
    const commits: number[] = [];
    const { runner } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 1,
            lastSyncedRemoteSequence: 0,
            lastSuccessfulSyncAt: null,
          }),
          readLocalEvents: () => Effect.succeed(local),
          readUnpushedLocalEvents: Effect.succeed(local),
          readRemoteEvents: () => Effect.succeed([local[1]!]),
          readRemoteMaxSequence: () => Effect.succeed(2),
          commitPushedEventReceiptsAndState: (input) =>
            Effect.sync(() => {
              calls.push("commitReceiptsState");
              commits.push(input.state.lastSyncedRemoteSequence);
            }).pipe(Effect.asVoid),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "full", markStopped: Effect.void }));

    expect(calls).not.toContain("push");
    expect(commits).toContain(0);
  });

  test("full sync pending push uses validated mappings and does not rewrite through stale rows", async () => {
    const calls: string[] = [];
    const local = [
      {
        ...remoteEvent,
        streamId: "local-project",
        eventId: "local-event-1",
        payloadJson: JSON.stringify({
          projectId: "local-project",
          title: "Local project",
          workspaceRoot: "/local/project",
        }),
      },
    ];
    let pushedEvents: readonly HistorySyncEventRow[] = [];
    const { runner } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 1,
            lastSyncedRemoteSequence: 0,
            lastSuccessfulSyncAt: null,
          }),
          readLocalEvents: () => Effect.succeed(local),
          readUnpushedLocalEvents: Effect.succeed(local),
          readProjectMappings: Effect.succeed([]),
          pushRemoteEventsBatched: (_connectionString, events) =>
            Effect.sync(() => {
              calls.push("push");
              pushedEvents = events;
            }).pipe(Effect.asVoid),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "full", markStopped: Effect.void }));

    expect(pushedEvents[0]?.streamId).toBe("local-project");
    expect(JSON.parse(pushedEvents[0]?.payloadJson ?? "{}").projectId).toBe("local-project");
  });

  test("initial sync recovery finishes state when local push is already remote-covered", async () => {
    const calls: string[] = [];
    const { runner } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 0,
            lastSyncedRemoteSequence: 0,
            lastSuccessfulSyncAt: null,
            initialSyncPhase: "push-local",
          }),
          readLocalEvents: () => Effect.succeed([remoteEvent]),
          readRemoteEvents: () => Effect.succeed([remoteEvent]),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "initial", markStopped: Effect.void }));

    expect(calls).not.toContain("push");
    expect(calls).not.toContain("import");
    expect(calls).toContain("phase:write-state");
    expect(calls).toContain("commitReceiptsState");
    expect(calls).toContain("clearPhase");
  });

  test("initial sync recovery from backup phase recreates backup before push or import", async () => {
    const calls: string[] = [];
    const { runner } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 0,
            lastSyncedRemoteSequence: 0,
            lastSuccessfulSyncAt: null,
            initialSyncPhase: "backup",
          }),
          readLocalEvents: () => Effect.succeed([localEvent]),
          readRemoteEvents: () => Effect.succeed([remoteEvent]),
          buildProjectMappingPlanFromEvents: () =>
            Effect.succeed({
              syncId: "client:2",
              remoteMaxSequence: 1,
              candidates: [],
              localProjects: [],
            }),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "initial", markStopped: Effect.void }));

    expect(calls.indexOf("phase:backup")).toBeLessThan(calls.indexOf("backup"));
    expect(calls.indexOf("backup")).toBeLessThan(calls.indexOf("phase:push-merge"));
    expect(calls.indexOf("backup")).toBeLessThan(calls.indexOf("push"));
    expect(calls.indexOf("backup")).toBeLessThan(calls.indexOf("import"));
    expect(calls).toContain("clearPhase");
  });

  test("initial sync recovery imports when merge push is already remote-covered", async () => {
    const calls: string[] = [];
    const { runner } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 0,
            lastSyncedRemoteSequence: 0,
            lastSuccessfulSyncAt: null,
            initialSyncPhase: "import-remote",
          }),
          readLocalEvents: () => Effect.succeed([localEvent]),
          readRemoteEvents: () => Effect.succeed([remoteEvent, localEvent]),
          buildProjectMappingPlanFromEvents: () =>
            Effect.succeed({
              syncId: "client:2",
              remoteMaxSequence: 2,
              candidates: [],
              localProjects: [],
            }),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "initial", markStopped: Effect.void }));

    expect(calls).not.toContain("push");
    expect(calls.indexOf("phase:import-remote")).toBeLessThan(calls.indexOf("import"));
    expect(calls.indexOf("import")).toBeLessThan(calls.indexOf("phase:write-state"));
    expect(calls).toContain("commitReceiptsState");
    expect(calls).toContain("clearPhase");
  });

  test("initial sync recovery applies persisted project mappings to push/import/receipts", async () => {
    const calls: string[] = [];
    const local = [
      projectEvent({ sequence: 1, projectId: "local-keep", workspaceRoot: "/local/keep" }),
      threadCreatedEvent({ sequence: 2, threadId: "thread-local", projectId: "local-keep" }),
    ];
    const remote = [
      projectEvent({ sequence: 1, projectId: "remote-keep", workspaceRoot: "/remote/keep" }),
      threadCreatedEvent({ sequence: 2, threadId: "thread-keep", projectId: "remote-keep" }),
      projectEvent({ sequence: 3, projectId: "remote-skip", workspaceRoot: "/remote/skip" }),
      threadCreatedEvent({ sequence: 4, threadId: "thread-skip", projectId: "remote-skip" }),
    ];
    let pushedEvents: readonly HistorySyncEventRow[] = [];
    let importedEvents: readonly HistorySyncEventRow[] = [];
    let receiptEvents: readonly HistorySyncEventRow[] = [];
    const { runner } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 0,
            lastSyncedRemoteSequence: 0,
            lastSuccessfulSyncAt: null,
            initialSyncPhase: "push-merge",
          }),
          readLocalEvents: () => Effect.succeed(local),
          readRemoteEvents: () => Effect.succeed(remote),
          readRemoteMaxSequence: () => Effect.succeed(4),
          readProjectMappings: Effect.succeed([
            {
              remoteProjectId: "remote-keep",
              localProjectId: "local-keep",
              localWorkspaceRoot: "/local/keep",
              remoteWorkspaceRoot: "/remote/keep",
              remoteTitle: "remote-keep",
              status: "mapped",
              createdAt: "2026-05-01T00:00:00.000Z",
              updatedAt: "2026-05-01T00:00:00.000Z",
            },
            {
              remoteProjectId: "remote-skip",
              localProjectId: "local-skip",
              localWorkspaceRoot: "/local/skip",
              remoteWorkspaceRoot: "/remote/skip",
              remoteTitle: "remote-skip",
              status: "skipped",
              createdAt: "2026-05-01T00:00:00.000Z",
              updatedAt: "2026-05-01T00:00:00.000Z",
            },
          ]),
          pushRemoteEventsBatched: (_connectionString, events) =>
            Effect.sync(() => {
              calls.push("push");
              pushedEvents = events;
            }).pipe(Effect.asVoid),
          importRemoteEvents: (events) =>
            Effect.sync(() => {
              calls.push("import");
              importedEvents = events;
            }).pipe(Effect.asVoid),
          commitPushedEventReceiptsAndState: (input) =>
            Effect.sync(() => {
              calls.push("commitReceiptsState");
              receiptEvents = input.events;
            }).pipe(Effect.asVoid),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "initial", markStopped: Effect.void }));

    expect(pushedEvents.map((row) => row.streamId)).toEqual(["thread-local"]);
    expect(pushedEvents.map((row) => JSON.parse(row.payloadJson).projectId)).toEqual([
      "remote-keep",
    ]);
    expect(importedEvents.map((row) => row.streamId)).toEqual([
      "local-keep",
      "thread-keep",
      "thread-local",
    ]);
    expect(importedEvents.map((row) => JSON.parse(row.payloadJson).projectId)).toEqual([
      "local-keep",
      "local-keep",
      "local-keep",
    ]);
    expect(receiptEvents).toEqual(importedEvents);
  });

  test("initial sync recovery finishes write-state without reimporting", async () => {
    const calls: string[] = [];
    const { runner } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 0,
            lastSyncedRemoteSequence: 0,
            lastSuccessfulSyncAt: null,
            initialSyncPhase: "write-state",
          }),
          readLocalEvents: () => Effect.succeed([localEvent]),
          readRemoteEvents: () => Effect.succeed([remoteEvent, localEvent]),
          buildProjectMappingPlanFromEvents: () =>
            Effect.succeed({
              syncId: "client:2",
              remoteMaxSequence: 2,
              candidates: [],
              localProjects: [],
            }),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "initial", markStopped: Effect.void }));

    expect(calls).not.toContain("push");
    expect(calls).not.toContain("import");
    expect(calls).toContain("phase:write-state");
    expect(calls).toContain("commitReceiptsState");
    expect(calls).toContain("clearPhase");
  });

  test("initial sync recovery keeps marker visible when remote drift is unsafe", async () => {
    const calls: string[] = [];
    const { runner, statuses } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 0,
            lastSyncedRemoteSequence: 0,
            lastSuccessfulSyncAt: null,
            initialSyncPhase: "push-local",
          }),
          readLocalEvents: () => Effect.succeed([localEvent]),
          readRemoteEvents: () => Effect.succeed([remoteEvent]),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "initial", markStopped: Effect.void }));

    expect(calls).toContainEqual(
      expect.stringContaining("failPhase:Initial sync cannot safely resume"),
    );
    expect(calls).not.toContain("clearPhase");
    expect(statuses.at(-1)).toMatchObject({
      state: "error",
      configured: true,
    });
  });

  test("initial sync recovery keeps marker visible when collision rescue blocks replay", async () => {
    const calls: string[] = [];
    const { runner, statuses } = await Effect.runPromise(
      makeRunner(
        {
          readState: Effect.succeed({
            hasCompletedInitialSync: 0,
            lastSyncedRemoteSequence: 0,
            lastSuccessfulSyncAt: null,
            initialSyncPhase: "push-merge",
          }),
          readLocalEvents: () =>
            Effect.succeed([
              threadCreatedEvent({
                sequence: 1,
                threadId: "thread-collision",
                projectId: "project-local",
                eventId: "local-thread-created",
              }),
            ]),
          readRemoteEvents: () =>
            Effect.succeed([
              threadCreatedEvent({
                sequence: 1,
                threadId: "thread-collision",
                projectId: "project-remote",
                eventId: "remote-thread-created",
              }),
            ]),
        },
        calls,
      ),
    );

    await Effect.runPromise(runner.performSync({ mode: "initial", markStopped: Effect.void }));

    expect(calls).toContainEqual(
      expect.stringContaining("failPhase:Initial sync cannot safely resume"),
    );
    expect(calls).not.toContain("push");
    expect(calls).not.toContain("import");
    expect(calls).not.toContain("clearPhase");
    expect(statuses.at(-1)).toMatchObject({
      state: "error",
      configured: true,
      message:
        "Initial sync cannot safely resume because the failed merge involved thread ID collision rescue.",
    });
  });
});
