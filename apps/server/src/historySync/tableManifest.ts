export const HISTORY_SYNC_LOCAL_HISTORY_TABLES = [
  "orchestration_command_receipts",
  "projection_pending_approvals",
  "projection_turns",
  "projection_thread_sessions",
  "projection_thread_activities",
  "projection_thread_proposed_plans",
  "projection_thread_messages",
  "projection_threads",
  "projection_projects",
  "projection_state",
  "checkpoint_diff_blobs",
  "tool_call_file_diffs",
  "history_sync_pushed_events",
  "history_sync_thread_state",
  "orchestration_events",
] as const;

export const HISTORY_SYNC_RESTORE_ONLY_TABLES = [
  "history_sync_project_mappings",
  "history_sync_state",
] as const;

export const HISTORY_SYNC_RESTORE_TABLES = [
  ...HISTORY_SYNC_LOCAL_HISTORY_TABLES,
  ...HISTORY_SYNC_RESTORE_ONLY_TABLES,
] as const;

export const HISTORY_SYNC_EXCLUDED_TABLES = [
  {
    tableName: "auth_pairing_links",
    reason: "Auth state is not history-derived and must survive history restore/import.",
  },
  {
    tableName: "auth_sessions",
    reason: "Auth state is not history-derived and must survive history restore/import.",
  },
  {
    tableName: "provider_session_runtime",
    reason: "Provider runtime process state is not history-derived.",
  },
] as const;

export type HistorySyncLocalHistoryTable = (typeof HISTORY_SYNC_LOCAL_HISTORY_TABLES)[number];
export type HistorySyncRestoreOnlyTable = (typeof HISTORY_SYNC_RESTORE_ONLY_TABLES)[number];
export type HistorySyncRestoreTable = (typeof HISTORY_SYNC_RESTORE_TABLES)[number];
