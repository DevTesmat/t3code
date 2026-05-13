import {
  HistorySyncConfigError,
  type HistorySyncConfig,
  type HistorySyncConnectionTestResult,
  type HistorySyncMysqlFields,
  type HistorySyncPendingEventReview,
  type HistorySyncPendingEventReviewItem,
  type HistorySyncProjectMappingPlan,
  type HistorySyncProjectMappingsApplyInput,
  type HistorySyncResolvePendingEventsInput,
  type HistorySyncUpdateConfigInput,
  type HistorySyncStatus,
} from "@t3tools/contracts";
import { Context, Effect, Layer, PubSub, Ref, Scope, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ServerSettingsError } from "@t3tools/contracts";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as HistorySyncBackup from "./backup.ts";
import {
  createHistorySyncConfigController,
  defaultHistorySyncTiming,
  describeSyncFailure,
} from "./config.ts";
import { registerHistorySyncFacadeControl } from "./facade.ts";
import * as LocalHistoryRepository from "./localRepository.ts";
import { createHistorySyncLifecycleController } from "./lifecycle.ts";
import {
  filterPushableLocalEvents,
  maxHistoryEventSequence,
  shouldScheduleAutosaveForDomainEvent,
  type HistorySyncEventRow,
} from "./planner.ts";
import * as ProjectMappings from "./projectMappings.ts";
import { createHistorySyncProjectMappingController } from "./projectMappingController.ts";
import { reloadHistorySyncProjections } from "./projectionReload.ts";
import {
  isRetryableHistorySyncConnectionFailure,
  pushRemoteEventsBatched,
  readRemoteEvents,
  readRemoteEventsForThreadIds,
  readRemoteMaxSequence,
  readRemoteLatestThreadShells,
  readRemoteProjectMappingCandidates,
  readRemoteProjectEventsForProjectIds,
} from "./remoteStore.ts";
import { createHistorySyncRestoreController } from "./restoreController.ts";
import { DISABLED_HISTORY_SYNC_STATUS, publishHistorySyncStatus } from "./statusBus.ts";
import { createHistorySyncRunner } from "./syncRunner.ts";

export interface HistorySyncServiceShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly syncNow: Effect.Effect<void>;
  readonly prioritizeThreadSync: (threadId: string) => Effect.Effect<void>;
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
  readonly getPendingEvents: Effect.Effect<
    HistorySyncPendingEventReview,
    HistorySyncConfigError | ServerSettingsError
  >;
  readonly resolvePendingEvents: (
    input: HistorySyncResolvePendingEventsInput,
  ) => Effect.Effect<
    { readonly markedCount: number; readonly review: HistorySyncPendingEventReview },
    HistorySyncConfigError | ServerSettingsError
  >;
  readonly streamStatus: Stream.Stream<HistorySyncStatus>;
}

export class HistorySyncService extends Context.Service<
  HistorySyncService,
  HistorySyncServiceShape
>()("t3/historySync/HistorySyncService") {}

const HISTORY_SYNC_PENDING_REVIEW_LIMIT = 100;

function parseHistorySyncPayload(event: HistorySyncEventRow): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(event.payloadJson);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readPayloadString(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toPendingReviewItem(
  event: HistorySyncEventRow,
  pushableSequences: ReadonlySet<number>,
): HistorySyncPendingEventReviewItem {
  const payload = parseHistorySyncPayload(event);
  const pushable = pushableSequences.has(event.sequence);
  const threadId = readPayloadString(payload, "threadId");
  const projectId = readPayloadString(payload, "projectId");
  return {
    sequence: event.sequence,
    eventId: event.eventId,
    eventType: event.eventType,
    aggregateKind: event.aggregateKind,
    streamId: event.streamId,
    occurredAt: event.occurredAt,
    ...(threadId ? { threadId } : {}),
    ...(projectId ? { projectId } : {}),
    pushable,
    reason: pushable
      ? "Ready to push on the next successful sync."
      : "Deferred by autosync safety rules. Review before clearing.",
  };
}

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
      console.error("[history-sync] recovering stuck syncing status", {
        startedAt: currentStatus.startedAt,
        lastSyncedAt: currentStatus.lastSyncedAt,
      });
      yield* publishStatus({
        state: "error",
        configured: true,
        message: "History sync stopped before completion.",
        lastSyncedAt: currentStatus.lastSyncedAt,
      });
    });

    const readLocalEvents = (sequenceExclusive = 0) =>
      LocalHistoryRepository.readLocalEvents(sql, sequenceExclusive);

    const readLocalEventRefsForSequences = (sequences: readonly number[]) =>
      LocalHistoryRepository.readLocalEventRefsForSequences(sql, sequences);

    const readLocalEventsForSequences = (sequences: readonly number[]) =>
      LocalHistoryRepository.readLocalEventsForSequences(sql, sequences);

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

    const readHistorySyncThreadStateCounts =
      LocalHistoryRepository.readHistorySyncThreadStateCounts(sql);

    const readHistorySyncThreadState = (threadId: string) =>
      LocalHistoryRepository.readHistorySyncThreadState(sql, threadId);

    const readState = LocalHistoryRepository.readState(sql);

    const commitHistorySyncState = (input: LocalHistoryRepository.WriteHistorySyncStateInput) =>
      LocalHistoryRepository.commitHistorySyncState(sql, input);

    const commitPushedEventReceiptsAndState = (input: {
      readonly events: readonly HistorySyncEventRow[];
      readonly pushedAt: string;
      readonly state: LocalHistoryRepository.WriteHistorySyncStateInput;
    }) => LocalHistoryRepository.commitPushedEventReceiptsAndState(sql, input);

    const setInitialSyncPhase = (input: {
      readonly phase: LocalHistoryRepository.HistorySyncInitialSyncPhase;
      readonly startedAt: string;
    }) => LocalHistoryRepository.setInitialSyncPhase(sql, input);

    const clearInitialSyncPhase = LocalHistoryRepository.clearInitialSyncPhase(sql);

    const failInitialSyncPhase = (input: { readonly error: string; readonly failedAt: string }) =>
      LocalHistoryRepository.failInitialSyncPhase(sql, input);

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
      readLocalEventRefsForSequences,
      readLocalEventsForSequences,
      readUnpushedLocalEvents,
      readProjectionThreadAutosyncRows,
      readLocalProjectionCounts,
      readState,
      commitHistorySyncState,
      commitPushedEventReceiptsAndState,
      setInitialSyncPhase,
      clearInitialSyncPhase,
      failInitialSyncPhase,
      importRemoteEvents,
      importRemoteDeltaEvents,
      writePushedEventReceipts,
      seedPushedEventReceiptsForCompletedSync,
      readRemoteEvents,
      readRemoteMaxSequence,
      readRemoteLatestThreadShells,
      readRemoteEventsForThreadIds,
      readRemoteProjectEventsForProjectIds,
      pushRemoteEventsBatched,
      isRetryableConnectionFailure: isRetryableHistorySyncConnectionFailure,
      readProjectMappings: ProjectMappings.readValidProjectMappings(sql),
      buildProjectMappingPlanFromEvents: (input) =>
        ProjectMappings.buildProjectMappingPlanFromEvents(sql, input),
      autoPersistExactProjectMappings: (plan) =>
        ProjectMappings.autoPersistExactProjectMappings(sql, plan),
      upsertHistorySyncThreadStates: (rows) =>
        LocalHistoryRepository.upsertHistorySyncThreadStates(sql, rows),
      readHistorySyncThreadStateCounts,
      readHistorySyncThreadState,
      updateHistorySyncLatestFirstState: (input) =>
        LocalHistoryRepository.updateHistorySyncLatestFirstState(sql, input),
      markHistorySyncThreadPriority: (input) =>
        LocalHistoryRepository.markHistorySyncThreadPriority(sql, input),
      deferHistorySyncThreadPriority: (input) =>
        LocalHistoryRepository.deferHistorySyncThreadPriority(sql, input),
    });
    const { performSync, runPriorityThreadImport } = syncRunner;
    const priorityThreadSyncInFlight = yield* Ref.make<ReadonlySet<string>>(new Set());
    const prioritizeThreadSync = (threadId: string) =>
      Effect.gen(function* () {
        const status = yield* Ref.get(statusRef);
        if (status.state === "syncing" || status.state === "retrying") {
          console.info("[history-sync] priority-thread", {
            phase: "skip",
            threadId,
            reason: "sync-active",
            activeState: status.state,
            lane: status.state === "syncing" ? status.lane : undefined,
          });
          return;
        }
        const acquired = yield* Ref.modify(priorityThreadSyncInFlight, (current) => {
          if (current.size > 0 || current.has(threadId)) {
            return [false, current] as const;
          }
          return [true, new Set(current).add(threadId)] as const;
        });
        if (!acquired) {
          console.info("[history-sync] priority-thread", {
            phase: "skip",
            threadId,
            reason: "priority-sync-active",
          });
          return;
        }
        yield* runPriorityThreadImport(threadId).pipe(
          Effect.ensuring(
            Ref.update(priorityThreadSyncInFlight, (current) => {
              const next = new Set(current);
              next.delete(threadId);
              return next;
            }),
          ),
        );
      });

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
    const recoverStaleThreadStates = LocalHistoryRepository.recoverStaleHistorySyncThreadStates(
      sql,
      new Date().toISOString(),
    ).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("history sync thread-state recovery failed", { cause }),
      ),
      Effect.ignore,
    );
    syncNowEffect = syncNow;
    clearStoppedEffect = lifecycle.clearStopped;

    const mappingController = createHistorySyncProjectMappingController({
      getConnectionString,
      readRemoteMaxSequence,
      readRemoteProjectMappingCandidates,
      autoPersistExactProjectMappings: (plan) =>
        ProjectMappings.autoPersistExactProjectMappings(sql, plan),
      buildProjectMappingPlanFromCandidates: (input) =>
        ProjectMappings.buildProjectMappingPlanFromCandidates(sql, input),
      getSyncId: (remoteMaxSequence) => ProjectMappings.getSyncId(sql, remoteMaxSequence),
      applyMappingActionsForProjectCandidates: (input) =>
        ProjectMappings.applyMappingActionsForProjectCandidates(sql, input),
      clearStopped: () => lifecycle.clearStopped,
      readState,
      syncNow: () => syncNow,
      startInitialSync: () => startInitialSync.pipe(Effect.asVoid),
    });
    const { getProjectMappings, applyProjectMappings } = mappingController;

    const getPendingEvents = Effect.gen(function* () {
      const [state, localEvents, unpushedLocalEvents] = yield* Effect.all([
        readState,
        readLocalEvents(),
        readUnpushedLocalEvents,
      ]);
      const connectionString = yield* getConnectionString;
      const lastSyncedRemoteSequence = state?.lastSyncedRemoteSequence ?? 0;
      const remoteMaxSequence =
        connectionString === null
          ? lastSyncedRemoteSequence
          : yield* readRemoteMaxSequence(connectionString).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("failed to read remote max sequence for pending review", {
                  cause,
                }).pipe(Effect.as(lastSyncedRemoteSequence)),
              ),
            );
      const pushableLocalEvents = filterPushableLocalEvents(unpushedLocalEvents, localEvents);
      const pushableSequences = new Set(pushableLocalEvents.map((event) => event.sequence));
      const events = unpushedLocalEvents
        .toSorted((left, right) => left.sequence - right.sequence)
        .slice(0, HISTORY_SYNC_PENDING_REVIEW_LIMIT)
        .map((event) => toPendingReviewItem(event, pushableSequences));

      return {
        totalCount: unpushedLocalEvents.length,
        pushableCount: pushableLocalEvents.length,
        deferredCount: unpushedLocalEvents.length - pushableLocalEvents.length,
        displayedCount: events.length,
        omittedCount: Math.max(0, unpushedLocalEvents.length - events.length),
        localMaxSequence: maxHistoryEventSequence(localEvents),
        remoteMaxSequence,
        lastSyncedRemoteSequence,
        events,
      } satisfies HistorySyncPendingEventReview;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new HistorySyncConfigError({
            message: describeSyncFailure(cause) || "Failed to load pending history sync events.",
          }),
      ),
    );

    const resolvePendingEvents = (input: HistorySyncResolvePendingEventsInput) =>
      Effect.gen(function* () {
        if (input.action !== "mark-synced") {
          return yield* new HistorySyncConfigError({
            message: "Unsupported pending event action.",
          });
        }
        const sequenceSet = new Set(input.sequences);
        if (sequenceSet.size === 0) {
          return yield* new HistorySyncConfigError({
            message: "Select at least one pending event.",
          });
        }
        const unpushedLocalEvents = yield* readUnpushedLocalEvents;
        const selectedEvents = unpushedLocalEvents.filter((event) =>
          sequenceSet.has(event.sequence),
        );
        if (selectedEvents.length === 0) {
          return yield* new HistorySyncConfigError({
            message: "Selected pending events were not found.",
          });
        }
        const markedAt = new Date().toISOString();
        yield* writePushedEventReceipts(selectedEvents, markedAt);
        console.info("[history-sync] pending events marked synced by user", {
          markedCount: selectedEvents.length,
          firstSequence: selectedEvents[0]?.sequence ?? null,
          lastSequence: selectedEvents.at(-1)?.sequence ?? null,
        });
        const review = yield* getPendingEvents;
        return { markedCount: selectedEvents.length, review };
      }).pipe(
        Effect.mapError((cause) =>
          typeof cause === "object" &&
          cause !== null &&
          "_tag" in cause &&
          cause._tag === "HistorySyncConfigError"
            ? cause
            : new HistorySyncConfigError({
                message:
                  describeSyncFailure(cause) || "Failed to resolve pending history sync events.",
              }),
        ),
      );

    registerHistorySyncFacadeControl({
      getConfig: toConfig,
      updateConfig,
      runSync,
      prioritizeThreadSync,
      startInitialSync,
      restoreBackup,
      testConnection,
      getProjectMappings,
      applyProjectMappings,
      getPendingEvents,
      resolvePendingEvents,
    });

    return {
      start: recoverStaleThreadStates.pipe(Effect.andThen(start)),
      syncNow,
      runSync,
      prioritizeThreadSync,
      getStatus: Ref.get(statusRef),
      getConfig: toConfig,
      updateConfig,
      startInitialSync,
      restoreBackup,
      testConnection,
      getProjectMappings,
      applyProjectMappings,
      getPendingEvents,
      resolvePendingEvents,
      get streamStatus() {
        return lifecycle.streamStatus;
      },
    } satisfies HistorySyncServiceShape;
  }),
);
