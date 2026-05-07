import {
  HistorySyncConfigError,
  type HistorySyncConfig,
  type HistorySyncStatus,
  type OrchestrationEvent,
  type ServerSettingsError,
} from "@t3tools/contracts";
import { Duration, Effect, PubSub, Ref, Scope, Stream } from "effect";

export type HistorySyncMode = "initial" | "full" | "autosave";

export interface HistorySyncTiming {
  readonly shutdownFlushTimeoutMs: number;
}

export interface HistorySyncLifecycleController {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly syncNow: Effect.Effect<void>;
  readonly runSync: Effect.Effect<HistorySyncConfig, HistorySyncConfigError | ServerSettingsError>;
  readonly startInitialSync: Effect.Effect<
    HistorySyncConfig,
    HistorySyncConfigError | ServerSettingsError
  >;
  readonly restoreBackup: Effect.Effect<
    HistorySyncConfig,
    HistorySyncConfigError | ServerSettingsError
  >;
  readonly clearStopped: Effect.Effect<void>;
  readonly streamStatus: Stream.Stream<HistorySyncStatus>;
}

export const HISTORY_SYNC_STARTUP_DELAY_MS = 15_000;
export const HISTORY_SYNC_AUTOSAVE_DEBOUNCE_MS = 5_000;

export const createHistorySyncLifecycleController = (input: {
  readonly statusPubSub: PubSub.PubSub<HistorySyncStatus>;
  readonly loadTiming: Effect.Effect<HistorySyncTiming, ServerSettingsError>;
  readonly defaultTiming: HistorySyncTiming;
  readonly publishConfiguredStartupStatus: Effect.Effect<boolean, ServerSettingsError>;
  readonly performSync: (options: {
    readonly mode: HistorySyncMode;
    readonly autosaveMaxSequence?: number;
    readonly markStopped: Effect.Effect<void>;
  }) => Effect.Effect<void>;
  readonly toConfig: Effect.Effect<HistorySyncConfig, ServerSettingsError>;
  readonly restoreBackupFromDisk: Effect.Effect<void, HistorySyncConfigError>;
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;
  readonly shouldScheduleAutosaveForDomainEvent: (event: OrchestrationEvent) => boolean;
}): Effect.Effect<HistorySyncLifecycleController> =>
  Effect.gen(function* () {
    const runningRef = yield* Ref.make(false);
    const stoppedRef = yield* Ref.make(false);
    const pendingAutosaveRef = yield* Ref.make(false);
    const markStopped = Ref.set(stoppedRef, true);

    const runSyncMode = (
      mode: HistorySyncMode,
      options: { readonly clearStopped: boolean; readonly autosaveMaxSequence?: number },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const running = yield* Ref.get(runningRef);
        if (running) {
          if (mode === "autosave") {
            yield* Ref.set(pendingAutosaveRef, true);
          }
          return;
        }
        if (options.clearStopped) {
          yield* Ref.set(stoppedRef, false);
        } else {
          const stopped = yield* Ref.get(stoppedRef);
          if (stopped) return;
        }
        yield* Ref.set(runningRef, true);
        yield* input
          .performSync({
            mode,
            markStopped,
            ...(options.autosaveMaxSequence !== undefined
              ? { autosaveMaxSequence: options.autosaveMaxSequence }
              : {}),
          })
          .pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                yield* Ref.set(runningRef, false);
                const shouldReschedule = yield* Ref.getAndSet(pendingAutosaveRef, false);
                if (shouldReschedule) {
                  yield* Effect.sleep(HISTORY_SYNC_AUTOSAVE_DEBOUNCE_MS).pipe(
                    Effect.andThen(runSyncMode("autosave", { clearStopped: false })),
                  );
                }
              }),
            ),
          );
      });

    const syncNow = runSyncMode("full", { clearStopped: false });

    const runSync = runSyncMode("full", {
      clearStopped: true,
    }).pipe(Effect.andThen(input.toConfig));

    const startInitialSync = Ref.get(runningRef).pipe(
      Effect.flatMap((running) => {
        if (running) return input.toConfig;
        return Ref.set(stoppedRef, false).pipe(
          Effect.andThen(Ref.set(runningRef, true)),
          Effect.andThen(input.performSync({ mode: "initial", markStopped })),
          Effect.ensuring(Ref.set(runningRef, false)),
          Effect.andThen(input.toConfig),
        );
      }),
    );

    const restoreBackup = Ref.get(runningRef).pipe(
      Effect.flatMap((running) => {
        if (running) {
          return Effect.fail(
            new HistorySyncConfigError({
              message: "Cannot restore the history sync backup while sync is running.",
            }),
          );
        }
        return Ref.set(runningRef, true).pipe(
          Effect.andThen(input.restoreBackupFromDisk),
          Effect.ensuring(Ref.set(runningRef, false)),
          Effect.andThen(input.toConfig),
        );
      }),
    );

    const start = Effect.gen(function* () {
      const timing = yield* input.loadTiming.pipe(
        Effect.catch((error) =>
          Effect.logWarning("history sync using default timing because settings failed to load", {
            cause: error,
          }).pipe(Effect.as(input.defaultTiming)),
        ),
      );
      const syncWhenNotRunning = Ref.get(runningRef).pipe(
        Effect.flatMap((running) =>
          running
            ? Effect.void
            : input.publishConfiguredStartupStatus.pipe(
                Effect.flatMap((shouldSync) => (shouldSync ? syncNow : Effect.void)),
              ),
        ),
      );
      yield* Effect.sleep(HISTORY_SYNC_STARTUP_DELAY_MS).pipe(
        Effect.andThen(syncWhenNotRunning),
        Effect.forkScoped,
      );
      yield* Effect.addFinalizer(() =>
        runSyncMode("autosave", { clearStopped: false }).pipe(
          Effect.timeout(timing.shutdownFlushTimeoutMs),
          Effect.ignore({ log: true }),
        ),
      );
      yield* input.streamDomainEvents.pipe(
        Stream.filter(input.shouldScheduleAutosaveForDomainEvent),
        Stream.debounce(Duration.millis(HISTORY_SYNC_AUTOSAVE_DEBOUNCE_MS)),
        Stream.runForEach((event) =>
          runSyncMode("autosave", {
            clearStopped: false,
            autosaveMaxSequence: event.sequence,
          }),
        ),
        Effect.forkScoped,
      );
    });

    return {
      start,
      syncNow,
      runSync,
      startInitialSync,
      restoreBackup,
      clearStopped: Ref.set(stoppedRef, false),
      get streamStatus() {
        return Stream.fromPubSub(input.statusPubSub);
      },
    };
  });
