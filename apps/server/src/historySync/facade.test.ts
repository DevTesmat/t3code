import type { HistorySyncConfig, HistorySyncMysqlFields } from "@t3tools/contracts";
import { Effect, Exit } from "effect";
import { beforeEach, describe, expect, test } from "vitest";

import {
  getHistorySyncConfig,
  registerHistorySyncFacadeControl,
  resetHistorySyncFacadeControlForTest,
  runHistorySync,
  testHistorySyncConnection,
  type HistorySyncFacadeControl,
} from "./facade.ts";

const config: HistorySyncConfig = {
  enabled: true,
  configured: true,
  status: { state: "idle", configured: true, lastSyncedAt: null },
  intervalMs: 120_000,
  shutdownFlushTimeoutMs: 5_000,
  statusIndicatorEnabled: true,
};

const mysql: HistorySyncMysqlFields = {
  host: "localhost",
  port: 3306,
  database: "history",
  username: "user",
  password: "secret",
  tlsEnabled: false,
};

function makeControl(overrides: Partial<HistorySyncFacadeControl> = {}): HistorySyncFacadeControl {
  return {
    getConfig: Effect.succeed(config),
    updateConfig: () => Effect.succeed(config),
    runSync: Effect.succeed(config),
    startInitialSync: Effect.succeed(config),
    restoreBackup: Effect.succeed(config),
    testConnection: () => Effect.succeed({ success: true }),
    getProjectMappings: Effect.succeed({
      syncId: "client:1",
      remoteMaxSequence: 1,
      candidates: [],
      localProjects: [],
    }),
    applyProjectMappings: () =>
      Effect.succeed({
        syncId: "client:1",
        remoteMaxSequence: 1,
        candidates: [],
        localProjects: [],
      }),
    ...overrides,
  };
}

describe("history sync facade", () => {
  beforeEach(() => {
    resetHistorySyncFacadeControlForTest();
  });

  test("returns disabled config fallback before service registration", async () => {
    await expect(Effect.runPromise(getHistorySyncConfig)).resolves.toMatchObject({
      enabled: false,
      configured: false,
      status: { state: "disabled", configured: false },
      intervalMs: 120_000,
      shutdownFlushTimeoutMs: 5_000,
      statusIndicatorEnabled: true,
    });
  });

  test("fails manual operations before service registration", async () => {
    const exit = await Effect.runPromiseExit(runHistorySync);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain("History sync service is not ready.");
    }
  });

  test("delegates to registered service control", async () => {
    const seenConnections: HistorySyncMysqlFields[] = [];
    registerHistorySyncFacadeControl(
      makeControl({
        testConnection: (input) =>
          Effect.sync(() => {
            seenConnections.push(input);
            return { success: true, message: "ok" };
          }),
      }),
    );

    await expect(Effect.runPromise(getHistorySyncConfig)).resolves.toEqual(config);
    await expect(Effect.runPromise(testHistorySyncConnection(mysql))).resolves.toEqual({
      success: true,
      message: "ok",
    });
    expect(seenConnections).toEqual([mysql]);
  });
});
