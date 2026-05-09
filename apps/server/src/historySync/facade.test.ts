import type { HistorySyncConfig, HistorySyncMysqlFields } from "@t3tools/contracts";
import { Effect, Exit } from "effect";
import { beforeEach, describe, expect, test } from "vitest";

import {
  getHistorySyncConfig,
  getHistorySyncPendingEvents,
  registerHistorySyncFacadeControl,
  resetHistorySyncFacadeControlForTest,
  resolveHistorySyncPendingEvents,
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
    prioritizeThreadSync: () => Effect.void,
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
    getPendingEvents: Effect.succeed({
      totalCount: 0,
      pushableCount: 0,
      deferredCount: 0,
      displayedCount: 0,
      omittedCount: 0,
      localMaxSequence: 0,
      remoteMaxSequence: 0,
      lastSyncedRemoteSequence: 0,
      events: [],
    }),
    resolvePendingEvents: () =>
      Effect.succeed({
        markedCount: 0,
        review: {
          totalCount: 0,
          pushableCount: 0,
          deferredCount: 0,
          displayedCount: 0,
          omittedCount: 0,
          localMaxSequence: 0,
          remoteMaxSequence: 0,
          lastSyncedRemoteSequence: 0,
          events: [],
        },
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
    const seenResolvedSequences: number[][] = [];
    registerHistorySyncFacadeControl(
      makeControl({
        testConnection: (input) =>
          Effect.sync(() => {
            seenConnections.push(input);
            return { success: true, message: "ok" };
          }),
        getPendingEvents: Effect.succeed({
          totalCount: 1,
          pushableCount: 0,
          deferredCount: 1,
          displayedCount: 1,
          omittedCount: 0,
          localMaxSequence: 42,
          remoteMaxSequence: 40,
          lastSyncedRemoteSequence: 40,
          events: [
            {
              sequence: 42,
              eventId: "event-42",
              eventType: "thread.message.created",
              aggregateKind: "thread",
              streamId: "thread-1",
              occurredAt: "2026-05-09T10:00:00.000Z",
              threadId: "thread-1",
              pushable: false,
              reason: "Deferred by autosync safety rules. Review before clearing.",
            },
          ],
        }),
        resolvePendingEvents: (input) =>
          Effect.sync(() => {
            seenResolvedSequences.push([...input.sequences]);
            return {
              markedCount: input.sequences.length,
              review: {
                totalCount: 0,
                pushableCount: 0,
                deferredCount: 0,
                displayedCount: 0,
                omittedCount: 0,
                localMaxSequence: 42,
                remoteMaxSequence: 40,
                lastSyncedRemoteSequence: 40,
                events: [],
              },
            };
          }),
      }),
    );

    await expect(Effect.runPromise(getHistorySyncConfig)).resolves.toEqual(config);
    await expect(Effect.runPromise(testHistorySyncConnection(mysql))).resolves.toEqual({
      success: true,
      message: "ok",
    });
    await expect(Effect.runPromise(getHistorySyncPendingEvents)).resolves.toMatchObject({
      totalCount: 1,
      deferredCount: 1,
      events: [{ sequence: 42, eventType: "thread.message.created" }],
    });
    await expect(
      Effect.runPromise(
        resolveHistorySyncPendingEvents({ action: "mark-synced", sequences: [42] }),
      ),
    ).resolves.toMatchObject({ markedCount: 1, review: { totalCount: 0 } });
    expect(seenConnections).toEqual([mysql]);
    expect(seenResolvedSequences).toEqual([[42]]);
  });
});
