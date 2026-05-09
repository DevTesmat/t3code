// Public compatibility facade for history sync.
//
// New server-internal code should import from the owning modules under
// `./historySync/*` directly. Keep these re-exports stable for transitional
// callers and public RPC/status wiring that may still target `historySync.ts`.

export {
  applyHistorySyncProjectMappings,
  getHistorySyncConfig,
  getHistorySyncPendingEvents,
  getHistorySyncProjectMappings,
  prioritizeHistorySyncThread,
  resolveHistorySyncPendingEvents,
  restoreHistorySyncBackup,
  runHistorySync,
  startHistorySyncInitialImport,
  testHistorySyncConnection,
  updateHistorySyncConfig,
} from "./historySync/facade.ts";
export {
  HistorySyncService,
  HistorySyncServiceLive,
  type HistorySyncServiceShape,
} from "./historySync/service.ts";
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

export {
  buildMysqlConnectionString,
  isRetryableHistorySyncConnectionFailure,
  toConnectionSummary,
  validateMysqlFields,
} from "./historySync/remoteStore.ts";
