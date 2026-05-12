import type {
  HistorySyncProjectMappingAction,
  HistorySyncProjectMappingPlan,
} from "@t3tools/contracts";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";

import type { HistorySyncStateRow } from "./localRepository.ts";
import type { ProjectCandidate } from "./planner.ts";
import {
  createHistorySyncProjectMappingController,
  planProjectMappingApplyContinuation,
  type HistorySyncProjectMappingControllerDependencies,
} from "./projectMappingController.ts";

const remoteProject: ProjectCandidate = {
  projectId: "project-1",
  title: "Project 1",
  workspaceRoot: "/remote/project-1",
  deleted: false,
  threadCount: 1,
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
    readRemoteMaxSequence: () => Effect.succeed(7),
    readRemoteProjectMappingCandidates: () => Effect.succeed([remoteProject]),
    buildProjectMappingPlanFromCandidates: () =>
      Effect.sync(() => {
        calls.push("plan");
        return plan;
      }),
    autoPersistExactProjectMappings: () =>
      Effect.sync(() => {
        calls.push("autoPersist");
      }),
    getSyncId: (remoteMaxSequence) => Effect.succeed(`client:${remoteMaxSequence}`),
    applyMappingActionsForProjectCandidates: () =>
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
  test("plans apply continuation from completed initial sync state", () => {
    expect(planProjectMappingApplyContinuation(null)).toBe("start-initial-sync");
    expect(planProjectMappingApplyContinuation({ hasCompletedInitialSync: 0 })).toBe(
      "start-initial-sync",
    );
    expect(planProjectMappingApplyContinuation({ hasCompletedInitialSync: 1 })).toBe("sync-now");
  });

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

  test("reads mapping plan from remote project indexes without full remote events", async () => {
    const calls: string[] = [];
    const controller = makeController(
      {
        readRemoteProjectMappingCandidates: () =>
          Effect.sync(() => {
            calls.push("readIndexedProjects");
            return [remoteProject];
          }),
        readRemoteMaxSequence: () =>
          Effect.sync(() => {
            calls.push("readRemoteMax");
            return 7;
          }),
      },
      calls,
    );

    await expect(Effect.runPromise(controller.getProjectMappings)).resolves.toEqual(plan);

    expect(calls).toContain("readIndexedProjects");
    expect(calls).toContain("readRemoteMax");
    expect(calls).toEqual(expect.arrayContaining(["plan", "autoPersist"]));
    expect(calls.filter((call) => call === "plan")).toHaveLength(2);
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

  test("rejects apply when local project drift changes the sync id", async () => {
    const calls: string[] = [];
    const controller = makeController(
      {
        getSyncId: (remoteMaxSequence) => Effect.succeed(`client:${remoteMaxSequence}:after`),
      },
      calls,
    );

    const exit = await Effect.runPromiseExit(
      controller.applyProjectMappings({ syncId: "client:7:before", actions: [action] }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).not.toContain("apply");
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
