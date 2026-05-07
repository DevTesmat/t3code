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
import { Context, Effect, Layer, PubSub, Ref, Scope, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerSecretStore } from "./auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "./config.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import type { ServerSettingsError } from "@t3tools/contracts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import * as HistorySyncBackup from "./historySync/backup.ts";
import {
  createHistorySyncConfigController,
  defaultHistorySyncTiming,
  describeSyncFailure,
} from "./historySync/config.ts";
import { registerHistorySyncFacadeControl } from "./historySync/facade.ts";
import * as LocalHistoryRepository from "./historySync/localRepository.ts";
import { createHistorySyncLifecycleController } from "./historySync/lifecycle.ts";
import * as ProjectMappings from "./historySync/projectMappings.ts";
import { createHistorySyncProjectMappingController } from "./historySync/projectMappingController.ts";
import { reloadHistorySyncProjections } from "./historySync/projectionReload.ts";
import { createHistorySyncRestoreController } from "./historySync/restoreController.ts";
import { DISABLED_HISTORY_SYNC_STATUS, publishHistorySyncStatus } from "./historySync/statusBus.ts";
import { createHistorySyncRunner } from "./historySync/syncRunner.ts";

export {
  applyHistorySyncProjectMappings,
  getHistorySyncConfig,
  getHistorySyncProjectMappings,
  restoreHistorySyncBackup,
  runHistorySync,
  startHistorySyncInitialImport,
  testHistorySyncConnection,
  updateHistorySyncConfig,
} from "./historySync/facade.ts";
export { readHistorySyncStatus, subscribeHistorySyncStatus } from "./historySync/statusBus.ts";
export { HISTORY_SYNC_CONNECTION_STRING_SECRET } from "./historySync/config.ts";
export { nextHistorySyncRetryDelayMs } from "./historySync/syncRunner.ts";

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
  planLocalReplacementFromRemote,
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
  isRetryableHistorySyncConnectionFailure,
  pushRemoteEventsBatched,
  readRemoteEvents,
  readRemoteMaxSequence,
} from "./historySync/remoteStore.ts";

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
    let syncNowEffect: Effect.Effect<void> = Effect.void;
    let clearStoppedEffect: Effect.Effect<void> = Effect.void;

    const publishStatus = (status: HistorySyncStatus) =>
      publishHistorySyncStatus({ status, statusRef, statusPubSub });

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

    const configController = createHistorySyncConfigController({
      secretStore,
      settingsService,
      statusRef,
      readState: readState.pipe(
        Effect.mapError(
          (cause) =>
            new HistorySyncConfigError({
              message: describeSyncFailure(cause),
            }),
        ),
      ),
      readBackupSummary: HistorySyncBackup.readBackupSummary(serverConfig.dbPath),
      publishStatus,
      clearStopped: () => clearStoppedEffect,
      syncNow: () => syncNowEffect,
    });
    const {
      getConnectionString,
      loadTiming,
      publishConfiguredStartupStatus,
      testConnection,
      toConfig,
      updateConfig,
    } = configController;

    const importRemoteEvents = (events: readonly HistorySyncEventRow[]) =>
      LocalHistoryRepository.importRemoteEvents(sql, events);

    const importRemoteDeltaEvents = (events: readonly HistorySyncEventRow[]) =>
      LocalHistoryRepository.importRemoteDeltaEvents(sql, events);

    const restoreController = createHistorySyncRestoreController({
      restoreBackupTablesFromDisk: HistorySyncBackup.restoreBackupTablesFromDisk(
        sql,
        serverConfig.dbPath,
      ),
      reloadProjections: engine.reloadFromStorage
        ? reloadHistorySyncProjections({ reloadFromStorage: engine.reloadFromStorage })
        : reloadHistorySyncProjections({}).pipe(Effect.asVoid),
      readState,
      getConnectionString,
      publishStatus,
    });
    const { restoreBackupFromDisk } = restoreController;

    const syncRunner = createHistorySyncRunner({
      getSettings: settingsService.getSettings,
      getConnectionString,
      statusRef,
      publishStatus,
      createBackup: HistorySyncBackup.createSqliteBackup(sql, serverConfig.dbPath),
      reloadProjections: (input) =>
        reloadHistorySyncProjections({
          ...(engine.reloadFromStorage ? { reloadFromStorage: engine.reloadFromStorage } : {}),
          context: input.context,
          publishProgress: input.publishProgress,
        }),
      readLocalEvents,
      readUnpushedLocalEvents,
      readProjectionThreadAutosyncRows,
      readLocalProjectionCounts,
      readState,
      writeState,
      importRemoteEvents,
      importRemoteDeltaEvents,
      writePushedEventReceipts,
      seedPushedEventReceiptsForCompletedSync,
      readRemoteEvents,
      readRemoteMaxSequence,
      pushRemoteEventsBatched,
      isRetryableConnectionFailure: isRetryableHistorySyncConnectionFailure,
      readProjectMappings: ProjectMappings.readProjectMappings(sql),
      buildProjectMappingPlanFromEvents: (input) =>
        ProjectMappings.buildProjectMappingPlanFromEvents(sql, input),
      autoPersistExactProjectMappings: (plan) =>
        ProjectMappings.autoPersistExactProjectMappings(sql, plan),
    });
    const { performSync } = syncRunner;

    const lifecycle = yield* createHistorySyncLifecycleController({
      statusPubSub,
      loadTiming,
      defaultTiming: defaultHistorySyncTiming,
      publishConfiguredStartupStatus,
      performSync,
      recoverStuckSyncStatus,
      toConfig,
      restoreBackupFromDisk,
      streamDomainEvents: engine.streamDomainEvents,
      shouldScheduleAutosaveForDomainEvent,
    });
    const { start, syncNow, runSync, startInitialSync, restoreBackup } = lifecycle;
    syncNowEffect = syncNow;
    clearStoppedEffect = lifecycle.clearStopped;

    const mappingController = createHistorySyncProjectMappingController({
      getConnectionString,
      readRemoteEvents,
      buildProjectMappingPlanFromEvents: (input) =>
        ProjectMappings.buildProjectMappingPlanFromEvents(sql, input),
      autoPersistExactProjectMappings: (plan) =>
        ProjectMappings.autoPersistExactProjectMappings(sql, plan),
      getSyncId: (remoteMaxSequence) => ProjectMappings.getSyncId(sql, remoteMaxSequence),
      applyMappingActions: (input) => ProjectMappings.applyMappingActions(sql, input),
      clearStopped: () => lifecycle.clearStopped,
      readState,
      syncNow: () => syncNow,
      startInitialSync: () => startInitialSync.pipe(Effect.asVoid),
    });
    const { getProjectMappings, applyProjectMappings } = mappingController;

    registerHistorySyncFacadeControl({
      getConfig: toConfig,
      updateConfig,
      runSync,
      startInitialSync,
      restoreBackup,
      testConnection,
      getProjectMappings,
      applyProjectMappings,
    });

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
        return lifecycle.streamStatus;
      },
    } satisfies HistorySyncServiceShape;
  }),
);
