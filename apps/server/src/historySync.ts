import {
  HistorySyncConfigError,
  type HistorySyncConfig,
  type HistorySyncConnectionTestResult,
  type HistorySyncMysqlFields,
  type HistorySyncProjectMappingPlan,
  type HistorySyncProjectMappingsApplyInput,
  type HistorySyncStatus,
  type HistorySyncUpdateConfigInput,
} from "@t3tools/contracts";
import { Context, Duration, Effect, Layer, PubSub, Ref, Scope, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerSecretStore } from "./auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "./config.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import type { ServerSettingsError } from "@t3tools/contracts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import {
  type ProjectionBootstrapProgress,
  subscribeProjectionBootstrapProgress,
} from "./orchestration/Layers/ProjectionPipeline.ts";
import * as HistorySyncBackup from "./historySync/backup.ts";
import * as LocalHistoryRepository from "./historySync/localRepository.ts";
import * as ProjectMappings from "./historySync/projectMappings.ts";

export const HISTORY_SYNC_CONNECTION_STRING_SECRET = "history-sync-mysql-connection-string";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const DISABLED_HISTORY_SYNC_STATUS: HistorySyncStatus = { state: "disabled", configured: false };
let latestHistorySyncStatus: HistorySyncStatus = DISABLED_HISTORY_SYNC_STATUS;
const historySyncStatusSubscribers = new Set<(status: HistorySyncStatus) => Effect.Effect<void>>();
let latestHistorySyncControl: Pick<
  HistorySyncServiceShape,
  | "getConfig"
  | "updateConfig"
  | "runSync"
  | "startInitialSync"
  | "restoreBackup"
  | "testConnection"
  | "getProjectMappings"
  | "applyProjectMappings"
> | null = null;
const defaultHistorySyncTiming = {
  intervalMs: 120_000,
  shutdownFlushTimeoutMs: 5_000,
};
const HISTORY_SYNC_OPERATION_TIMEOUT_MS = 10 * 60_000;
const HISTORY_SYNC_STARTUP_DELAY_MS = 15_000;
const HISTORY_SYNC_AUTOSAVE_DEBOUNCE_MS = 5_000;
const HISTORY_SYNC_RETRY_DELAYS_MS = [10_000, 3 * 60_000, 10 * 60_000, 10 * 60_000, 10 * 60_000];
const HISTORY_SYNC_RECENT_FAILURE_LIMIT = 5;

interface HistorySyncProgress {
  readonly phase: string;
  readonly label: string;
  readonly current: number;
  readonly total: number;
}

interface HistorySyncRetryFailure {
  readonly failedAt: string;
  readonly message: string;
  readonly attempt: number;
}

interface HistorySyncRetryContext {
  readonly firstFailedAt: string;
  readonly recentFailures: readonly HistorySyncRetryFailure[];
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function describeSyncFailure(error: unknown): string {
  const wrappedCause =
    typeof error === "object" && error !== null && "cause" in error
      ? (error as { readonly cause?: unknown }).cause
      : undefined;
  return describeUnknownError(wrappedCause ?? error) || "History sync failed.";
}

export function nextHistorySyncRetryDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  return HISTORY_SYNC_RETRY_DELAYS_MS[attempt - 1] ?? null;
}

function appendHistorySyncRetryFailure(
  failures: readonly HistorySyncRetryFailure[],
  failure: HistorySyncRetryFailure,
): readonly HistorySyncRetryFailure[] {
  return [...failures, failure].slice(-HISTORY_SYNC_RECENT_FAILURE_LIMIT);
}

function clampHistorySyncProgress(progress: HistorySyncProgress): HistorySyncProgress {
  const total = Math.max(1, Math.floor(progress.total));
  return {
    phase: progress.phase,
    label: progress.label,
    current: Math.min(total, Math.max(0, Math.floor(progress.current))),
    total,
  };
}

function projectionProgressLabel(progress: ProjectionBootstrapProgress): string {
  return `Projecting ${progress.projector.replace(/^projection\./, "").replace(/-/g, " ")}`;
}

function logHistorySyncStatus(status: HistorySyncStatus): void {
  switch (status.state) {
    case "disabled":
      console.info("[history-sync] disabled", { configured: status.configured });
      return;
    case "needs-initial-sync":
      console.info("[history-sync] waiting for explicit initial sync", {
        configured: status.configured,
        lastSyncedAt: status.lastSyncedAt,
      });
      return;
    case "syncing":
      console.info("[history-sync] syncing", {
        startedAt: status.startedAt,
        lastSyncedAt: status.lastSyncedAt,
      });
      return;
    case "retrying":
      console.warn("[history-sync] retrying after connection failure", {
        message: status.message,
        attempt: status.attempt,
        maxAttempts: status.maxAttempts,
        nextRetryAt: status.nextRetryAt,
        lastSyncedAt: status.lastSyncedAt,
      });
      return;
    case "idle":
      console.info("[history-sync] idle", { lastSyncedAt: status.lastSyncedAt });
      return;
    case "error":
      console.error("[history-sync] stopped after error", {
        message: status.message,
        lastSyncedAt: status.lastSyncedAt,
      });
      return;
    case "needs-project-mapping":
      console.warn("[history-sync] waiting for project mapping", {
        remoteMaxSequence: status.remoteMaxSequence,
        unresolvedProjectCount: status.unresolvedProjectCount,
        lastSyncedAt: status.lastSyncedAt,
      });
      return;
  }
}

export function readHistorySyncStatus(): HistorySyncStatus {
  return latestHistorySyncStatus;
}

export function subscribeHistorySyncStatus(
  subscriber: (status: HistorySyncStatus) => Effect.Effect<void>,
): Effect.Effect<() => void> {
  return Effect.sync(() => {
    historySyncStatusSubscribers.add(subscriber);
    return () => {
      historySyncStatusSubscribers.delete(subscriber);
    };
  });
}

export const getHistorySyncConfig = Effect.suspend(() =>
  latestHistorySyncControl
    ? latestHistorySyncControl.getConfig
    : Effect.succeed({
        enabled: false,
        configured: false,
        status: latestHistorySyncStatus,
        intervalMs: defaultHistorySyncTiming.intervalMs,
        shutdownFlushTimeoutMs: defaultHistorySyncTiming.shutdownFlushTimeoutMs,
        statusIndicatorEnabled: true,
      } satisfies HistorySyncConfig),
);

export const updateHistorySyncConfig = (input: HistorySyncUpdateConfigInput) =>
  Effect.suspend(() =>
    latestHistorySyncControl
      ? latestHistorySyncControl.updateConfig(input)
      : Effect.fail(
          new HistorySyncConfigError({
            message: "History sync service is not ready.",
          }),
        ),
  );

export const startHistorySyncInitialImport = Effect.suspend(() =>
  latestHistorySyncControl
    ? latestHistorySyncControl.startInitialSync
    : Effect.fail(
        new HistorySyncConfigError({
          message: "History sync service is not ready.",
        }),
      ),
);

export const runHistorySync = Effect.suspend(() =>
  latestHistorySyncControl
    ? latestHistorySyncControl.runSync
    : Effect.fail(
        new HistorySyncConfigError({
          message: "History sync service is not ready.",
        }),
      ),
);

export const restoreHistorySyncBackup = Effect.suspend(() =>
  latestHistorySyncControl
    ? latestHistorySyncControl.restoreBackup
    : Effect.fail(
        new HistorySyncConfigError({
          message: "History sync service is not ready.",
        }),
      ),
);

export const testHistorySyncConnection = (input: HistorySyncMysqlFields) =>
  Effect.suspend(() =>
    latestHistorySyncControl
      ? latestHistorySyncControl.testConnection(input)
      : Effect.fail(
          new HistorySyncConfigError({
            message: "History sync service is not ready.",
          }),
        ),
  );

export const getHistorySyncProjectMappings = Effect.suspend(() =>
  latestHistorySyncControl
    ? latestHistorySyncControl.getProjectMappings
    : Effect.fail(
        new HistorySyncConfigError({
          message: "History sync service is not ready.",
        }),
      ),
);

export const applyHistorySyncProjectMappings = (input: HistorySyncProjectMappingsApplyInput) =>
  Effect.suspend(() =>
    latestHistorySyncControl
      ? latestHistorySyncControl.applyProjectMappings(input)
      : Effect.fail(
          new HistorySyncConfigError({
            message: "History sync service is not ready.",
          }),
        ),
  );

export type {
  HistorySyncAutosyncProjectionThreadRow,
  HistorySyncAutosyncThreadState,
  HistorySyncEventRow,
  HistorySyncProjectMappingRow,
  HistorySyncPushedEventReceiptRow,
} from "./historySync/planner.ts";
export {
  buildFirstSyncClientMergeEvents,
  buildFirstSyncRescueEvents,
  buildPushedEventReceiptRows,
  chunkHistorySyncEvents,
  classifyAutosyncThreadStates,
  collectProjectCandidates,
  computeThreadUserSequenceHash,
  countActiveThreadCreates,
  filterAlreadyImportedRemoteDeltaEvents,
  filterPushableLocalEvents,
  filterUnpushedLocalEvents,
  isAutosyncEligibleThread,
  isRemoteBehindLocal,
  nextSyncedRemoteSequenceAfterPush,
  normalizeRemoteEventForLocalImport,
  normalizeRemoteEventsForLocalImport,
  rewriteLocalEventsForRemoteMappings,
  rewriteRemoteEventsForLocalMappings,
  selectAutosaveCandidateLocalEvents,
  selectAutosaveContiguousPushableEvents,
  selectAutosaveRemoteCoveredReceiptEvents,
  selectKnownRemoteDeltaLocalEvents,
  selectPushedReceiptSeedEvents,
  selectRemoteBehindLocalEvents,
  selectRemoteDeltaEvents,
  selectUnknownRemoteDeltaEvents,
  shouldImportRemoteIntoEmptyLocal,
  shouldPushLocalHistoryOnFirstSync,
  shouldRunAutomaticHistorySync,
  shouldScheduleAutosaveForDomainEvent,
} from "./historySync/planner.ts";
import {
  buildFirstSyncClientMergeEvents,
  classifyAutosyncThreadStates,
  collectProjectCandidates,
  countActiveThreadCreates,
  filterAlreadyImportedRemoteDeltaEvents,
  filterPushableLocalEvents,
  isRemoteBehindLocal,
  nextSyncedRemoteSequenceAfterPush,
  normalizeRemoteEventsForLocalImport,
  rewriteLocalEventsForRemoteMappings,
  rewriteRemoteEventsForLocalMappings,
  selectAutosaveCandidateLocalEvents,
  selectAutosaveContiguousPushableEvents,
  selectAutosaveRemoteCoveredReceiptEvents,
  selectKnownRemoteDeltaLocalEvents,
  selectRemoteBehindLocalEvents,
  selectRemoteDeltaEvents,
  selectUnknownRemoteDeltaEvents,
  shouldImportRemoteIntoEmptyLocal,
  shouldPushLocalHistoryOnFirstSync,
  shouldRunAutomaticHistorySync,
  shouldScheduleAutosaveForDomainEvent,
  type HistorySyncEventRow,
} from "./historySync/planner.ts";
export {
  buildMysqlConnectionString,
  isRetryableHistorySyncConnectionFailure,
  toConnectionSummary,
  validateMysqlFields,
} from "./historySync/remoteStore.ts";
import {
  buildMysqlConnectionString,
  isRetryableHistorySyncConnectionFailure,
  pushRemoteEventsBatched,
  readRemoteEvents,
  readRemoteMaxSequence,
  testConnectionString,
  toConnectionSummary,
} from "./historySync/remoteStore.ts";

type HistorySyncMode = "initial" | "full" | "autosave";

export interface HistorySyncServiceShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly syncNow: Effect.Effect<void>;
  readonly runSync: Effect.Effect<HistorySyncConfig, HistorySyncConfigError | ServerSettingsError>;
  readonly getStatus: Effect.Effect<HistorySyncStatus>;
  readonly getConfig: Effect.Effect<HistorySyncConfig, ServerSettingsError>;
  readonly updateConfig: (
    input: HistorySyncUpdateConfigInput,
  ) => Effect.Effect<HistorySyncConfig, HistorySyncConfigError | ServerSettingsError>;
  readonly startInitialSync: Effect.Effect<
    HistorySyncConfig,
    HistorySyncConfigError | ServerSettingsError
  >;
  readonly restoreBackup: Effect.Effect<
    HistorySyncConfig,
    HistorySyncConfigError | ServerSettingsError
  >;
  readonly testConnection: (
    input: HistorySyncMysqlFields,
  ) => Effect.Effect<HistorySyncConnectionTestResult, HistorySyncConfigError>;
  readonly getProjectMappings: Effect.Effect<HistorySyncProjectMappingPlan, HistorySyncConfigError>;
  readonly applyProjectMappings: (
    input: HistorySyncProjectMappingsApplyInput,
  ) => Effect.Effect<HistorySyncProjectMappingPlan, HistorySyncConfigError>;
  readonly streamStatus: Stream.Stream<HistorySyncStatus>;
}

export class HistorySyncService extends Context.Service<
  HistorySyncService,
  HistorySyncServiceShape
>()("t3/historySync/HistorySyncService") {}

export const HistorySyncServiceLive = Layer.effect(
  HistorySyncService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const secretStore = yield* ServerSecretStore;
    const settingsService = yield* ServerSettingsService;
    const engine = yield* OrchestrationEngineService;
    const serverConfig = yield* ServerConfig;
    const statusRef = yield* Ref.make<HistorySyncStatus>(DISABLED_HISTORY_SYNC_STATUS);
    const statusPubSub = yield* PubSub.unbounded<HistorySyncStatus>();
    const runningRef = yield* Ref.make(false);
    const stoppedRef = yield* Ref.make(false);
    const pendingAutosaveRef = yield* Ref.make(false);
    let syncNowEffect: Effect.Effect<void> = Effect.void;

    const publishStatus = (status: HistorySyncStatus) =>
      Effect.sync(() => {
        latestHistorySyncStatus = status;
        logHistorySyncStatus(status);
      }).pipe(
        Effect.andThen(
          Effect.all(
            [
              Ref.set(statusRef, status),
              PubSub.publish(statusPubSub, status),
              ...[...historySyncStatusSubscribers].map((subscriber) =>
                subscriber(status).pipe(Effect.ignore({ log: true })),
              ),
            ],
            { concurrency: "unbounded" },
          ),
        ),
        Effect.asVoid,
      );

    const publishSyncProgress = (input: {
      readonly startedAt: string;
      readonly lastSyncedAt: string | null;
      readonly progress: HistorySyncProgress;
    }) =>
      publishStatus({
        state: "syncing",
        configured: true,
        startedAt: input.startedAt,
        lastSyncedAt: input.lastSyncedAt,
        progress: clampHistorySyncProgress(input.progress),
      });

    const getConnectionString = Effect.gen(function* () {
      const secret = yield* secretStore.get(HISTORY_SYNC_CONNECTION_STRING_SECRET).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to read history sync connection string", {
            cause: error,
          }).pipe(Effect.as(null)),
        ),
      );
      const value = secret ? textDecoder.decode(secret).trim() : "";
      return value.length > 0 ? value : null;
    });

    const toConfig = Effect.gen(function* () {
      const [settings, connectionString, status, state, backup] = yield* Effect.all([
        settingsService.getSettings,
        getConnectionString,
        Ref.get(statusRef),
        readState.pipe(Effect.catch(() => Effect.succeed(null))),
        HistorySyncBackup.readBackupSummary(serverConfig.dbPath),
      ]);
      const effectiveStatus =
        connectionString !== null &&
        state?.hasCompletedInitialSync !== 1 &&
        status.state !== "syncing" &&
        status.state !== "needs-project-mapping" &&
        status.state !== "error"
          ? ({
              state: "needs-initial-sync",
              configured: true,
              lastSyncedAt: state?.lastSuccessfulSyncAt ?? null,
            } satisfies HistorySyncStatus)
          : status;
      return {
        enabled: settings.historySync.enabled,
        configured: connectionString !== null,
        status: {
          ...effectiveStatus,
          configured: connectionString !== null,
        },
        intervalMs: settings.historySync.intervalMs,
        shutdownFlushTimeoutMs: settings.historySync.shutdownFlushTimeoutMs,
        statusIndicatorEnabled: settings.historySync.statusIndicatorEnabled,
        ...(settings.historySync.connectionSummary
          ? { connectionSummary: settings.historySync.connectionSummary }
          : {}),
        ...(backup ? { backup } : {}),
      } satisfies HistorySyncConfig;
    });

    const testConnection: HistorySyncServiceShape["testConnection"] = (mysql) =>
      Effect.try({
        try: () => buildMysqlConnectionString(mysql),
        catch: (cause) => new HistorySyncConfigError({ message: describeUnknownError(cause) }),
      }).pipe(
        Effect.flatMap((connectionString) => testConnectionString(connectionString)),
        Effect.as({ success: true } satisfies HistorySyncConnectionTestResult),
        Effect.catch((cause) =>
          Effect.succeed({
            success: false,
            message: describeSyncFailure(cause),
          } satisfies HistorySyncConnectionTestResult),
        ),
      );

    const updateConfig: HistorySyncServiceShape["updateConfig"] = (input) =>
      Effect.gen(function* () {
        if (input.clearConnection && input.mysql) {
          return yield* new HistorySyncConfigError({
            message: "Cannot clear and update the MySQL connection in the same request.",
          });
        }

        let connectionSummary = undefined as ReturnType<typeof toConnectionSummary> | undefined;
        let connectionString = null as string | null;
        if (input.mysql) {
          try {
            connectionString = buildMysqlConnectionString(input.mysql);
            connectionSummary = toConnectionSummary(input.mysql);
          } catch (cause) {
            return yield* new HistorySyncConfigError({
              message: describeUnknownError(cause),
            });
          }

          const testResult = yield* testConnectionString(connectionString).pipe(
            Effect.as({ success: true } satisfies HistorySyncConnectionTestResult),
            Effect.catch((cause) =>
              Effect.succeed({
                success: false,
                message: describeSyncFailure(cause),
              } satisfies HistorySyncConnectionTestResult),
            ),
          );
          if (!testResult.success) {
            return yield* new HistorySyncConfigError({
              message: testResult.message ?? "MySQL connection test failed.",
            });
          }
        }

        if (connectionString !== null) {
          yield* secretStore
            .set(HISTORY_SYNC_CONNECTION_STRING_SECRET, textEncoder.encode(connectionString))
            .pipe(
              Effect.mapError(
                (_cause) =>
                  new HistorySyncConfigError({
                    message: "Failed to store MySQL connection secret.",
                  }),
              ),
            );
          yield* Ref.set(stoppedRef, false);
        } else if (input.clearConnection) {
          yield* secretStore.remove(HISTORY_SYNC_CONNECTION_STRING_SECRET).pipe(
            Effect.mapError(
              (_cause) =>
                new HistorySyncConfigError({
                  message: "Failed to clear MySQL connection secret.",
                }),
            ),
          );
          yield* Ref.set(stoppedRef, false);
        }

        const current = yield* settingsService.getSettings;
        const nextHistorySync = {
          ...current.historySync,
          ...input.settings,
          ...(connectionSummary ? { connectionSummary } : {}),
          ...(input.clearConnection ? { connectionSummary: null } : {}),
        };
        yield* settingsService.updateSettings({
          historySync: nextHistorySync,
        });

        const syncEnabled = input.settings?.enabled ?? current.historySync.enabled;
        const nextConnectionString =
          connectionString !== null ? connectionString : yield* getConnectionString;
        if (syncEnabled && nextConnectionString !== null) {
          const state = yield* readState.pipe(
            Effect.mapError(
              (cause) =>
                new HistorySyncConfigError({
                  message: describeSyncFailure(cause),
                }),
            ),
          );
          yield* Ref.set(stoppedRef, false);
          if (state?.hasCompletedInitialSync !== 1) {
            yield* publishStatus({
              state: "needs-initial-sync",
              configured: true,
              lastSyncedAt: state?.lastSuccessfulSyncAt ?? null,
            });
          } else {
            yield* publishStatus({
              state: "idle",
              configured: true,
              lastSyncedAt: state?.lastSuccessfulSyncAt ?? null,
            });
          }
        } else if (nextConnectionString !== null) {
          const state = yield* readState.pipe(
            Effect.mapError(
              (cause) =>
                new HistorySyncConfigError({
                  message: describeSyncFailure(cause),
                }),
            ),
          );
          if (state?.hasCompletedInitialSync === 1) {
            yield* publishStatus({
              state: "disabled",
              configured: true,
            });
          } else {
            yield* publishStatus({
              state: "needs-initial-sync",
              configured: true,
              lastSyncedAt: state?.lastSuccessfulSyncAt ?? null,
            });
          }
        } else {
          yield* publishStatus({
            state: "disabled",
            configured: false,
          });
        }
        return yield* toConfig;
      });

    const getProjectMappings: HistorySyncServiceShape["getProjectMappings"] = Effect.gen(
      function* () {
        const connectionString = yield* getConnectionString;
        if (connectionString === null) {
          return yield* new HistorySyncConfigError({
            message: "History sync MySQL connection is not configured.",
          });
        }
        const remoteEvents = yield* readRemoteEvents(connectionString).pipe(
          Effect.mapError(
            (cause) =>
              new HistorySyncConfigError({
                message: describeSyncFailure(cause),
              }),
          ),
        );
        const remoteMaxSequence = Math.max(0, ...remoteEvents.map((event) => event.sequence));
        const plan = yield* ProjectMappings.buildProjectMappingPlanFromEvents(sql, {
          remoteEvents,
          remoteMaxSequence,
        });
        yield* ProjectMappings.autoPersistExactProjectMappings(sql, plan);
        return yield* ProjectMappings.buildProjectMappingPlanFromEvents(sql, {
          remoteEvents,
          remoteMaxSequence,
        });
      },
    ).pipe(
      Effect.mapError(
        (cause) => new HistorySyncConfigError({ message: describeSyncFailure(cause) }),
      ),
    );

    const applyProjectMappings: HistorySyncServiceShape["applyProjectMappings"] = (input) =>
      Effect.gen(function* () {
        const connectionString = yield* getConnectionString;
        if (connectionString === null) {
          return yield* new HistorySyncConfigError({
            message: "History sync MySQL connection is not configured.",
          });
        }
        const remoteEvents = yield* readRemoteEvents(connectionString).pipe(
          Effect.mapError(
            (cause) =>
              new HistorySyncConfigError({
                message: describeSyncFailure(cause),
              }),
          ),
        );
        const remoteMaxSequence = Math.max(0, ...remoteEvents.map((event) => event.sequence));
        const expectedSyncId = yield* ProjectMappings.getSyncId(sql, remoteMaxSequence);
        if (input.syncId !== expectedSyncId) {
          return yield* new HistorySyncConfigError({
            message: "History sync mapping plan is stale. Reload the project mapping wizard.",
          });
        }

        const now = new Date().toISOString();
        yield* ProjectMappings.applyMappingActions(sql, {
          actions: input.actions,
          remoteEvents,
          now,
        });
        yield* Ref.set(stoppedRef, false);
        const state = yield* readState;
        if (state?.hasCompletedInitialSync === 1) {
          yield* syncNowEffect;
        } else {
          yield* startInitialSync;
        }
        return yield* ProjectMappings.buildProjectMappingPlanFromEvents(sql, {
          remoteEvents,
          remoteMaxSequence,
        });
      }).pipe(
        Effect.mapError(
          (cause) => new HistorySyncConfigError({ message: describeSyncFailure(cause) }),
        ),
      );

    const readLocalEvents = (sequenceExclusive = 0) =>
      LocalHistoryRepository.readLocalEvents(sql, sequenceExclusive);

    const readUnpushedLocalEvents = LocalHistoryRepository.readUnpushedLocalEvents(sql);

    const readProjectionThreadAutosyncRows =
      LocalHistoryRepository.readProjectionThreadAutosyncRows(sql);

    const writePushedEventReceipts = (events: readonly HistorySyncEventRow[], pushedAt: string) =>
      LocalHistoryRepository.writePushedEventReceipts(sql, events, pushedAt);

    const seedPushedEventReceiptsForCompletedSync = (
      events: readonly HistorySyncEventRow[],
      input: {
        readonly hasCompletedInitialSync: boolean;
        readonly lastSyncedRemoteSequence: number;
        readonly seededAt: string;
      },
    ) => LocalHistoryRepository.seedPushedEventReceiptsForCompletedSync(sql, events, input);

    const readLocalProjectionCounts = LocalHistoryRepository.readLocalProjectionCounts(sql);

    const readState = LocalHistoryRepository.readState(sql);

    const writeState = (input: {
      readonly hasCompletedInitialSync: boolean;
      readonly lastSyncedRemoteSequence: number;
      readonly lastSuccessfulSyncAt: string;
    }) => LocalHistoryRepository.writeState(sql, input);

    const publishConfiguredStartupStatus = Effect.gen(function* () {
      const [settings, connectionString, state] = yield* Effect.all([
        settingsService.getSettings,
        getConnectionString,
        readState.pipe(Effect.catch(() => Effect.succeed(null))),
      ]);
      const hasCompletedInitialSync = state?.hasCompletedInitialSync === 1;
      if (
        !shouldRunAutomaticHistorySync({
          enabled: settings.historySync.enabled,
          configured: connectionString !== null,
          hasCompletedInitialSync,
        })
      ) {
        if (connectionString !== null && !hasCompletedInitialSync) {
          yield* publishStatus({
            state: "needs-initial-sync",
            configured: true,
            lastSyncedAt: state?.lastSuccessfulSyncAt ?? null,
          });
          return false;
        }
        yield* publishStatus({
          state: "disabled",
          configured: connectionString !== null,
        });
        return false;
      }
      return true;
    });

    const importRemoteEvents = (events: readonly HistorySyncEventRow[]) =>
      LocalHistoryRepository.importRemoteEvents(sql, events);

    const importRemoteDeltaEvents = (events: readonly HistorySyncEventRow[]) =>
      LocalHistoryRepository.importRemoteDeltaEvents(sql, events);

    const restoreBackupFromDisk = Effect.gen(function* () {
      yield* HistorySyncBackup.restoreBackupTablesFromDisk(sql, serverConfig.dbPath);
      if (engine.reloadFromStorage) {
        yield* engine.reloadFromStorage();
      }
      const restoredState = yield* readState.pipe(Effect.catch(() => Effect.succeed(null)));
      const connectionString = yield* getConnectionString;
      yield* publishStatus(
        connectionString !== null && restoredState?.hasCompletedInitialSync !== 1
          ? {
              state: "needs-initial-sync",
              configured: true,
              lastSyncedAt: restoredState?.lastSuccessfulSyncAt ?? null,
            }
          : {
              state: "idle",
              configured: connectionString !== null,
              lastSyncedAt: restoredState?.lastSuccessfulSyncAt ?? null,
            },
      );
    }).pipe(
      Effect.catchTag("HistorySyncConfigError", (cause) => Effect.fail(cause)),
      Effect.mapError(
        (cause) =>
          new HistorySyncConfigError({
            message: describeSyncFailure(cause),
          }),
      ),
    );

    const runImport = (
      events: readonly HistorySyncEventRow[],
      context: {
        readonly startedAt: string;
        readonly lastSyncedAt: string | null;
      },
      options: { readonly mode?: "replace" | "delta" } = {},
    ) =>
      Effect.gen(function* () {
        yield* publishSyncProgress({
          ...context,
          progress: {
            phase: "importing",
            label: "Importing history",
            current: 0,
            total: Math.max(1, events.length),
          },
        });
        yield* options.mode === "delta"
          ? importRemoteDeltaEvents(events)
          : importRemoteEvents(events);
        if (engine.reloadFromStorage) {
          const unsubscribe = yield* subscribeProjectionBootstrapProgress((progress) =>
            publishSyncProgress({
              ...context,
              progress: {
                phase: "projecting",
                label: projectionProgressLabel(progress),
                current: progress.projectedCount,
                total: Math.max(1, progress.maxSequence),
              },
            }),
          );
          yield* engine.reloadFromStorage().pipe(Effect.ensuring(Effect.sync(unsubscribe)));
        }
        const projectionCounts = yield* readLocalProjectionCounts;
        console.info("[history-sync] local import projected", {
          importedEvents: events.length,
          importedThreadCreates: events.filter((event) => event.eventType === "thread.created")
            .length,
          projectionCounts,
        });
      });

    const performSync = (options: {
      readonly mode: HistorySyncMode;
      readonly autosaveMaxSequence?: number;
      readonly retryAttempt?: number;
      readonly retryContext?: HistorySyncRetryContext;
    }): Effect.Effect<void> =>
      Effect.gen(function* () {
        const settings = yield* settingsService.getSettings;
        const connectionString = yield* getConnectionString;
        const state = yield* readState;
        const hasCompletedInitialSync = state?.hasCompletedInitialSync === 1;
        const isInitialSync = options.mode === "initial";
        const isAutosave = options.mode === "autosave";
        if (
          connectionString === null ||
          (!settings.historySync.enabled && !(isInitialSync && !hasCompletedInitialSync))
        ) {
          yield* publishStatus({
            state: "disabled",
            configured: connectionString !== null,
          });
          return;
        }

        const previousStatus = yield* Ref.get(statusRef);
        const lastSyncedAt =
          previousStatus.state === "idle" ||
          previousStatus.state === "syncing" ||
          previousStatus.state === "error" ||
          previousStatus.state === "needs-project-mapping" ||
          previousStatus.state === "needs-initial-sync"
            ? previousStatus.lastSyncedAt
            : null;
        const syncStartedAt = new Date().toISOString();
        const syncContext = { startedAt: syncStartedAt, lastSyncedAt };
        yield* publishStatus({
          state: "syncing",
          configured: true,
          startedAt: syncStartedAt,
          lastSyncedAt,
        });

        const localEvents = yield* readLocalEvents();
        const localProjectionCounts = yield* readLocalProjectionCounts;
        const localMaxSequence = Math.max(0, ...localEvents.map((event) => event.sequence));
        const lastSyncedRemoteSequence = state?.lastSyncedRemoteSequence ?? 0;
        yield* seedPushedEventReceiptsForCompletedSync(localEvents, {
          hasCompletedInitialSync,
          lastSyncedRemoteSequence,
          seededAt: syncStartedAt,
        });
        if (!hasCompletedInitialSync && !isInitialSync) {
          yield* publishStatus({
            state: "needs-initial-sync",
            configured: true,
            lastSyncedAt: state?.lastSuccessfulSyncAt ?? lastSyncedAt,
          });
          return;
        }
        if (!hasCompletedInitialSync && isInitialSync) {
          yield* HistorySyncBackup.createSqliteBackup(sql, serverConfig.dbPath);
        }

        if (isAutosave) {
          const remoteMaxSequence = yield* readRemoteMaxSequence(connectionString);
          let autosaveLastSyncedAt = lastSyncedAt;
          if (remoteMaxSequence > lastSyncedRemoteSequence) {
            const remoteDeltaEvents = yield* readRemoteEvents(
              connectionString,
              lastSyncedRemoteSequence,
            );
            const unknownRemoteDeltaEvents = selectUnknownRemoteDeltaEvents({
              remoteEvents: remoteDeltaEvents,
              localEvents,
            });
            if (unknownRemoteDeltaEvents.length > 0) {
              const message =
                "Remote history has newer events from another device. Run Sync now to import them before autosave.";
              console.warn("[history-sync] autosave skipped because remote has unknown events", {
                remoteMaxSequence,
                lastSyncedRemoteSequence,
                remoteDeltaEvents: remoteDeltaEvents.length,
                unknownRemoteDeltaEvents: unknownRemoteDeltaEvents.length,
              });
              yield* Ref.set(stoppedRef, true);
              yield* publishStatus({
                state: "error",
                configured: true,
                message,
                lastSyncedAt,
              });
              return;
            }

            const now = new Date().toISOString();
            const alreadyLocalRemoteDeltaEvents = selectKnownRemoteDeltaLocalEvents({
              remoteEvents: remoteDeltaEvents,
              localEvents,
            });
            yield* writePushedEventReceipts(alreadyLocalRemoteDeltaEvents, now);
            yield* writeState({
              hasCompletedInitialSync: true,
              lastSyncedRemoteSequence: remoteMaxSequence,
              lastSuccessfulSyncAt: now,
            });
            autosaveLastSyncedAt = now;
            console.info("[history-sync] autosave accepted remote delta already present locally", {
              remoteMaxSequence,
              lastSyncedRemoteSequence,
              remoteDeltaEvents: remoteDeltaEvents.length,
            });
          }

          const projectMappings = yield* ProjectMappings.readProjectMappings(sql);
          const unpushedLocalEvents = yield* readUnpushedLocalEvents;
          const projectionThreadRows = yield* readProjectionThreadAutosyncRows;
          const remoteCoveredReceiptEvents = selectAutosaveRemoteCoveredReceiptEvents({
            unpushedLocalEvents,
            remoteMaxSequence,
          });
          if (remoteCoveredReceiptEvents.length > 0) {
            const now = new Date().toISOString();
            yield* writePushedEventReceipts(remoteCoveredReceiptEvents, now);
            autosaveLastSyncedAt = now;
            console.info("[history-sync] autosave seeded receipts for remote-covered events", {
              events: remoteCoveredReceiptEvents.length,
              remoteMaxSequence,
            });
          }
          const candidateLocalEvents = selectAutosaveCandidateLocalEvents({
            localEvents,
            unpushedLocalEvents,
            remoteMaxSequence,
            ...(options.autosaveMaxSequence !== undefined
              ? { maxSequence: options.autosaveMaxSequence }
              : {}),
          });
          const pushableLocalEvents = selectAutosaveContiguousPushableEvents({
            candidateEvents: candidateLocalEvents,
            threadStates: classifyAutosyncThreadStates(localEvents, projectionThreadRows),
          });
          if (pushableLocalEvents.length > 0) {
            console.info("[history-sync] autosaving local pending history", {
              pendingEvents: pushableLocalEvents.length,
              deferredEvents: candidateLocalEvents.length - pushableLocalEvents.length,
              localMaxSequence,
              lastSyncedRemoteSequence: Math.max(lastSyncedRemoteSequence, remoteMaxSequence),
              remoteMaxSequence,
            });
            yield* pushRemoteEventsBatched(
              connectionString,
              rewriteLocalEventsForRemoteMappings(pushableLocalEvents, projectMappings),
            );
            const now = new Date().toISOString();
            yield* writePushedEventReceipts(pushableLocalEvents, now);
            const nextRemoteSequence = nextSyncedRemoteSequenceAfterPush(
              Math.max(lastSyncedRemoteSequence, remoteMaxSequence),
              pushableLocalEvents,
            );
            yield* writeState({
              hasCompletedInitialSync: true,
              lastSyncedRemoteSequence: nextRemoteSequence,
              lastSuccessfulSyncAt: now,
            });
            yield* publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
            return;
          }

          yield* publishStatus({
            state: "idle",
            configured: true,
            lastSyncedAt: autosaveLastSyncedAt,
          });
          return;
        }

        const remoteMaxSequenceForRepair = hasCompletedInitialSync
          ? yield* readRemoteMaxSequence(connectionString)
          : 0;
        const shouldUseFullRemoteForRecovery =
          hasCompletedInitialSync &&
          (localEvents.length === 0 ||
            localProjectionCounts.projectCount + localProjectionCounts.threadCount === 0);
        const remoteEvents =
          !hasCompletedInitialSync || shouldUseFullRemoteForRecovery
            ? yield* readRemoteEvents(connectionString)
            : yield* readRemoteEvents(connectionString, lastSyncedRemoteSequence);
        const remoteMaxSequence = Math.max(
          hasCompletedInitialSync ? remoteMaxSequenceForRepair : 0,
          ...remoteEvents.map((event) => event.sequence),
        );
        const remoteEventsForMapping =
          hasCompletedInitialSync && remoteEvents.length > 0
            ? yield* readRemoteEvents(connectionString)
            : remoteEvents;
        const mappingPlan = yield* ProjectMappings.buildProjectMappingPlanFromEvents(sql, {
          remoteEvents: remoteEventsForMapping,
          remoteMaxSequence,
        });
        yield* ProjectMappings.autoPersistExactProjectMappings(sql, mappingPlan);
        const refreshedMappingPlan = yield* ProjectMappings.buildProjectMappingPlanFromEvents(sql, {
          remoteEvents: remoteEventsForMapping,
          remoteMaxSequence,
        });
        const unresolvedProjectCount = refreshedMappingPlan.candidates.filter(
          (candidate) => candidate.status === "unresolved",
        ).length;
        if (unresolvedProjectCount > 0) {
          yield* publishStatus({
            state: "needs-project-mapping",
            configured: true,
            remoteMaxSequence,
            unresolvedProjectCount,
            lastSyncedAt,
          });
          return;
        }
        const projectMappings = yield* ProjectMappings.readProjectMappings(sql);
        const remoteEventsForLocal = rewriteRemoteEventsForLocalMappings(
          normalizeRemoteEventsForLocalImport(remoteEvents),
          projectMappings,
        );
        const remoteProjectCount = collectProjectCandidates(remoteEventsForLocal).length;
        const remoteActiveThreadCount = countActiveThreadCreates(remoteEventsForLocal);
        const localEventsForRemote = rewriteLocalEventsForRemoteMappings(
          localEvents,
          projectMappings,
        );

        if (!hasCompletedInitialSync) {
          console.info("[history-sync] first sync started", {
            localEvents: localEvents.length,
            remoteEvents: remoteEvents.length,
            remoteMaxSequence,
          });
          if (
            shouldPushLocalHistoryOnFirstSync({
              hasCompletedInitialSync,
              localEventCount: localEvents.length,
              remoteEventCount: remoteEvents.length,
            })
          ) {
            console.info("[history-sync] first sync pushing local history to empty remote", {
              localEvents: localEvents.length,
              localMaxSequence,
            });
            yield* pushRemoteEventsBatched(connectionString, localEventsForRemote);
            const now = new Date().toISOString();
            yield* writePushedEventReceipts(localEvents, now);
            yield* writeState({
              hasCompletedInitialSync: true,
              lastSyncedRemoteSequence: localMaxSequence,
              lastSuccessfulSyncAt: now,
            });
            yield* publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
            return;
          }

          const mergeEvents =
            localEvents.length === 0
              ? []
              : buildFirstSyncClientMergeEvents(localEvents, remoteEventsForLocal);
          console.info("[history-sync] first sync client merge computed", {
            mergedEvents: mergeEvents.length,
          });
          const importedEvents = [...remoteEventsForLocal, ...mergeEvents];
          yield* pushRemoteEventsBatched(
            connectionString,
            rewriteLocalEventsForRemoteMappings(mergeEvents, projectMappings),
          );
          yield* runImport(importedEvents, syncContext);
          const nextRemoteSequence = Math.max(
            remoteMaxSequence,
            ...mergeEvents.map((event) => event.sequence),
          );
          const now = new Date().toISOString();
          yield* writePushedEventReceipts(importedEvents, now);
          yield* writeState({
            hasCompletedInitialSync: true,
            lastSyncedRemoteSequence: nextRemoteSequence,
            lastSuccessfulSyncAt: now,
          });
          yield* publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
          return;
        }

        if (
          isRemoteBehindLocal({
            hasCompletedInitialSync,
            localMaxSequence,
            remoteMaxSequence,
            lastSyncedRemoteSequence,
          })
        ) {
          const pending = selectRemoteBehindLocalEvents(localEvents, remoteMaxSequence);
          console.warn("[history-sync] remote history is behind local state; repairing remote", {
            pendingEvents: pending.length,
            localMaxSequence,
            remoteMaxSequence,
            lastSyncedRemoteSequence,
          });
          yield* pushRemoteEventsBatched(
            connectionString,
            rewriteLocalEventsForRemoteMappings(pending, projectMappings),
          );
          const now = new Date().toISOString();
          yield* writePushedEventReceipts(pending, now);
          yield* writeState({
            hasCompletedInitialSync: true,
            lastSyncedRemoteSequence: localMaxSequence,
            lastSuccessfulSyncAt: now,
          });
          yield* publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
          return;
        }

        const shouldReplaceLocalFromRemote = shouldImportRemoteIntoEmptyLocal({
          hasCompletedInitialSync,
          localEventCount: localEvents.length,
          localProjectionCount:
            localProjectionCounts.projectCount + localProjectionCounts.threadCount,
          localProjectProjectionCount: localProjectionCounts.projectCount,
          localThreadProjectionCount: localProjectionCounts.threadCount,
          remoteEventCount: remoteEventsForLocal.length,
          remoteProjectCount,
          remoteActiveThreadCount,
        });
        if (shouldReplaceLocalFromRemote || remoteMaxSequence > lastSyncedRemoteSequence) {
          const remoteEventsToImport = shouldReplaceLocalFromRemote
            ? remoteEventsForLocal
            : filterAlreadyImportedRemoteDeltaEvents(remoteEventsForLocal, localEvents);
          console.info("[history-sync] importing remote history", {
            remoteEvents: remoteEvents.length,
            rewrittenRemoteEvents: remoteEventsForLocal.length,
            importEvents: remoteEventsToImport.length,
            alreadyImportedEvents: remoteEventsForLocal.length - remoteEventsToImport.length,
            remoteMaxSequence,
            lastSyncedRemoteSequence,
            localEvents: localEvents.length,
            localProjectionCounts,
            remoteProjectCount,
            remoteActiveThreadCount,
            mode: shouldReplaceLocalFromRemote ? "replace" : "delta",
          });
          if (remoteEventsToImport.length > 0) {
            yield* runImport(remoteEventsToImport, syncContext, {
              mode: shouldReplaceLocalFromRemote ? "replace" : "delta",
            });
          }
          const now = new Date().toISOString();
          yield* writePushedEventReceipts(remoteEventsForLocal, now);
          yield* writeState({
            hasCompletedInitialSync: true,
            lastSyncedRemoteSequence: remoteMaxSequence,
            lastSuccessfulSyncAt: now,
          });
          if (shouldReplaceLocalFromRemote) {
            yield* publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
            return;
          }

          const refreshedLocalEvents = yield* readLocalEvents();
          const unpushedLocalEvents = yield* readUnpushedLocalEvents;
          const pushableLocalEvents = filterPushableLocalEvents(
            unpushedLocalEvents,
            refreshedLocalEvents,
          );
          if (pushableLocalEvents.length > 0) {
            console.info("[history-sync] pushing local pending history after remote import", {
              pendingEvents: pushableLocalEvents.length,
              deferredEvents: unpushedLocalEvents.length - pushableLocalEvents.length,
              localMaxSequence: Math.max(0, ...refreshedLocalEvents.map((event) => event.sequence)),
              lastSyncedRemoteSequence: remoteMaxSequence,
            });
            yield* pushRemoteEventsBatched(
              connectionString,
              rewriteLocalEventsForRemoteMappings(pushableLocalEvents, projectMappings),
            );
            const pushedAt = new Date().toISOString();
            yield* writePushedEventReceipts(pushableLocalEvents, pushedAt);
            const nextRemoteSequence = nextSyncedRemoteSequenceAfterPush(
              remoteMaxSequence,
              pushableLocalEvents,
            );
            yield* writeState({
              hasCompletedInitialSync: true,
              lastSyncedRemoteSequence: nextRemoteSequence,
              lastSuccessfulSyncAt: pushedAt,
            });
            yield* publishStatus({ state: "idle", configured: true, lastSyncedAt: pushedAt });
            return;
          }

          yield* publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
          return;
        }

        const unpushedLocalEvents = yield* readUnpushedLocalEvents;
        const pushableLocalEvents = filterPushableLocalEvents(unpushedLocalEvents, localEvents);
        if (pushableLocalEvents.length > 0) {
          console.info("[history-sync] pushing local pending history", {
            pendingEvents: pushableLocalEvents.length,
            deferredEvents: unpushedLocalEvents.length - pushableLocalEvents.length,
            localMaxSequence,
            lastSyncedRemoteSequence,
          });
          yield* pushRemoteEventsBatched(
            connectionString,
            rewriteLocalEventsForRemoteMappings(pushableLocalEvents, projectMappings),
          );
          const now = new Date().toISOString();
          yield* writePushedEventReceipts(pushableLocalEvents, now);
          const nextRemoteSequence = nextSyncedRemoteSequenceAfterPush(
            lastSyncedRemoteSequence,
            pushableLocalEvents,
          );
          yield* writeState({
            hasCompletedInitialSync: true,
            lastSyncedRemoteSequence: nextRemoteSequence,
            lastSuccessfulSyncAt: now,
          });
          yield* publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
          return;
        }

        const now = new Date().toISOString();
        yield* writeState({
          hasCompletedInitialSync: true,
          lastSyncedRemoteSequence,
          lastSuccessfulSyncAt: now,
        });
        yield* publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
      }).pipe(
        Effect.timeout(HISTORY_SYNC_OPERATION_TIMEOUT_MS),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            const previousStatus = yield* Ref.get(statusRef);
            const lastSyncedAt =
              previousStatus.state === "idle" ||
              previousStatus.state === "syncing" ||
              previousStatus.state === "retrying" ||
              previousStatus.state === "error" ||
              previousStatus.state === "needs-project-mapping" ||
              previousStatus.state === "needs-initial-sync"
                ? previousStatus.lastSyncedAt
                : null;
            const message = describeSyncFailure(cause);
            console.error("[history-sync] sync failed", {
              mode: options.mode,
              message,
              cause,
            });
            yield* Effect.logWarning("history sync failed", { cause });
            const retryAttempt = options.retryAttempt ?? 1;
            const retryDelayMs =
              options.mode === "autosave" && isRetryableHistorySyncConnectionFailure(cause)
                ? nextHistorySyncRetryDelayMs(retryAttempt)
                : null;
            if (retryDelayMs !== null) {
              const failedAt = new Date().toISOString();
              const firstFailedAt = options.retryContext?.firstFailedAt ?? failedAt;
              const recentFailures = appendHistorySyncRetryFailure(
                options.retryContext?.recentFailures ?? [],
                { failedAt, message: message || "History sync failed.", attempt: retryAttempt },
              );
              const nextRetryAt = new Date(Date.now() + retryDelayMs).toISOString();
              yield* publishStatus({
                state: "retrying",
                configured: true,
                message: message || "History sync failed.",
                startedAt:
                  previousStatus.state === "syncing" || previousStatus.state === "retrying"
                    ? previousStatus.startedAt
                    : failedAt,
                lastSyncedAt,
                firstFailedAt,
                nextRetryAt,
                attempt: retryAttempt,
                maxAttempts: HISTORY_SYNC_RETRY_DELAYS_MS.length,
                recentFailures,
              });
              yield* Effect.sleep(retryDelayMs);
              yield* performSync({
                ...options,
                retryAttempt: retryAttempt + 1,
                retryContext: { firstFailedAt, recentFailures },
              });
              return;
            }

            yield* Ref.set(stoppedRef, true);
            const retryFailures = options.retryContext?.recentFailures;
            yield* publishStatus({
              state: "error",
              configured: true,
              message: message || "History sync failed.",
              lastSyncedAt,
              ...(retryFailures
                ? {
                    retry: {
                      firstFailedAt:
                        options.retryContext?.firstFailedAt ?? new Date().toISOString(),
                      finalFailedAt: new Date().toISOString(),
                      attempt: Math.min(
                        options.retryAttempt ?? HISTORY_SYNC_RETRY_DELAYS_MS.length,
                        HISTORY_SYNC_RETRY_DELAYS_MS.length,
                      ),
                      maxAttempts: HISTORY_SYNC_RETRY_DELAYS_MS.length,
                      recentFailures: appendHistorySyncRetryFailure(retryFailures, {
                        failedAt: new Date().toISOString(),
                        message: message || "History sync failed.",
                        attempt: Math.min(
                          options.retryAttempt ?? HISTORY_SYNC_RETRY_DELAYS_MS.length,
                          HISTORY_SYNC_RETRY_DELAYS_MS.length,
                        ),
                      }),
                    },
                  }
                : {}),
            });
          }),
        ),
      );

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
        yield* performSync({
          mode,
          ...(options.autosaveMaxSequence !== undefined
            ? { autosaveMaxSequence: options.autosaveMaxSequence }
            : {}),
        }).pipe(
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

    const syncNow: HistorySyncServiceShape["syncNow"] = runSyncMode("full", {
      clearStopped: false,
    });
    syncNowEffect = syncNow;

    const runSync: HistorySyncServiceShape["runSync"] = runSyncMode("full", {
      clearStopped: true,
    }).pipe(Effect.andThen(toConfig));

    const startInitialSync: HistorySyncServiceShape["startInitialSync"] = Ref.get(runningRef).pipe(
      Effect.flatMap((running) => {
        if (running) return toConfig;
        return Ref.set(stoppedRef, false).pipe(
          Effect.andThen(Ref.set(runningRef, true)),
          Effect.andThen(performSync({ mode: "initial" })),
          Effect.ensuring(Ref.set(runningRef, false)),
          Effect.andThen(toConfig),
        );
      }),
    );

    const restoreBackup: HistorySyncServiceShape["restoreBackup"] = Ref.get(runningRef).pipe(
      Effect.flatMap((running) => {
        if (running) {
          return Effect.fail(
            new HistorySyncConfigError({
              message: "Cannot restore the history sync backup while sync is running.",
            }),
          );
        }
        return Ref.set(runningRef, true).pipe(
          Effect.andThen(restoreBackupFromDisk),
          Effect.ensuring(Ref.set(runningRef, false)),
          Effect.andThen(toConfig),
        );
      }),
    );

    const start: HistorySyncServiceShape["start"] = Effect.gen(function* () {
      const timing = yield* settingsService.getSettings.pipe(
        Effect.map((settings) => settings.historySync),
        Effect.catch((error) =>
          Effect.logWarning("history sync using default timing because settings failed to load", {
            cause: error,
          }).pipe(Effect.as(defaultHistorySyncTiming)),
        ),
      );
      const syncWhenNotRunning = Ref.get(runningRef).pipe(
        Effect.flatMap((running) =>
          running
            ? Effect.void
            : publishConfiguredStartupStatus.pipe(
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
      yield* engine.streamDomainEvents.pipe(
        Stream.filter(shouldScheduleAutosaveForDomainEvent),
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

    latestHistorySyncControl = {
      getConfig: toConfig,
      updateConfig,
      runSync,
      startInitialSync,
      restoreBackup,
      testConnection,
      getProjectMappings,
      applyProjectMappings,
    };

    return {
      start,
      syncNow,
      runSync,
      getStatus: Ref.get(statusRef),
      getConfig: toConfig,
      updateConfig,
      startInitialSync,
      restoreBackup,
      testConnection,
      getProjectMappings,
      applyProjectMappings,
      get streamStatus() {
        return Stream.fromPubSub(statusPubSub);
      },
    } satisfies HistorySyncServiceShape;
  }),
);
