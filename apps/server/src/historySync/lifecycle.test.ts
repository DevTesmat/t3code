import { type HistorySyncConfig, type OrchestrationEvent } from "@t3tools/contracts";
import { Deferred, Effect, Exit, Fiber, PubSub, Stream } from "effect";
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

describe("history sync lifecycle", () => {
  test("blocks restore while a sync is running", async () => {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const statusPubSub = yield* PubSub.unbounded<typeof config.status>();
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const controller = yield* createHistorySyncLifecycleController({
            statusPubSub,
            loadTiming: Effect.succeed(timing),
            defaultTiming: timing,
            publishConfiguredStartupStatus: Effect.succeed(false),
            performSync: () =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
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
        const statusPubSub = yield* PubSub.unbounded<typeof config.status>();
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
});
