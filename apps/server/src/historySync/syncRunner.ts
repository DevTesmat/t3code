import { type HistorySyncProjectMappingPlan, type HistorySyncStatus } from "@t3tools/contracts";
import { Effect, Ref } from "effect";

import { describeSyncFailure } from "./config.ts";
import type { HistorySyncMode } from "./lifecycle.ts";
import type { HistorySyncInitialSyncPhase } from "./localRepository.ts";
import type {
  HistorySyncAutosyncProjectionThreadRow,
  HistorySyncEventRow,
  HistorySyncProjectMappingRow,
} from "./planner.ts";
import type { HistorySyncRemoteThreadShellRow } from "./remoteStore.ts";
import {
  collectProjectCandidates,
  countActiveThreadCreates,
  filterAlreadyImportedRemoteDeltaEvents,
  filterPushableLocalEvents,
  isRemoteBehindLocal,
  maxHistoryEventSequence,
  planLocalCommitAfterRemoteWrite,
  normalizeRemoteEventsForLocalImport,
  planAutosaveLocalPush,
  planAutosaveRemoteDelta,
  planAutosaveRemoteCoveredReceipts,
  planFirstSync,
  planLocalReplacementFromRemote,
  rewriteLocalEventsForRemoteMappings,
  rewriteRemoteEventsForLocalMappings,
  selectRemoteCoveredLocalEvents,
  selectRemoteBehindLocalEvents,
} from "./planner.ts";
import type { HistorySyncProgress } from "./projectionReload.ts";

const HISTORY_SYNC_OPERATION_TIMEOUT_MS = 10 * 60_000;
const HISTORY_SYNC_LATEST_FIRST_MIN_REMOTE_DELTA_EVENTS = 500;
const HISTORY_SYNC_LATEST_FIRST_BOOTSTRAP_TIMEOUT_MS = 30_000;
const HISTORY_SYNC_RETRY_DELAYS_MS = [10_000, 3 * 60_000, 10 * 60_000, 10 * 60_000, 10 * 60_000];
const HISTORY_SYNC_RECENT_FAILURE_LIMIT = 5;
export const HISTORY_SYNC_AUTOSAVE_REMOTE_CONFLICT_MESSAGE =
  "Autosave paused because another device synced newer history. Use Sync now to import remote changes before autosave resumes.";

interface HistorySyncSettingsSnapshot {
  readonly historySync: {
    readonly enabled: boolean;
  };
}

interface HistorySyncStateSnapshot {
  readonly hasCompletedInitialSync: number;
  readonly lastSyncedRemoteSequence: number;
  readonly lastSuccessfulSyncAt: string | null;
  readonly initialSyncPhase?: HistorySyncInitialSyncPhase | null;
}

interface HistorySyncLocalProjectionCounts {
  readonly projectCount: number;
  readonly threadCount: number;
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

export interface HistorySyncAutosaveRemoteConflict {
  readonly message: string;
  readonly remoteMaxSequence: number;
  readonly lastSyncedRemoteSequence: number;
  readonly remoteDeltaEventCount: number;
  readonly unknownRemoteEventCount: number;
}

export interface HistorySyncRunnerDependencies {
  readonly getSettings: Effect.Effect<HistorySyncSettingsSnapshot, object>;
  readonly getConnectionString: Effect.Effect<string | null, object>;
  readonly statusRef: Ref.Ref<HistorySyncStatus>;
  readonly publishStatus: (status: HistorySyncStatus) => Effect.Effect<void>;
  readonly createBackup: Effect.Effect<void, object>;
  readonly reloadProjections: (input: {
    readonly context: {
      readonly startedAt: string;
      readonly lastSyncedAt: string | null;
    };
    readonly publishProgress: (input: {
      readonly startedAt: string;
      readonly lastSyncedAt: string | null;
      readonly progress: HistorySyncProgress;
    }) => Effect.Effect<void>;
  }) => Effect.Effect<void, object>;
  readonly readLocalEvents: (
    sequenceExclusive?: number,
  ) => Effect.Effect<readonly HistorySyncEventRow[], object>;
  readonly readLocalEventRefsForSequences: (
    sequences: readonly number[],
  ) => Effect.Effect<readonly { readonly sequence: number; readonly eventId: string }[], object>;
  readonly readLocalEventsForSequences: (
    sequences: readonly number[],
  ) => Effect.Effect<readonly HistorySyncEventRow[], object>;
  readonly readUnpushedLocalEvents: Effect.Effect<readonly HistorySyncEventRow[], object>;
  readonly readProjectionThreadAutosyncRows: Effect.Effect<
    readonly HistorySyncAutosyncProjectionThreadRow[],
    object
  >;
  readonly readLocalProjectionCounts: Effect.Effect<HistorySyncLocalProjectionCounts, object>;
  readonly readState: Effect.Effect<HistorySyncStateSnapshot | null, object>;
  readonly commitHistorySyncState: (input: {
    readonly hasCompletedInitialSync: boolean;
    readonly lastSyncedRemoteSequence: number;
    readonly lastSuccessfulSyncAt: string;
  }) => Effect.Effect<void, object>;
  readonly commitPushedEventReceiptsAndState: (input: {
    readonly events: readonly HistorySyncEventRow[];
    readonly pushedAt: string;
    readonly state: {
      readonly hasCompletedInitialSync: boolean;
      readonly lastSyncedRemoteSequence: number;
      readonly lastSuccessfulSyncAt: string;
    };
  }) => Effect.Effect<void, object>;
  readonly setInitialSyncPhase: (input: {
    readonly phase: HistorySyncInitialSyncPhase;
    readonly startedAt: string;
  }) => Effect.Effect<void, object>;
  readonly clearInitialSyncPhase: Effect.Effect<void, object>;
  readonly failInitialSyncPhase: (input: {
    readonly error: string;
    readonly failedAt: string;
  }) => Effect.Effect<void, object>;
  readonly importRemoteEvents: (
    events: readonly HistorySyncEventRow[],
  ) => Effect.Effect<unknown, object>;
  readonly importRemoteDeltaEvents: (
    events: readonly HistorySyncEventRow[],
  ) => Effect.Effect<void, object>;
  readonly writePushedEventReceipts: (
    events: readonly HistorySyncEventRow[],
    pushedAt: string,
  ) => Effect.Effect<void, object>;
  readonly seedPushedEventReceiptsForCompletedSync: (
    events: readonly HistorySyncEventRow[],
    input: {
      readonly hasCompletedInitialSync: boolean;
      readonly lastSyncedRemoteSequence: number;
      readonly seededAt: string;
    },
  ) => Effect.Effect<void, object>;
  readonly readRemoteEvents: (
    connectionString: string,
    sequenceExclusive?: number,
  ) => Effect.Effect<readonly HistorySyncEventRow[], object>;
  readonly readRemoteMaxSequence: (connectionString: string) => Effect.Effect<number, object>;
  readonly readRemoteLatestThreadShells: (
    connectionString: string,
    input: { readonly limit: number; readonly offset?: number },
  ) => Effect.Effect<readonly HistorySyncRemoteThreadShellRow[], object>;
  readonly readRemoteEventsForThreadIds: (
    connectionString: string,
    threadIds: readonly string[],
  ) => Effect.Effect<readonly HistorySyncEventRow[], object>;
  readonly readRemoteProjectEventsForProjectIds: (
    connectionString: string,
    projectIds: readonly string[],
  ) => Effect.Effect<readonly HistorySyncEventRow[], object>;
  readonly pushRemoteEventsBatched: (
    connectionString: string,
    events: readonly HistorySyncEventRow[],
  ) => Effect.Effect<void, object>;
  readonly isRetryableConnectionFailure: (error: unknown) => boolean;
  readonly readProjectMappings: Effect.Effect<readonly HistorySyncProjectMappingRow[], object>;
  readonly buildProjectMappingPlanFromEvents: (input: {
    readonly remoteEvents: readonly HistorySyncEventRow[];
    readonly remoteMaxSequence: number;
  }) => Effect.Effect<HistorySyncProjectMappingPlan, object>;
  readonly autoPersistExactProjectMappings: (
    plan: HistorySyncProjectMappingPlan,
  ) => Effect.Effect<void, object>;
  readonly upsertHistorySyncThreadStates: (
    rows: readonly {
      readonly threadId: string;
      readonly remoteProjectId?: string | null;
      readonly localProjectId?: string | null;
      readonly latestRemoteSequence: number;
      readonly importedThroughSequence?: number;
      readonly isShellLoaded?: boolean;
      readonly isFullLoaded?: boolean;
      readonly priority?: number;
      readonly lastRequestedAt?: string | null;
      readonly now: string;
    }[],
  ) => Effect.Effect<void, object>;
  readonly readHistorySyncThreadStateCounts: Effect.Effect<
    { readonly loadedThreadCount: number; readonly totalThreadCount: number },
    object
  >;
  readonly readHistorySyncThreadState: (threadId: string) => Effect.Effect<
    {
      readonly latestRemoteSequence: number;
      readonly importedThroughSequence: number;
      readonly isShellLoaded: number;
      readonly isFullLoaded: number;
      readonly lastRequestedAt: string | null;
    } | null,
    object
  >;
  readonly updateHistorySyncLatestFirstState: (input: {
    readonly remoteAppliedSequence: number;
    readonly remoteKnownMaxSequence: number;
    readonly liveAppendEnabled: boolean;
    readonly latestBootstrapCompletedAt?: string | null;
    readonly backfillCursorUpdatedAt?: string | null;
  }) => Effect.Effect<void, object>;
  readonly markHistorySyncThreadPriority: (input: {
    readonly threadId: string;
    readonly priority: number;
    readonly requestedAt: string;
  }) => Effect.Effect<void, object>;
  readonly deferHistorySyncThreadPriority: (input: {
    readonly threadId: string;
    readonly requestedAt: string;
  }) => Effect.Effect<void, object>;
}

export interface HistorySyncRunnerOptions {
  readonly mode: HistorySyncMode;
  readonly autosaveMaxSequence?: number;
  readonly markStopped: Effect.Effect<void>;
  readonly retryAttempt?: number;
  readonly retryContext?: HistorySyncRetryContext;
}

const HISTORY_SYNC_PRIORITY_RETRY_BACKOFF_MS = 5 * 60_000;

function summarizeHistorySyncUnknownError(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) {
    return { message: String(error) };
  }
  const record = error as Record<string | symbol, unknown>;
  const summary: Record<string, unknown> = {};
  if (error instanceof Error) {
    summary.name = error.name;
    summary.message = error.message;
  }
  for (const key of ["_tag", "operation", "code", "errno", "sqlState", "sqlMessage"] as const) {
    const value = record[key];
    if (value !== undefined) summary[key] = value;
  }
  const sql = record.sql;
  if (typeof sql === "string") {
    summary.sql = sql.length > 500 ? `${sql.slice(0, 500)}...` : sql;
  }
  const reason = record.reason ?? record.cause;
  if (reason !== undefined && reason !== error) {
    summary.reason = summarizeHistorySyncUnknownError(reason);
  }
  for (const symbol of Object.getOwnPropertySymbols(error)) {
    const value = record[symbol];
    if (value !== undefined && value !== reason && value !== error) {
      summary[String(symbol)] = summarizeHistorySyncUnknownError(value);
    }
  }
  return summary;
}

function logPriorityThreadDecision(
  phase: "skip" | "start" | "remote-read" | "mapping" | "import" | "complete" | "fail",
  details: Record<string, unknown>,
) {
  console.info("[history-sync] priority-thread", { phase, ...details });
}

export function nextHistorySyncRetryDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  return HISTORY_SYNC_RETRY_DELAYS_MS[attempt - 1] ?? null;
}

export function shouldRetryHistorySyncFailure(input: {
  readonly mode: HistorySyncMode;
  readonly cause: unknown;
  readonly isRetryableConnectionFailure: (error: unknown) => boolean;
}): boolean {
  return input.mode === "autosave" && input.isRetryableConnectionFailure(input.cause);
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

export function describeAutosaveRemoteConflict(input: {
  readonly remoteMaxSequence: number;
  readonly lastSyncedRemoteSequence: number;
  readonly remoteDeltaEventCount: number;
  readonly unknownRemoteEventCount: number;
}): HistorySyncAutosaveRemoteConflict {
  return {
    message: HISTORY_SYNC_AUTOSAVE_REMOTE_CONFLICT_MESSAGE,
    remoteMaxSequence: input.remoteMaxSequence,
    lastSyncedRemoteSequence: input.lastSyncedRemoteSequence,
    remoteDeltaEventCount: input.remoteDeltaEventCount,
    unknownRemoteEventCount: input.unknownRemoteEventCount,
  };
}

export function createHistorySyncRunner(input: HistorySyncRunnerDependencies) {
  const publishSyncProgress = (progressInput: {
    readonly startedAt: string;
    readonly lastSyncedAt: string | null;
    readonly progress: HistorySyncProgress;
  }) =>
    input.publishStatus({
      state: "syncing",
      configured: true,
      startedAt: progressInput.startedAt,
      lastSyncedAt: progressInput.lastSyncedAt,
      progress: clampHistorySyncProgress(progressInput.progress),
    });

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
        ? input.importRemoteDeltaEvents(events)
        : input.importRemoteEvents(events);
      yield* input.reloadProjections({
        context,
        publishProgress: publishSyncProgress,
      });
      const projectionCounts = yield* input.readLocalProjectionCounts;
      console.info("[history-sync] local import projected", {
        importedEvents: events.length,
        importedThreadCreates: events.filter((event) => event.eventType === "thread.created")
          .length,
        projectionCounts,
      });
    });

  const filterAlreadyImportedRemotePageEvents = (
    remoteEvents: readonly HistorySyncEventRow[],
  ): Effect.Effect<readonly HistorySyncEventRow[], object> =>
    Effect.gen(function* () {
      if (remoteEvents.length === 0) {
        return remoteEvents;
      }
      const localRefs = yield* input.readLocalEventRefsForSequences(
        remoteEvents.map((event) => event.sequence),
      );
      const localEventIdBySequence = new Map(
        localRefs.map((event) => [event.sequence, event.eventId] as const),
      );
      return remoteEvents.filter(
        (event) => localEventIdBySequence.get(event.sequence) !== event.eventId,
      );
    });

  const publishLatestFirstProgress = (
    context: {
      readonly startedAt: string;
      readonly lastSyncedAt: string | null;
    },
    progress: HistorySyncProgress,
    inputOptions: { readonly liveAppendEnabled: boolean },
  ) =>
    Effect.gen(function* () {
      const counts = yield* input.readHistorySyncThreadStateCounts;
      yield* input.publishStatus({
        state: "syncing",
        configured: true,
        startedAt: context.startedAt,
        lastSyncedAt: context.lastSyncedAt,
        lane: "latest-bootstrap",
        progress: clampHistorySyncProgress(progress),
        partial: {
          ...counts,
          liveAppendEnabled: inputOptions.liveAppendEnabled,
        },
      });
    });

  const runLatestFirstBootstrap = (bootstrapInput: {
    readonly connectionString: string;
    readonly remoteMaxSequence: number;
    readonly projectMappings: readonly HistorySyncProjectMappingRow[];
    readonly liveAppendEnabled: boolean;
    readonly context: {
      readonly startedAt: string;
      readonly lastSyncedAt: string | null;
    };
  }) =>
    Effect.gen(function* () {
      const pageSize = 50;
      let offset = 0;
      let importedThroughSequence = 0;
      let importedThreadCount = 0;
      yield* publishLatestFirstProgress(
        bootstrapInput.context,
        {
          phase: "latest-bootstrap",
          label: "Loading recent threads",
          current: 0,
          total: 3,
        },
        { liveAppendEnabled: bootstrapInput.liveAppendEnabled },
      );

      while (true) {
        const latestThreads = yield* input.readRemoteLatestThreadShells(
          bootstrapInput.connectionString,
          { limit: pageSize, offset },
        );
        if (latestThreads.length === 0) break;

        const now = new Date().toISOString();
        yield* input.upsertHistorySyncThreadStates(
          latestThreads.map((thread) => ({
            threadId: thread.threadId,
            remoteProjectId: thread.projectId,
            latestRemoteSequence: thread.latestEventSequence,
            isShellLoaded: true,
            now,
          })),
        );
        yield* publishLatestFirstProgress(
          bootstrapInput.context,
          {
            phase: "latest-bootstrap",
            label: offset === 0 ? "Loading recent thread events" : "Loading older thread events",
            current: importedThreadCount + latestThreads.length,
            total: Math.max(importedThreadCount + latestThreads.length, pageSize),
          },
          { liveAppendEnabled: bootstrapInput.liveAppendEnabled },
        );

        const threadEvents = yield* input.readRemoteEventsForThreadIds(
          bootstrapInput.connectionString,
          latestThreads.map((thread) => thread.threadId),
        );
        const projectIds = latestThreads.flatMap((thread) =>
          thread.projectId === null ? [] : [thread.projectId],
        );
        const projectEvents = yield* input.readRemoteProjectEventsForProjectIds(
          bootstrapInput.connectionString,
          projectIds,
        );
        const remoteEvents = [...projectEvents, ...threadEvents].toSorted(
          (left, right) => left.sequence - right.sequence,
        );
        if (remoteEvents.length > 0) {
          const remoteEventsForLocal = rewriteRemoteEventsForLocalMappings(
            normalizeRemoteEventsForLocalImport(remoteEvents),
            bootstrapInput.projectMappings,
          );
          const remoteEventsToImport =
            yield* filterAlreadyImportedRemotePageEvents(remoteEventsForLocal);
          if (remoteEventsToImport.length > 0) {
            yield* publishLatestFirstProgress(
              bootstrapInput.context,
              {
                phase: "latest-bootstrap",
                label: offset === 0 ? "Projecting recent threads" : "Projecting older threads",
                current: importedThreadCount,
                total: Math.max(importedThreadCount + latestThreads.length, pageSize),
              },
              { liveAppendEnabled: bootstrapInput.liveAppendEnabled },
            );
            yield* runImport(remoteEventsToImport, bootstrapInput.context, { mode: "delta" });
            importedThroughSequence = Math.max(
              importedThroughSequence,
              maxHistoryEventSequence(remoteEvents),
            );
          }
        }

        const completedAt = new Date().toISOString();
        yield* input.upsertHistorySyncThreadStates(
          latestThreads.map((thread) => ({
            threadId: thread.threadId,
            remoteProjectId: thread.projectId,
            latestRemoteSequence: thread.latestEventSequence,
            importedThroughSequence: thread.latestEventSequence,
            isShellLoaded: true,
            isFullLoaded: true,
            now: completedAt,
          })),
        );
        importedThreadCount += latestThreads.length;
        offset += latestThreads.length;
        yield* input.updateHistorySyncLatestFirstState({
          remoteAppliedSequence: importedThroughSequence,
          remoteKnownMaxSequence: bootstrapInput.remoteMaxSequence,
          latestBootstrapCompletedAt: offset === latestThreads.length ? completedAt : null,
          backfillCursorUpdatedAt: offset > latestThreads.length ? completedAt : null,
          liveAppendEnabled: bootstrapInput.liveAppendEnabled,
        });
        if (latestThreads.length < pageSize) break;
        yield* Effect.sleep(25);
      }
      if (importedThreadCount === 0) return;
      const completedAt = new Date().toISOString();
      yield* input.updateHistorySyncLatestFirstState({
        remoteAppliedSequence: importedThroughSequence,
        remoteKnownMaxSequence: bootstrapInput.remoteMaxSequence,
        backfillCursorUpdatedAt: completedAt,
        liveAppendEnabled: bootstrapInput.liveAppendEnabled,
      });
      yield* publishLatestFirstProgress(
        bootstrapInput.context,
        {
          phase: "latest-bootstrap",
          label: "Thread history ready",
          current: importedThreadCount,
          total: importedThreadCount,
        },
        { liveAppendEnabled: bootstrapInput.liveAppendEnabled },
      );
    });

  const recordInitialSyncPhase = (
    phase: HistorySyncInitialSyncPhase,
    inputContext: { readonly startedAt: string },
  ) =>
    input.setInitialSyncPhase({
      phase,
      startedAt: inputContext.startedAt,
    });

  const commitAfterRemoteWrite = (inputEvents: {
    readonly remoteCoveredEvents?: readonly HistorySyncEventRow[];
    readonly pushedEvents?: readonly HistorySyncEventRow[];
    readonly previousRemoteSequence: number;
    readonly pushedAt: string;
    readonly hasCompletedInitialSync?: boolean;
  }) => {
    const commitPlan = planLocalCommitAfterRemoteWrite({
      previousRemoteSequence: inputEvents.previousRemoteSequence,
      ...(inputEvents.remoteCoveredEvents !== undefined
        ? { remoteCoveredEvents: inputEvents.remoteCoveredEvents }
        : {}),
      ...(inputEvents.pushedEvents !== undefined ? { pushedEvents: inputEvents.pushedEvents } : {}),
    });
    return input.commitPushedEventReceiptsAndState({
      events: commitPlan.receiptEvents,
      pushedAt: inputEvents.pushedAt,
      state: {
        hasCompletedInitialSync: inputEvents.hasCompletedInitialSync ?? true,
        lastSyncedRemoteSequence: commitPlan.lastSyncedRemoteSequence,
        lastSuccessfulSyncAt: inputEvents.pushedAt,
      },
    });
  };

  const performSync = (options: HistorySyncRunnerOptions): Effect.Effect<void> =>
    Effect.gen(function* () {
      const settings = yield* input.getSettings;
      const connectionString = yield* input.getConnectionString;
      const state = yield* input.readState;
      const hasCompletedInitialSync = state?.hasCompletedInitialSync === 1;
      const isInitialSync = options.mode === "initial";
      const isAutosave = options.mode === "autosave";
      console.info("[history-sync] sync preflight", {
        mode: options.mode,
        enabled: settings.historySync.enabled,
        configured: connectionString !== null,
        hasCompletedInitialSync,
        lastSyncedRemoteSequence: state?.lastSyncedRemoteSequence ?? null,
        lastSuccessfulSyncAt: state?.lastSuccessfulSyncAt ?? null,
      });
      if (
        connectionString === null ||
        (!settings.historySync.enabled && !(isInitialSync && !hasCompletedInitialSync))
      ) {
        yield* input.publishStatus({
          state: "disabled",
          configured: connectionString !== null,
        });
        return;
      }

      const previousStatus = yield* Ref.get(input.statusRef);
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
      const lastSyncedRemoteSequence = state?.lastSyncedRemoteSequence ?? 0;
      const readLocalAutosaveContext = (remoteMaxSequence: number) =>
        input.readLocalEventsForSequences([Math.max(lastSyncedRemoteSequence, remoteMaxSequence)]);
      let autosaveRemoteMaxSequence: number | null = null;
      if (hasCompletedInitialSync && isAutosave) {
        const remoteMaxSequence = yield* input.readRemoteMaxSequence(connectionString);
        autosaveRemoteMaxSequence = remoteMaxSequence;
        if (remoteMaxSequence <= lastSyncedRemoteSequence) {
          const unpushedLocalEvents = yield* input.readUnpushedLocalEvents;
          if (unpushedLocalEvents.length === 0) {
            console.info("[history-sync] autosave skipped before visible sync", {
              reason: "no-unpushed-events",
              remoteMaxSequence,
              lastSyncedRemoteSequence,
            });
            return;
          }
          const projectionThreadRows = yield* input.readProjectionThreadAutosyncRows;
          const localBoundaryEvents = yield* readLocalAutosaveContext(remoteMaxSequence);
          const localPushPlan = planAutosaveLocalPush({
            localEvents: [...localBoundaryEvents, ...unpushedLocalEvents],
            unpushedLocalEvents,
            remoteMaxSequence,
            projectionThreadRows,
            ...(options.autosaveMaxSequence !== undefined
              ? { maxSequence: options.autosaveMaxSequence }
              : {}),
          });
          if (localPushPlan.action !== "push-local") {
            console.info("[history-sync] autosave skipped before visible sync", {
              reason: "no-pushable-events",
              remoteMaxSequence,
              lastSyncedRemoteSequence,
            });
            return;
          }
        }
      }
      yield* input.publishStatus({
        state: "syncing",
        configured: true,
        startedAt: syncStartedAt,
        lastSyncedAt,
      });

      if (hasCompletedInitialSync && !isInitialSync && !isAutosave) {
        console.info("[history-sync] checking completed sync fast path", {
          mode: options.mode,
          lastSyncedRemoteSequence,
        });
        const remoteMaxSequence = yield* input.readRemoteMaxSequence(connectionString);
        if (remoteMaxSequence === lastSyncedRemoteSequence) {
          const unpushedLocalEvents = yield* input.readUnpushedLocalEvents;
          if (unpushedLocalEvents.length === 0) {
            const now = new Date().toISOString();
            console.info("[history-sync] completed sync fast path idle", {
              remoteMaxSequence,
              lastSyncedRemoteSequence,
            });
            yield* input.commitHistorySyncState({
              hasCompletedInitialSync: true,
              lastSyncedRemoteSequence,
              lastSuccessfulSyncAt: now,
            });
            yield* input.publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
            return;
          }
          console.info("[history-sync] completed sync fast path found local pending history", {
            remoteMaxSequence,
            unpushedLocalEvents: unpushedLocalEvents.length,
          });
          const projectMappings = yield* input.readProjectMappings;
          const projectionThreadRows = yield* input.readProjectionThreadAutosyncRows;
          const localBoundaryEvents = yield* input.readLocalEventsForSequences([
            lastSyncedRemoteSequence,
          ]);
          const localPushPlan = planAutosaveLocalPush({
            localEvents: [...localBoundaryEvents, ...unpushedLocalEvents],
            unpushedLocalEvents,
            remoteMaxSequence,
            projectionThreadRows,
          });
          if (localPushPlan.action === "push-local") {
            console.info("[history-sync] completed sync fast path pushing local pending history", {
              pendingEvents: localPushPlan.pushableEvents.length,
              deferredEvents:
                localPushPlan.candidateEvents.length - localPushPlan.pushableEvents.length,
              localMaxSequence: maxHistoryEventSequence(unpushedLocalEvents),
              lastSyncedRemoteSequence,
              remoteMaxSequence,
            });
            yield* input.pushRemoteEventsBatched(
              connectionString,
              rewriteLocalEventsForRemoteMappings(localPushPlan.pushableEvents, projectMappings),
            );
            const now = new Date().toISOString();
            yield* commitAfterRemoteWrite({
              pushedEvents: localPushPlan.pushableEvents,
              previousRemoteSequence: lastSyncedRemoteSequence,
              pushedAt: now,
            });
            yield* input.publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
            return;
          }
          console.info("[history-sync] completed sync fast path deferred local pending history", {
            remoteMaxSequence,
            lastSyncedRemoteSequence,
          });
          yield* input.publishStatus({
            state: "idle",
            configured: true,
            lastSyncedAt: lastSyncedAt ?? state?.lastSuccessfulSyncAt ?? null,
          });
          return;
        }
      }

      if (!hasCompletedInitialSync && !isInitialSync) {
        yield* input.publishStatus({
          state: "needs-initial-sync",
          configured: true,
          lastSyncedAt: state?.lastSuccessfulSyncAt ?? lastSyncedAt,
        });
        return;
      }

      if (isAutosave) {
        const remoteMaxSequence =
          autosaveRemoteMaxSequence ??
          (yield* Effect.sync(() =>
            console.info("[history-sync] reading remote max sequence for autosave"),
          ).pipe(Effect.andThen(input.readRemoteMaxSequence(connectionString))));
        console.info("[history-sync] remote max sequence loaded for autosave", {
          remoteMaxSequence,
          lastSyncedRemoteSequence,
        });
        let autosaveLastSyncedAt = lastSyncedAt;
        let localEventsForAutosave: readonly HistorySyncEventRow[] | null = null;
        if (remoteMaxSequence > lastSyncedRemoteSequence) {
          console.info("[history-sync] reading remote delta for autosave", {
            lastSyncedRemoteSequence,
          });
          const remoteDeltaEvents = yield* input.readRemoteEvents(
            connectionString,
            lastSyncedRemoteSequence,
          );
          localEventsForAutosave = yield* input.readLocalEvents(lastSyncedRemoteSequence);
          const remoteDeltaPlan = planAutosaveRemoteDelta({
            remoteDeltaEvents,
            localEvents: localEventsForAutosave,
          });
          if (remoteDeltaPlan.action === "remote-conflict") {
            const conflict = describeAutosaveRemoteConflict({
              remoteMaxSequence,
              lastSyncedRemoteSequence,
              remoteDeltaEventCount: remoteDeltaPlan.remoteDeltaEvents.length,
              unknownRemoteEventCount: remoteDeltaPlan.unknownRemoteDeltaEvents.length,
            });
            console.warn("[history-sync] autosave paused because remote has unknown events", {
              remoteMaxSequence: conflict.remoteMaxSequence,
              lastSyncedRemoteSequence: conflict.lastSyncedRemoteSequence,
              remoteDeltaEvents: conflict.remoteDeltaEventCount,
              unknownRemoteDeltaEvents: conflict.unknownRemoteEventCount,
            });
            yield* options.markStopped;
            yield* input.publishStatus({
              state: "error",
              configured: true,
              message: conflict.message,
              lastSyncedAt,
            });
            return;
          }
          if (remoteDeltaPlan.action !== "accept-remote-delta") {
            return yield* Effect.fail(new Error("Unexpected autosave remote delta plan."));
          }

          const now = new Date().toISOString();
          yield* commitAfterRemoteWrite({
            remoteCoveredEvents: remoteDeltaPlan.remoteCoveredEvents,
            previousRemoteSequence: lastSyncedRemoteSequence,
            pushedAt: now,
          });
          autosaveLastSyncedAt = now;
          console.info("[history-sync] autosave accepted remote delta already present locally", {
            remoteMaxSequence,
            lastSyncedRemoteSequence,
            remoteDeltaEvents: remoteDeltaEvents.length,
          });
        }

        const projectMappings = yield* input.readProjectMappings;
        const unpushedLocalEvents = yield* input.readUnpushedLocalEvents;
        const projectionThreadRows = yield* input.readProjectionThreadAutosyncRows;
        const localEventsForLocalPush = localEventsForAutosave ?? [
          ...(yield* readLocalAutosaveContext(remoteMaxSequence)),
          ...unpushedLocalEvents,
        ];
        const remoteCoveredReceiptEvents = planAutosaveRemoteCoveredReceipts({
          unpushedLocalEvents,
          remoteMaxSequence,
        });
        if (remoteCoveredReceiptEvents.length > 0) {
          const now = new Date().toISOString();
          yield* commitAfterRemoteWrite({
            remoteCoveredEvents: remoteCoveredReceiptEvents,
            previousRemoteSequence: Math.max(lastSyncedRemoteSequence, remoteMaxSequence),
            pushedAt: now,
          });
          autosaveLastSyncedAt = now;
          console.info("[history-sync] autosave seeded receipts for remote-covered events", {
            events: remoteCoveredReceiptEvents.length,
            remoteMaxSequence,
          });
        }
        const localPushPlan = planAutosaveLocalPush({
          localEvents: localEventsForLocalPush,
          unpushedLocalEvents,
          remoteMaxSequence,
          projectionThreadRows,
          ...(options.autosaveMaxSequence !== undefined
            ? { maxSequence: options.autosaveMaxSequence }
            : {}),
        });
        if (localPushPlan.action === "push-local") {
          console.info("[history-sync] autosaving local pending history", {
            pendingEvents: localPushPlan.pushableEvents.length,
            deferredEvents:
              localPushPlan.candidateEvents.length - localPushPlan.pushableEvents.length,
            localMaxSequence: maxHistoryEventSequence(localEventsForLocalPush),
            lastSyncedRemoteSequence: Math.max(lastSyncedRemoteSequence, remoteMaxSequence),
            remoteMaxSequence,
          });
          yield* input.pushRemoteEventsBatched(
            connectionString,
            rewriteLocalEventsForRemoteMappings(localPushPlan.pushableEvents, projectMappings),
          );
          const now = new Date().toISOString();
          yield* commitAfterRemoteWrite({
            pushedEvents: localPushPlan.pushableEvents,
            previousRemoteSequence: Math.max(lastSyncedRemoteSequence, remoteMaxSequence),
            pushedAt: now,
          });
          yield* input.publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
          return;
        }

        yield* input.publishStatus({
          state: "idle",
          configured: true,
          lastSyncedAt: autosaveLastSyncedAt,
        });
        return;
      }

      console.info("[history-sync] reading local history", { mode: options.mode });
      let localEvents = yield* input.readLocalEvents();
      const localProjectionCounts = yield* input.readLocalProjectionCounts;
      const localMaxSequence = maxHistoryEventSequence(localEvents);
      console.info("[history-sync] local history loaded", {
        mode: options.mode,
        localEvents: localEvents.length,
        localMaxSequence,
        localProjectionCounts,
        lastSyncedRemoteSequence,
      });
      yield* input.seedPushedEventReceiptsForCompletedSync(localEvents, {
        hasCompletedInitialSync,
        lastSyncedRemoteSequence,
        seededAt: syncStartedAt,
      });
      if (!hasCompletedInitialSync && isInitialSync) {
        yield* recordInitialSyncPhase("backup", syncContext);
        yield* input.createBackup;
      }

      const remoteMaxSequenceForRepair = hasCompletedInitialSync
        ? yield* Effect.sync(() =>
            console.info("[history-sync] reading remote max sequence", {
              lastSyncedRemoteSequence,
            }),
          ).pipe(Effect.andThen(input.readRemoteMaxSequence(connectionString)))
        : 0;
      if (hasCompletedInitialSync) {
        console.info("[history-sync] remote max sequence loaded", {
          remoteMaxSequence: remoteMaxSequenceForRepair,
          lastSyncedRemoteSequence,
        });
      }
      const shouldUseFullRemoteForRecovery =
        hasCompletedInitialSync &&
        (localEvents.length === 0 ||
          localProjectionCounts.projectCount + localProjectionCounts.threadCount === 0);
      console.info("[history-sync] reading remote history", {
        mode: options.mode,
        hasCompletedInitialSync,
        shouldUseFullRemoteForRecovery,
        sequenceExclusive:
          !hasCompletedInitialSync || shouldUseFullRemoteForRecovery
            ? null
            : lastSyncedRemoteSequence,
      });
      const remoteEvents =
        !hasCompletedInitialSync || shouldUseFullRemoteForRecovery
          ? yield* input.readRemoteEvents(connectionString)
          : yield* input.readRemoteEvents(connectionString, lastSyncedRemoteSequence);
      const remoteMaxSequence = maxHistoryEventSequence(
        remoteEvents,
        hasCompletedInitialSync ? remoteMaxSequenceForRepair : 0,
      );
      console.info("[history-sync] remote history loaded", {
        remoteEvents: remoteEvents.length,
        remoteMaxSequence,
      });
      const remoteEventsForMapping = remoteEvents;
      const mappingPlan = yield* input.buildProjectMappingPlanFromEvents({
        remoteEvents: remoteEventsForMapping,
        remoteMaxSequence,
      });
      yield* input.autoPersistExactProjectMappings(mappingPlan);
      const refreshedMappingPlan = yield* input.buildProjectMappingPlanFromEvents({
        remoteEvents: remoteEventsForMapping,
        remoteMaxSequence,
      });
      const unresolvedProjectCount = refreshedMappingPlan.candidates.filter(
        (candidate) => candidate.status === "unresolved",
      ).length;
      if (unresolvedProjectCount > 0) {
        yield* input.publishStatus({
          state: "needs-project-mapping",
          configured: true,
          remoteMaxSequence,
          unresolvedProjectCount,
          lastSyncedAt,
        });
        return;
      }
      const projectMappings = yield* input.readProjectMappings;
      if (
        hasCompletedInitialSync &&
        remoteMaxSequence > lastSyncedRemoteSequence &&
        remoteEvents.length >= HISTORY_SYNC_LATEST_FIRST_MIN_REMOTE_DELTA_EVENTS
      ) {
        yield* runLatestFirstBootstrap({
          connectionString,
          remoteMaxSequence,
          projectMappings,
          liveAppendEnabled: true,
          context: syncContext,
        }).pipe(
          Effect.timeout(HISTORY_SYNC_LATEST_FIRST_BOOTSTRAP_TIMEOUT_MS),
          Effect.catch((cause) =>
            Effect.logWarning("latest-first history bootstrap failed; continuing full sync", {
              cause,
            }),
          ),
        );
        localEvents = yield* input.readLocalEvents();
      }
      const remoteEventsForLocal = rewriteRemoteEventsForLocalMappings(
        normalizeRemoteEventsForLocalImport(remoteEvents),
        projectMappings,
      );
      if (!hasCompletedInitialSync && localEvents.length === 0 && remoteMaxSequence > 0) {
        yield* runLatestFirstBootstrap({
          connectionString,
          remoteMaxSequence,
          projectMappings,
          liveAppendEnabled: false,
          context: syncContext,
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning(
              "latest-first initial history bootstrap failed; continuing initial sync",
              {
                cause,
              },
            ),
          ),
        );
        localEvents = yield* input.readLocalEvents();
      }
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
          recoveryPhase: state?.initialSyncPhase ?? null,
        });
        const runFirstSyncLocalPush = (inputEvents: {
          readonly pushEvents: readonly HistorySyncEventRow[];
          readonly receiptEvents: readonly HistorySyncEventRow[];
          readonly nextRemoteSequence: number;
        }) =>
          Effect.gen(function* () {
            yield* recordInitialSyncPhase("push-local", syncContext);
            yield* input.pushRemoteEventsBatched(connectionString, inputEvents.pushEvents);
            const now = new Date().toISOString();
            yield* recordInitialSyncPhase("write-state", syncContext);
            yield* input.commitPushedEventReceiptsAndState({
              events: inputEvents.receiptEvents,
              pushedAt: now,
              state: {
                hasCompletedInitialSync: true,
                lastSyncedRemoteSequence: inputEvents.nextRemoteSequence,
                lastSuccessfulSyncAt: now,
              },
            });
            yield* input.clearInitialSyncPhase;
            yield* input.publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
          });
        const finishFirstSyncState = (inputEvents: {
          readonly receiptEvents: readonly HistorySyncEventRow[];
          readonly nextRemoteSequence: number;
        }) =>
          Effect.gen(function* () {
            const now = new Date().toISOString();
            yield* recordInitialSyncPhase("write-state", syncContext);
            yield* input.commitPushedEventReceiptsAndState({
              events: inputEvents.receiptEvents,
              pushedAt: now,
              state: {
                hasCompletedInitialSync: true,
                lastSyncedRemoteSequence: inputEvents.nextRemoteSequence,
                lastSuccessfulSyncAt: now,
              },
            });
            yield* input.clearInitialSyncPhase;
            yield* input.publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
          });
        const runFirstSyncRemoteImport = (inputEvents: {
          readonly pushEvents: readonly HistorySyncEventRow[];
          readonly importedEvents: readonly HistorySyncEventRow[];
          readonly receiptEvents: readonly HistorySyncEventRow[];
          readonly nextRemoteSequence: number;
          readonly skipPushWhenEmpty?: boolean;
        }) =>
          Effect.gen(function* () {
            if (inputEvents.pushEvents.length > 0 || !inputEvents.skipPushWhenEmpty) {
              yield* recordInitialSyncPhase("push-merge", syncContext);
              yield* input.pushRemoteEventsBatched(connectionString, inputEvents.pushEvents);
            }
            yield* recordInitialSyncPhase("import-remote", syncContext);
            yield* runImport(inputEvents.importedEvents, syncContext);
            yield* finishFirstSyncState({
              receiptEvents: inputEvents.receiptEvents,
              nextRemoteSequence: inputEvents.nextRemoteSequence,
            });
          });

        const firstSyncPlan = planFirstSync({
          initialSyncPhase: state?.initialSyncPhase ?? null,
          localEvents,
          localEventsForRemote,
          remoteEvents,
          remoteEventsForLocal,
          remoteMaxSequence,
          projectMappings,
        });

        if (firstSyncPlan.action === "recover") {
          const recoveryPlan = firstSyncPlan.recoveryPlan;
          console.info("[history-sync] first sync recovery planned", {
            phase: state?.initialSyncPhase ?? null,
            action: recoveryPlan.action,
          });
          if (recoveryPlan.action === "continue-local-push") {
            yield* runFirstSyncLocalPush(recoveryPlan);
            return;
          }
          if (recoveryPlan.action === "continue-remote-import") {
            yield* runFirstSyncRemoteImport({
              ...recoveryPlan,
              skipPushWhenEmpty: true,
            });
            return;
          }
          if (recoveryPlan.action === "finish-state") {
            yield* finishFirstSyncState(recoveryPlan);
            return;
          }
          if (recoveryPlan.action === "require-review") {
            return yield* Effect.fail(new Error(recoveryPlan.message));
          }
        }

        if (firstSyncPlan.action === "local-push") {
          console.info("[history-sync] first sync pushing local history to empty remote", {
            localEvents: localEvents.length,
            localMaxSequence,
          });
          yield* runFirstSyncLocalPush(firstSyncPlan);
          return;
        }
        if (firstSyncPlan.action !== "remote-import") {
          return yield* Effect.fail(new Error("Unexpected first sync plan."));
        }

        console.info("[history-sync] first sync client merge computed", {
          mergedEvents: firstSyncPlan.importedEvents.length - remoteEventsForLocal.length,
        });
        yield* runFirstSyncRemoteImport(firstSyncPlan);
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
        yield* input.pushRemoteEventsBatched(
          connectionString,
          rewriteLocalEventsForRemoteMappings(pending, projectMappings),
        );
        const now = new Date().toISOString();
        yield* commitAfterRemoteWrite({
          remoteCoveredEvents: selectRemoteCoveredLocalEvents({
            localEvents,
            remoteEvents,
          }),
          pushedEvents: pending,
          previousRemoteSequence: remoteMaxSequence,
          pushedAt: now,
        });
        yield* input.publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
        return;
      }

      const localReplacementDecision = planLocalReplacementFromRemote({
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
      const shouldReplaceLocalFromRemote = localReplacementDecision.shouldReplace;
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
          ...(localReplacementDecision.reason
            ? { replacementReason: localReplacementDecision.reason }
            : {}),
        });
        if (remoteEventsToImport.length > 0) {
          yield* runImport(remoteEventsToImport, syncContext, {
            mode: shouldReplaceLocalFromRemote ? "replace" : "delta",
          });
        }
        const now = new Date().toISOString();
        yield* commitAfterRemoteWrite({
          remoteCoveredEvents: selectRemoteCoveredLocalEvents({
            localEvents: shouldReplaceLocalFromRemote ? remoteEventsForLocal : localEvents,
            remoteEvents: remoteEventsForLocal,
          }),
          previousRemoteSequence: lastSyncedRemoteSequence,
          pushedAt: now,
        });
        if (shouldReplaceLocalFromRemote) {
          yield* input.publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
          return;
        }

        const refreshedLocalEvents = yield* input.readLocalEvents();
        const unpushedLocalEvents = yield* input.readUnpushedLocalEvents;
        const pushableLocalEvents = filterPushableLocalEvents(
          unpushedLocalEvents,
          refreshedLocalEvents,
        );
        if (pushableLocalEvents.length > 0) {
          console.info("[history-sync] pushing local pending history after remote import", {
            pendingEvents: pushableLocalEvents.length,
            deferredEvents: unpushedLocalEvents.length - pushableLocalEvents.length,
            localMaxSequence: maxHistoryEventSequence(refreshedLocalEvents),
            lastSyncedRemoteSequence: remoteMaxSequence,
          });
          yield* input.pushRemoteEventsBatched(
            connectionString,
            rewriteLocalEventsForRemoteMappings(pushableLocalEvents, projectMappings),
          );
          const pushedAt = new Date().toISOString();
          yield* commitAfterRemoteWrite({
            pushedEvents: pushableLocalEvents,
            previousRemoteSequence: remoteMaxSequence,
            pushedAt,
          });
          yield* input.publishStatus({ state: "idle", configured: true, lastSyncedAt: pushedAt });
          return;
        }

        yield* input.publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
        return;
      }

      const unpushedLocalEvents = yield* input.readUnpushedLocalEvents;
      const pushableLocalEvents = filterPushableLocalEvents(unpushedLocalEvents, localEvents);
      if (pushableLocalEvents.length > 0) {
        console.info("[history-sync] pushing local pending history", {
          pendingEvents: pushableLocalEvents.length,
          deferredEvents: unpushedLocalEvents.length - pushableLocalEvents.length,
          localMaxSequence,
          lastSyncedRemoteSequence,
        });
        yield* input.pushRemoteEventsBatched(
          connectionString,
          rewriteLocalEventsForRemoteMappings(pushableLocalEvents, projectMappings),
        );
        const now = new Date().toISOString();
        yield* commitAfterRemoteWrite({
          pushedEvents: pushableLocalEvents,
          previousRemoteSequence: lastSyncedRemoteSequence,
          pushedAt: now,
        });
        yield* input.publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
        return;
      }

      const now = new Date().toISOString();
      yield* input.commitHistorySyncState({
        hasCompletedInitialSync: true,
        lastSyncedRemoteSequence,
        lastSuccessfulSyncAt: now,
      });
      yield* input.publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
    }).pipe(
      Effect.timeout(HISTORY_SYNC_OPERATION_TIMEOUT_MS),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const previousStatus = yield* Ref.get(input.statusRef);
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
          if (options.mode === "initial") {
            yield* input
              .failInitialSyncPhase({
                error: message || "History sync failed.",
                failedAt: new Date().toISOString(),
              })
              .pipe(Effect.ignoreCause({ log: true }));
          }
          const retryAttempt = options.retryAttempt ?? 1;
          const retryDelayMs = shouldRetryHistorySyncFailure({
            mode: options.mode,
            cause,
            isRetryableConnectionFailure: input.isRetryableConnectionFailure,
          })
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
            yield* input.publishStatus({
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

          yield* options.markStopped;
          const retryFailures = options.retryContext?.recentFailures;
          yield* input.publishStatus({
            state: "error",
            configured: true,
            message: message || "History sync failed.",
            lastSyncedAt,
            ...(retryFailures
              ? {
                  retry: {
                    firstFailedAt: options.retryContext?.firstFailedAt ?? new Date().toISOString(),
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

  const runPriorityThreadImport = (threadId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const settings = yield* input.getSettings;
      const connectionString = yield* input.getConnectionString;
      const state = yield* input.readState;
      if (
        connectionString === null ||
        !settings.historySync.enabled ||
        state?.hasCompletedInitialSync !== 1
      ) {
        return;
      }
      const threadState = yield* input.readHistorySyncThreadState(threadId);
      if (threadState === null) {
        logPriorityThreadDecision("skip", { threadId, reason: "no-thread-state" });
        return;
      }
      if (threadState.isShellLoaded !== 1) {
        logPriorityThreadDecision("skip", {
          threadId,
          reason: "marker-only",
          latestRemoteSequence: threadState.latestRemoteSequence,
          importedThroughSequence: threadState.importedThroughSequence,
          isShellLoaded: threadState.isShellLoaded,
          isFullLoaded: threadState.isFullLoaded,
          lastRequestedAt: threadState.lastRequestedAt,
        });
        return;
      }
      if (threadState.isFullLoaded === 1) {
        logPriorityThreadDecision("skip", {
          threadId,
          reason: "already-full",
          latestRemoteSequence: threadState.latestRemoteSequence,
          importedThroughSequence: threadState.importedThroughSequence,
          lastRequestedAt: threadState.lastRequestedAt,
        });
        return;
      }
      if (threadState.latestRemoteSequence <= threadState.importedThroughSequence) {
        logPriorityThreadDecision("skip", {
          threadId,
          reason: "already-imported-through-remote",
          latestRemoteSequence: threadState.latestRemoteSequence,
          importedThroughSequence: threadState.importedThroughSequence,
          lastRequestedAt: threadState.lastRequestedAt,
        });
        return;
      }
      const previousRequestedAtMs =
        threadState.lastRequestedAt === null ? 0 : Date.parse(threadState.lastRequestedAt);
      if (
        Number.isFinite(previousRequestedAtMs) &&
        Date.now() - previousRequestedAtMs < HISTORY_SYNC_PRIORITY_RETRY_BACKOFF_MS
      ) {
        logPriorityThreadDecision("skip", {
          threadId,
          reason: "recent-attempt-backoff",
          latestRemoteSequence: threadState.latestRemoteSequence,
          importedThroughSequence: threadState.importedThroughSequence,
          lastRequestedAt: threadState.lastRequestedAt,
        });
        return;
      }

      const requestedAt = new Date().toISOString();
      logPriorityThreadDecision("start", {
        threadId,
        latestRemoteSequence: threadState.latestRemoteSequence,
        importedThroughSequence: threadState.importedThroughSequence,
        requestedAt,
      });
      yield* input.markHistorySyncThreadPriority({
        threadId,
        priority: 100,
        requestedAt,
      });
      const previousStatus = yield* Ref.get(input.statusRef);
      const lastSyncedAt =
        previousStatus.state === "idle" ||
        previousStatus.state === "syncing" ||
        previousStatus.state === "error" ||
        previousStatus.state === "needs-project-mapping" ||
        previousStatus.state === "needs-initial-sync"
          ? previousStatus.lastSyncedAt
          : null;
      const context = { startedAt: requestedAt, lastSyncedAt };

      const threadEvents = yield* input.readRemoteEventsForThreadIds(connectionString, [threadId]);
      logPriorityThreadDecision("remote-read", {
        threadId,
        threadEvents: threadEvents.length,
      });
      if (threadEvents.length === 0) {
        logPriorityThreadDecision("skip", { threadId, reason: "remote-thread-empty" });
        return;
      }
      const projectIds = collectProjectCandidates(threadEvents).map((project) => project.projectId);
      const projectEvents = yield* input.readRemoteProjectEventsForProjectIds(
        connectionString,
        projectIds,
      );
      logPriorityThreadDecision("remote-read", {
        threadId,
        projectIds: projectIds.length,
        projectEvents: projectEvents.length,
      });
      const remoteEvents = [...projectEvents, ...threadEvents].toSorted(
        (left, right) => left.sequence - right.sequence,
      );
      const remoteMaxSequence = yield* input.readRemoteMaxSequence(connectionString);
      const mappingPlan = yield* input.buildProjectMappingPlanFromEvents({
        remoteEvents,
        remoteMaxSequence,
      });
      const unresolvedProjectCount = mappingPlan.candidates.filter(
        (candidate) => candidate.status === "unresolved",
      ).length;
      if (unresolvedProjectCount > 0) {
        logPriorityThreadDecision("mapping", {
          threadId,
          remoteMaxSequence,
          unresolvedProjectCount,
        });
        yield* input.publishStatus({
          state: "needs-project-mapping",
          configured: true,
          remoteMaxSequence,
          unresolvedProjectCount,
          lastSyncedAt,
        });
        return;
      }
      const projectMappings = yield* input.readProjectMappings;
      const remoteEventsForLocal = rewriteRemoteEventsForLocalMappings(
        normalizeRemoteEventsForLocalImport(remoteEvents),
        projectMappings,
      );
      yield* input.publishStatus({
        state: "syncing",
        configured: true,
        startedAt: requestedAt,
        lastSyncedAt,
        lane: "priority-thread",
        progress: {
          phase: "priority-thread",
          label: "Syncing opened thread",
          current: 1,
          total: 2,
        },
      });
      logPriorityThreadDecision("import", {
        threadId,
        remoteEvents: remoteEvents.length,
        rewrittenRemoteEvents: remoteEventsForLocal.length,
        remoteMaxSequence,
      });
      yield* runImport(remoteEventsForLocal, context, { mode: "delta" });
      const importedThroughSequence = maxHistoryEventSequence(remoteEvents);
      const completedAt = new Date().toISOString();
      yield* input.upsertHistorySyncThreadStates([
        {
          threadId,
          latestRemoteSequence: importedThroughSequence,
          importedThroughSequence,
          isShellLoaded: true,
          isFullLoaded: true,
          priority: 100,
          lastRequestedAt: requestedAt,
          now: completedAt,
        },
      ]);
      yield* input.updateHistorySyncLatestFirstState({
        remoteAppliedSequence: importedThroughSequence,
        remoteKnownMaxSequence: remoteMaxSequence,
        liveAppendEnabled: true,
        backfillCursorUpdatedAt: completedAt,
      });
      yield* input.publishStatus({
        state: "idle",
        configured: true,
        lastSyncedAt: completedAt,
      });
      logPriorityThreadDecision("complete", {
        threadId,
        importedThroughSequence,
        completedAt,
      });
    }).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const deferredAt = new Date().toISOString();
          yield* input
            .deferHistorySyncThreadPriority({ threadId, requestedAt: deferredAt })
            .pipe(Effect.ignoreCause({ log: true }));
          logPriorityThreadDecision("fail", {
            threadId,
            deferredAt,
            message: cause instanceof Error ? cause.message : String(cause),
            error: summarizeHistorySyncUnknownError(cause),
            cause,
          });
          yield* Effect.logWarning("priority thread history sync failed", { threadId, cause });
        }),
      ),
    );

  return { performSync, runImport, runPriorityThreadImport };
}
