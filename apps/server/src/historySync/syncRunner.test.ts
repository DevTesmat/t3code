import type { HistorySyncStatus } from "@t3tools/contracts";
import { Effect, Ref } from "effect";
import { describe, expect, test } from "vitest";

import {
  createHistorySyncRunner,
  nextHistorySyncRetryDelayMs,
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

  test("publishes disabled when unconfigured", async () => {
    const { runner, statuses } = await Effect.runPromise(
      makeRunner({ getConnectionString: Effect.succeed(null) }),
    );

    await Effect.runPromise(runner.performSync({ mode: "full", markStopped: Effect.void }));

    expect(statuses).toEqual([{ state: "disabled", configured: false }]);
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
        "writeReceipts",
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
});
