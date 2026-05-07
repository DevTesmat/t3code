import type {
  HistorySyncProjectMappingAction,
  HistorySyncProjectMappingPlan,
} from "@t3tools/contracts";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";

import type { HistorySyncStateRow } from "./localRepository.ts";
import type { HistorySyncEventRow } from "./planner.ts";
import {
  createHistorySyncProjectMappingController,
  type HistorySyncProjectMappingControllerDependencies,
} from "./projectMappingController.ts";

const remoteEvent: HistorySyncEventRow = {
  sequence: 7,
  eventId: "event-7",
  aggregateKind: "project",
  streamId: "project-1",
  streamVersion: 1,
  eventType: "project.created",
  occurredAt: "2026-05-01T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  actorKind: "system",
  payloadJson: "{}",
  metadataJson: "{}",
};

const plan: HistorySyncProjectMappingPlan = {
  syncId: "client:7",
  remoteMaxSequence: 7,
  candidates: [],
  localProjects: [],
};

const action: HistorySyncProjectMappingAction = {
  remoteProjectId: "project-1" as HistorySyncProjectMappingAction["remoteProjectId"],
  action: "skip",
};

function makeController(
  overrides: Partial<HistorySyncProjectMappingControllerDependencies> = {},
  calls: string[] = [],
) {
  const deps: HistorySyncProjectMappingControllerDependencies = {
    getConnectionString: Effect.succeed("mysql://history"),
    readRemoteEvents: () => Effect.succeed([remoteEvent]),
    buildProjectMappingPlanFromEvents: () =>
      Effect.sync(() => {
        calls.push("plan");
        return plan;
      }),
    autoPersistExactProjectMappings: () =>
      Effect.sync(() => {
        calls.push("autoPersist");
      }),
    getSyncId: (remoteMaxSequence) => Effect.succeed(`client:${remoteMaxSequence}`),
    applyMappingActions: () =>
      Effect.sync(() => {
        calls.push("apply");
      }),
    clearStopped: () =>
      Effect.sync(() => {
        calls.push("clearStopped");
      }),
    readState: Effect.succeed({
      hasCompletedInitialSync: 1,
      lastSyncedRemoteSequence: 7,
      lastSuccessfulSyncAt: null,
    } satisfies HistorySyncStateRow),
    syncNow: () =>
      Effect.sync(() => {
        calls.push("syncNow");
      }),
    startInitialSync: () =>
      Effect.sync(() => {
        calls.push("startInitialSync");
      }),
    ...overrides,
  };
  return createHistorySyncProjectMappingController(deps);
}

describe("history sync project mapping controller", () => {
  test("fails when connection is not configured", async () => {
    const controller = makeController({ getConnectionString: Effect.succeed(null) });

    const exit = await Effect.runPromiseExit(controller.getProjectMappings);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain("History sync MySQL connection is not configured.");
    }
  });

  test("auto-persists exact mappings when reading plan", async () => {
    const calls: string[] = [];
    const controller = makeController({}, calls);

    await expect(Effect.runPromise(controller.getProjectMappings)).resolves.toEqual(plan);

    expect(calls).toEqual(["plan", "autoPersist", "plan"]);
  });

  test("rejects stale apply sync id", async () => {
    const controller = makeController();

    const exit = await Effect.runPromiseExit(
      controller.applyProjectMappings({ syncId: "stale", actions: [] }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain(
        "History sync mapping plan is stale. Reload the project mapping wizard.",
      );
    }
  });

  test("completed sync apply clears stopped and triggers full sync", async () => {
    const calls: string[] = [];
    const controller = makeController({}, calls);

    await expect(
      Effect.runPromise(controller.applyProjectMappings({ syncId: "client:7", actions: [action] })),
    ).resolves.toEqual(plan);

    expect(calls).toEqual(["apply", "clearStopped", "syncNow", "plan"]);
  });

  test("incomplete sync apply starts initial sync", async () => {
    const calls: string[] = [];
    const controller = makeController(
      {
        readState: Effect.succeed({
          hasCompletedInitialSync: 0,
          lastSyncedRemoteSequence: 0,
          lastSuccessfulSyncAt: null,
        }),
      },
      calls,
    );

    await expect(
      Effect.runPromise(controller.applyProjectMappings({ syncId: "client:7", actions: [action] })),
    ).resolves.toEqual(plan);

    expect(calls).toEqual(["apply", "clearStopped", "startInitialSync", "plan"]);
  });
});
