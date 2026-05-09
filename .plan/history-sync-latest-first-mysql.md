# History Sync: Latest-First MySQL Architecture

## Goal

Make MySQL-backed history sync usable across two autonomous workspaces, such as macOS and Windows, where both machines have the same projects but different local paths.

The client should fast-forward to the server state when local history is old, show recent threads before old ones, and allow normal app usage as soon as the recent/server-head subset is usable. Older history should continue backfilling in the background.

## Confirmed Product Behavior

- A thread created on one workspace must be resumable from the other workspace.
- The expected workflow is single-writer per thread in practice. If two devices append to the same thread concurrently, the app should produce a clear conflict state and, when safe, create a forked chat instead of silently merging divergent turns.
- The remote MySQL schema can be changed freely. Dropping/recreating remote sync tables and repopulating them from this machine's complete history is acceptable.
- Project mappings must always require user confirmation. Basename/path matches can be suggestions, but must not be auto-applied.
- The sidebar should show partially loaded threads as soon as possible. If a user opens a partially loaded thread, that thread's full sync should be prioritized immediately.

## Current Constraints

The current implementation is mostly global and sequence-first:

- Remote history is stored only in `orchestration_events`.
- Sync often reads all remote events or all local events.
- Project mapping is planned from full remote event history.
- Local import writes event rows and then performs a broad projection reload.
- Autosave can append local events only after the global sync path settles.

This is correct but too coarse for large history. It delays recent chat visibility, makes the UI feel blocked, and makes project mapping sensitive to projection state.

## Target Model

Keep `orchestration_events` as the canonical remote event log, but add remote sync indexes optimized for loading and resumability.

Remote MySQL tables:

- `orchestration_events`
  - Canonical append-only event log.
  - Existing uniqueness constraints remain: `event_id`, `(aggregate_kind, stream_id, stream_version)`, and `sequence`.
- `history_sync_projects`
  - Remote project shell/index.
  - Stores project id, title, workspace root, deleted state, first/latest sequence, updated timestamp.
- `history_sync_threads`
  - Remote thread shell/index.
  - Stores thread id, project id, title, created/updated timestamps, latest event sequence, deleted/archived state, and possibly last user message timestamp.
- `history_sync_thread_events`
  - Optional denormalized lookup table mapping `thread_id -> event sequence`.
  - Useful if querying thread events from JSON payloads becomes expensive.
- `history_sync_clients`
  - Remote registration and heartbeat metadata for each client/workspace.
- `history_sync_conflicts`
  - Explicit conflict records for divergent same-thread writes.

Local SQLite state:

- `history_sync_state`
  - Add fields for remote head and background cursors:
    - `remote_applied_sequence`
    - `remote_known_max_sequence`
    - `latest_bootstrap_completed_at`
    - `backfill_cursor_updated_at`
    - `live_append_enabled`
- `history_sync_thread_state`
  - Per-thread sync coverage:
    - `thread_id`
    - `remote_project_id`
    - `local_project_id`
    - `latest_remote_sequence`
    - `imported_through_sequence`
    - `is_shell_loaded`
    - `is_full_loaded`
    - `priority`
    - `last_requested_at`
- `history_sync_project_mappings`
  - Treat mappings as durable user decisions, not only projections over existing local project rows.
  - A mapping can be valid even before the local project projection row exists.

## Sync Lanes

### 1. Preflight Lane

Runs quickly at startup and before manual sync:

1. Ensure remote schema and migrations.
2. Read remote max sequence.
3. Read local sync state.
4. If local is behind, enter `fast-forwarding`.
5. If project mappings are missing, show the mapping flow before importing mapped thread events.

This lane must avoid reading all remote events.

### 2. Latest Bootstrap Lane

Loads recent usable history first:

1. Page `history_sync_threads` ordered by `updated_at DESC, latest_event_sequence DESC`.
2. For each page, fetch required project events and thread events.
3. Rewrite remote project ids to confirmed local project ids.
4. Insert local events idempotently.
5. Incrementally project imported batches.
6. Publish sidebar-visible thread shells and progress after each page.

Once this lane reaches the current remote head for the latest page window, set `live_append_enabled = true` for safe local appends.

### 3. Priority Thread Lane

Triggered when the user opens or resumes a partially loaded thread:

1. Mark the thread as high priority in `history_sync_thread_state`.
2. Fetch the complete event set for that thread and its project dependencies.
3. Import and incrementally project it ahead of normal backfill.
4. Only allow resume/send once the thread is fully loaded and remote head has been checked.

### 4. Backfill Lane

Continues in the background:

1. Page older remote threads after the latest bootstrap window.
2. Import/project in small batches.
3. Yield between batches so server/WebSocket work continues normally.
4. Persist cursor after every successful page.

Backfill must be resumable after crash/restart.

### 5. Append Lane

Handles local events after fast-forward:

1. Before pushing local events, check remote max sequence.
2. If remote has advanced, import the remote delta first.
3. If the local thread has no divergent remote changes, append local events.
4. If same-thread divergence is detected, create a conflict record and produce a forked local thread when safe.
5. Mark pushed event receipts and advance sync state.

Autosave should use this lane and should never push while the client is known to be behind.

## Conflict Policy

Expected case:

- One client writes a given thread at a time.
- Other clients fast-forward before resuming.

Unexpected same-thread divergence:

- Do not silently interleave turns.
- Detect remote events for the same thread after the local base sequence.
- If local pending events are independent enough to preserve, rewrite them into a forked thread with a clear title suffix.
- Record the conflict in `history_sync_conflicts`.
- Surface a clear status/toast so the user understands why a fork appeared.

## Project Mapping Policy

Mapping is a required gate before importing threads for a remote project.

Rules:

- Suggestions are allowed for exact path, basename, or repository identity.
- Suggestions are never auto-persisted.
- User confirmation writes durable mapping rows.
- Mapping to a folder should not require an existing local projection row.
- During import, the confirmed mapping controls how remote `project.created`, `project.meta-updated`, and `thread.created.projectId` are rewritten.
- The mapping wizard should group by remote project and show affected latest thread count.

This should prevent repeated prompts after the user already chose the correct Windows/macOS folder.

## UI Behavior

- Settings should show sync phases:
  - `Checking remote`
  - `Needs project mapping`
  - `Loading recent threads`
  - `Ready, loading older threads`
  - `Syncing opened thread`
  - `Appending local changes`
  - `Conflict needs review`
- Sidebar should render loaded thread shells immediately.
- Partially loaded threads should have a subtle loading state.
- Opening a partially loaded thread should prioritize that thread's import.
- Composer should be disabled for that thread until the thread is fully loaded and remote head validation passes.
- App-wide usage should remain available while backfill runs.

## Implementation Stages

### Stage 1: Schema and Remote Indexes

- Add MySQL migrations for project/thread/client/conflict sync tables.
- Build index upsert logic from event batches.
- Update remote push to write canonical events and indexes transactionally.
- Add tests for index rows from project/thread lifecycle events.

### Stage 2: Durable Mapping

- Stop auto-persisting exact-path mappings.
- Allow confirmed mappings that point to a local workspace root before a projection project exists.
- Make mapping validity independent from current projection rows unless the user explicitly remaps.
- Add migration/backfill for existing mappings.
- Add tests for Windows/macOS path remapping and repeated mapping prompts.

### Stage 3: Latest-First Read API

- Add remote queries:
  - read latest thread shells by page
  - read thread event batches by thread ids
  - read project dependency events for selected remote projects
  - read remote max sequence cheaply
- Add local repository methods for per-thread sync state.
- Add planner tests for latest-first paging and cursor persistence.

### Stage 4: Incremental Import and Projection

- Add batch import that does not clear local history.
- Add or expose incremental projection for imported event batches.
- Publish WebSocket/domain updates after each imported page.
- Keep full projection reload only for recovery or repair paths.

### Stage 5: Sync Lanes

- Refactor `syncRunner` into explicit lanes:
  - preflight
  - latest bootstrap
  - priority thread
  - backfill
  - append
- Make lanes cancellable/resumable and persist progress after each page.
- Keep manual `Sync now` as a coordinator that starts or resumes these lanes.

### Stage 6: Conflict Handling

- Track per-thread remote base before local append.
- Detect same-thread divergence.
- Implement safe fork creation for local pending events.
- Persist and surface conflict records.

### Stage 7: UI Integration

- Extend history sync status contract.
- Show partial loading and background backfill progress.
- Trigger priority thread sync when opening a partial thread.
- Disable composer only for the loading/conflicted thread, not the whole app.

### Stage 8: Verification and Migration Path

- Add package-local tests for planner, mapping, remote store, and sync runner behavior.
- Add migration/rebuild command for recreating remote MySQL sync tables from local history.
- Verify with:
  - `bun fmt`
  - `bun lint`
  - `bun typecheck`
  - focused package-local `bun run test`
  - full `bun run test` before final merge

## Open Technical Decisions

- Whether to maintain `history_sync_thread_events` or derive thread event sets from `orchestration_events` plus indexes.
- Whether local sequence numbers should remain identical to remote sequence numbers for imported events, or whether imported remote events need a remote/local sequence mapping for future multi-writer robustness.
- Whether project identity suggestions should use Git remote/root fingerprints in addition to path basename.
- How much recent history qualifies as the bootstrap window: fixed thread count, fixed time window, or both.
