import { HistorySyncConfigError, type HistorySyncStatus } from "@t3tools/contracts";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";

import type { HistorySyncStateRow } from "./localRepository.ts";
import {
  createHistorySyncRestoreController,
  type HistorySyncRestoreControllerDependencies,
} from "./restoreController.ts";

function makeController(
  overrides: Partial<HistorySyncRestoreControllerDependencies> = {},
  calls: string[] = [],
) {
  const published: HistorySyncStatus[] = [];
  const deps: HistorySyncRestoreControllerDependencies = {
    restoreBackupTablesFromDisk: Effect.sync(() => {
      calls.push("restore");
    }),
    reloadProjections: Effect.sync(() => {
      calls.push("reload");
    }),
    readState: Effect.succeed({
      hasCompletedInitialSync: 1,
      lastSyncedRemoteSequence: 7,
      lastSuccessfulSyncAt: "2026-05-01T00:00:00.000Z",
    } satisfies HistorySyncStateRow),
    getConnectionString: Effect.succeed("mysql://history"),
    publishStatus: (status) =>
      Effect.sync(() => {
        published.push(status);
      }),
    ...overrides,
  };
  return { controller: createHistorySyncRestoreController(deps), published };
}

describe("history sync restore controller", () => {
  test("restores tables before reloading projections", async () => {
    const calls: string[] = [];
    const { controller } = makeController({}, calls);

    await Effect.runPromise(controller.restoreBackupFromDisk);

    expect(calls).toEqual(["restore", "reload"]);
  });

  test("publishes needs-initial-sync when restored state is incomplete and configured", async () => {
    const { controller, published } = makeController({
      readState: Effect.succeed({
        hasCompletedInitialSync: 0,
        lastSyncedRemoteSequence: 0,
        lastSuccessfulSyncAt: "2026-05-01T00:00:00.000Z",
      }),
    });

    await Effect.runPromise(controller.restoreBackupFromDisk);

    expect(published).toEqual([
      {
        state: "needs-initial-sync",
        configured: true,
        lastSyncedAt: "2026-05-01T00:00:00.000Z",
      },
    ]);
  });

  test("publishes idle when restore is unconfigured", async () => {
    const { controller, published } = makeController({
      getConnectionString: Effect.succeed(null),
    });

    await Effect.runPromise(controller.restoreBackupFromDisk);

    expect(published).toEqual([
      {
        state: "idle",
        configured: false,
        lastSyncedAt: "2026-05-01T00:00:00.000Z",
      },
    ]);
  });

  test("supports no-op projection reload fallback", async () => {
    const calls: string[] = [];
    const { controller } = makeController({ reloadProjections: Effect.void }, calls);

    await Effect.runPromise(controller.restoreBackupFromDisk);

    expect(calls).toEqual(["restore"]);
  });

  test("normalizes restore errors", async () => {
    const { controller } = makeController({
      restoreBackupTablesFromDisk: Effect.fail(new Error("disk failed")),
    });

    const exit = await Effect.runPromiseExit(controller.restoreBackupFromDisk);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain("disk failed");
      expect(exit.cause.toString()).toContain("HistorySyncConfigError");
    }
  });

  test("preserves projection reload config errors", async () => {
    const { controller } = makeController({
      reloadProjections: Effect.fail(
        new HistorySyncConfigError({ message: "Projection reload failed: broken" }),
      ),
    });

    const exit = await Effect.runPromiseExit(controller.restoreBackupFromDisk);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain("Projection reload failed: broken");
    }
  });
});
