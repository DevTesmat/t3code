import {
  type HistorySyncConfig,
  type HistorySyncStatus,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Deferred, Effect, Exit, Fiber, PubSub, Ref, Stream } from "effect";
import { describe, expect, test } from "vitest";

import {
  createHistorySyncLifecycleController,
  type HistorySyncMode,
  type HistorySyncTiming,
} from "./lifecycle.ts";

const config: HistorySyncConfig = {
  enabled: true,
  configured: true,
  status: { state: "idle", configured: true, lastSyncedAt: null },
  intervalMs: 120_000,
  shutdownFlushTimeoutMs: 5_000,
  statusIndicatorEnabled: true,
};

const timing: HistorySyncTiming = { shutdownFlushTimeoutMs: 5_000 };

const syncingStatus = {
  state: "syncing",
  configured: true,
  startedAt: "2026-05-07T12:00:00.000Z",
  lastSyncedAt: "2026-05-07T11:00:00.000Z",
} satisfies HistorySyncStatus;

const idleStatus = {
  state: "idle",
  configured: true,
  lastSyncedAt: "2026-05-07T12:01:00.000Z",
} satisfies HistorySyncStatus;

function makeStatusHarness() {
  return Effect.gen(function* () {
    const statusRef = yield* Ref.make<HistorySyncStatus>(config.status);
    const statusPubSub = yield* PubSub.unbounded<HistorySyncStatus>();
    const publishStatus = (status: HistorySyncStatus) =>
      Ref.set(statusRef, status).pipe(Effect.andThen(PubSub.publish(statusPubSub, status)));
    const recoverStuckSyncStatus = Effect.gen(function* () {
      const status = yield* Ref.get(statusRef);
      if (status.state !== "syncing") {
        return;
      }
      const activeStartedAt = status.startedAt;
      const currentStatus = yield* Ref.get(statusRef);
      if (currentStatus.state !== "syncing" || currentStatus.startedAt !== activeStartedAt) {
        return;
      }
      yield* publishStatus({
        state: "error",
        configured: true,
        message: "History sync stopped before completion.",
        lastSyncedAt: currentStatus.lastSyncedAt,
      });
    });
    return { statusRef, statusPubSub, publishStatus, recoverStuckSyncStatus };
  });
}

describe("history sync lifecycle", () => {
  test("blocks restore while a sync is running", async () => {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { statusPubSub, recoverStuckSyncStatus } = yield* makeStatusHarness();
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const controller = yield* createHistorySyncLifecycleController({
            statusPubSub,
            loadTiming: Effect.succeed(timing),
            defaultTiming: timing,
            publishConfiguredStartupStatus: Effect.succeed(false),
            performSync: () =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
            recoverStuckSyncStatus,
            toConfig: Effect.succeed(config),
            restoreBackupFromDisk: Effect.void,
            streamDomainEvents: Stream.empty as Stream.Stream<OrchestrationEvent>,
            shouldScheduleAutosaveForDomainEvent: () => false,
          });

          const syncFiber = yield* controller.runSync.pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          const restoreExit = yield* Effect.exit(controller.restoreBackup);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(syncFiber);
          return restoreExit;
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain(
        "Cannot restore the history sync backup while sync is running.",
      );
    }
  });

  test("manual sync clears stopped autosave state", async () => {
    const calls = await Effect.runPromise(
      Effect.gen(function* () {
        const { statusPubSub, recoverStuckSyncStatus } = yield* makeStatusHarness();
        const modes: HistorySyncMode[] = [];
        const controller = yield* createHistorySyncLifecycleController({
          statusPubSub,
          loadTiming: Effect.succeed(timing),
          defaultTiming: timing,
          publishConfiguredStartupStatus: Effect.succeed(false),
          performSync: (options) =>
            Effect.sync(() => {
              modes.push(options.mode);
            }).pipe(Effect.andThen(options.markStopped)),
          recoverStuckSyncStatus,
          toConfig: Effect.succeed(config),
          restoreBackupFromDisk: Effect.void,
          streamDomainEvents: Stream.empty as Stream.Stream<OrchestrationEvent>,
          shouldScheduleAutosaveForDomainEvent: () => false,
        });

        yield* controller.runSync;
        yield* controller.syncNow;
        yield* controller.runSync;
        return modes;
      }),
    );

    expect(calls).toEqual(["full", "full"]);
  });

  test("recovers syncing status when performSync fails after publishing syncing", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const { statusRef, statusPubSub, publishStatus, recoverStuckSyncStatus } =
          yield* makeStatusHarness();
        const controller = yield* createHistorySyncLifecycleController({
          statusPubSub,
          loadTiming: Effect.succeed(timing),
          defaultTiming: timing,
          publishConfiguredStartupStatus: Effect.succeed(false),
          performSync: () =>
            publishStatus(syncingStatus).pipe(Effect.andThen(Effect.die(new Error("boom")))),
          recoverStuckSyncStatus,
          toConfig: Effect.succeed(config),
          restoreBackupFromDisk: Effect.void,
          streamDomainEvents: Stream.empty as Stream.Stream<OrchestrationEvent>,
          shouldScheduleAutosaveForDomainEvent: () => false,
        });

        yield* Effect.exit(controller.syncNow);
        return yield* Ref.get(statusRef);
      }),
    );

    expect(status).toEqual({
      state: "error",
      configured: true,
      message: "History sync stopped before completion.",
      lastSyncedAt: syncingStatus.lastSyncedAt,
    });
  });

  test("recovers syncing status when a running sync is interrupted", async () => {
    const status = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { statusRef, statusPubSub, publishStatus, recoverStuckSyncStatus } =
            yield* makeStatusHarness();
          const started = yield* Deferred.make<void>();
          const controller = yield* createHistorySyncLifecycleController({
            statusPubSub,
            loadTiming: Effect.succeed(timing),
            defaultTiming: timing,
            publishConfiguredStartupStatus: Effect.succeed(false),
            performSync: () =>
              publishStatus(syncingStatus).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Effect.never),
              ),
            recoverStuckSyncStatus,
            toConfig: Effect.succeed(config),
            restoreBackupFromDisk: Effect.void,
            streamDomainEvents: Stream.empty as Stream.Stream<OrchestrationEvent>,
            shouldScheduleAutosaveForDomainEvent: () => false,
          });

          const syncFiber = yield* controller.syncNow.pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(syncFiber);
          return yield* Ref.get(statusRef);
        }),
      ),
    );

    expect(status).toEqual({
      state: "error",
      configured: true,
      message: "History sync stopped before completion.",
      lastSyncedAt: syncingStatus.lastSyncedAt,
    });
  });

  test("does not replace a terminal status already published by performSync", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const { statusRef, statusPubSub, publishStatus, recoverStuckSyncStatus } =
          yield* makeStatusHarness();
        const controller = yield* createHistorySyncLifecycleController({
          statusPubSub,
          loadTiming: Effect.succeed(timing),
          defaultTiming: timing,
          publishConfiguredStartupStatus: Effect.succeed(false),
          performSync: () =>
            publishStatus(syncingStatus).pipe(
              Effect.andThen(publishStatus(idleStatus)),
              Effect.andThen(Effect.die(new Error("boom"))),
            ),
          recoverStuckSyncStatus,
          toConfig: Effect.succeed(config),
          restoreBackupFromDisk: Effect.void,
          streamDomainEvents: Stream.empty as Stream.Stream<OrchestrationEvent>,
          shouldScheduleAutosaveForDomainEvent: () => false,
        });

        yield* Effect.exit(controller.syncNow);
        return yield* Ref.get(statusRef);
      }),
    );

    expect(status).toEqual(idleStatus);
  });
});
