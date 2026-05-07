# History Sync Cleanup Audit

History sync used to be implemented as one large service in
`apps/server/src/historySync.ts`. The cleanup has split behavior into dedicated
modules for planning, remote/local persistence, mappings, backup/restore,
status, lifecycle, configuration, sync execution, and service composition.
`historySync.ts` remains as a small compatibility facade for transitional
imports, while server internals import from the modules that own behavior. This
audit preserves the cleanup state for future slices: preserve behavior first,
extract testable boundaries, then harden risky paths.

## Lifecycle Map

1. Settings and secrets
   - `packages/contracts/src/settings.ts` stores `historySync.enabled`,
     `intervalMs`, `shutdownFlushTimeoutMs`, `statusIndicatorEnabled`, and a
     redacted `connectionSummary`.
   - The MySQL connection string is stored separately in
     `ServerSecretStore` under `history-sync-mysql-connection-string`.
   - `server.getHistorySyncConfig`, `server.updateHistorySyncConfig`, and
     `server.testHistorySyncConnection` are defined in
     `packages/contracts/src/rpc.ts` and served from `apps/server/src/ws.ts`.

2. Local sync state
   - Migration `032_HistorySyncState` adds the singleton
     `history_sync_state` row with first-sync completion, last remote sequence,
     and last success timestamp.
   - Migration `033_HistorySyncProjectMappings` adds `client_id` and persisted
     remote-to-local project mappings.
   - Migration `034_HistorySyncPushedEvents` adds local receipts for events
     already pushed to remote.

3. Service startup and status streaming
   - `HistorySyncServiceLive.start` waits 15 seconds, publishes configured
     startup status, and runs a full sync only when enabled, configured, and
     initial sync is complete.
   - Status is published through both an Effect `PubSub` and module-level
     globals used by `readHistorySyncStatus` and `subscribeHistorySyncStatus`.
   - `server.getConfig` snapshots include current history sync status, and
     `subscribeServerConfig` streams `historySyncStatus` updates.

4. First sync
   - Initial sync is explicit. When configured but not initialized, status is
     `needs-initial-sync`.
   - The first initial sync creates `history-sync-pre-sync.sqlite`.
   - If local has events and remote is empty, local events are pushed to MySQL.
   - If remote has events, remote history is imported locally and local client
     events are merged back using rescue IDs when thread IDs collide.

5. Project mapping
   - Remote project candidates are derived from remote orchestration events.
   - Exact workspace-root matches are auto-persisted. Unique basename matches
     are suggestions but remain unresolved.
   - Unresolved mappings put sync into `needs-project-mapping`.
   - Applying mappings validates a `syncId` of `client_id:remoteMaxSequence`,
     persists map/skip actions, then resumes initial sync or full sync.

6. Full sync
   - Completed syncs seed pushed-event receipts when upgrading from older local
     state.
   - Remote-behind-local is repaired by pushing local events after the remote
     max sequence.
   - Empty or unprojected local state can be replaced from remote.
   - Remote deltas are imported, projections are reloaded, receipts/state are
     advanced, and then pushable local events are pushed back.

7. Autosave
   - Domain events schedule autosave after completed turns, proposed plans,
     pending user input, or inactive terminal session states.
   - Autosave refuses to push when remote has unknown newer events and moves to
     `error` until manual sync clears it.
   - Candidate local events are limited by the triggering event sequence and by
     contiguous thread eligibility. Events after an ineligible thread are
     deferred.

8. Restore and projection reload
   - Restore attaches the backup SQLite database, truncates local history,
     projection, checkpoint, mapping, and state tables, copies tables from the
     backup, detaches the database, reloads projections, and republishes status.
   - Shell and thread WebSocket streams reload snapshots whenever history sync
     transitions to `idle`.

## Feature-Purpose Inventory

| Capability                                    | Label           | Purpose / note                                                                                                  |
| --------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------- |
| MySQL connection config and secret storage    | Keep            | Required for user-controlled remote history storage. Keep password secret-only.                                 |
| Explicit first sync                           | Keep            | Important safety gate before destructive local import.                                                          |
| Pre-sync SQLite backup                        | Keep, harden    | Required rollback path for first sync. Needs schema/table compatibility checks.                                 |
| Push local to empty remote on first sync      | Keep            | Best path for single-device setup.                                                                              |
| Merge local client events after remote import | Keep, split     | Preserves local work during first sync. Move to pure planner tests before refactor.                             |
| Project mapping wizard                        | Keep, simplify  | Required when workspace roots differ between machines. Split planner from persistence.                          |
| Exact-path auto mapping                       | Keep            | Low-risk convenience. Test stale/changed local project behavior.                                                |
| Basename suggestion                           | Keep cautiously | Useful but under-justified for reliability; never auto-apply.                                                   |
| `map-folder.createIfMissing` field            | Removed         | Contract no longer exposes folder creation because server only records a generated project ID.                  |
| `repo-identity` suggestion reason             | Removed         | Contract no longer exposes this suggestion because server never produced it.                                    |
| Local pushed-event receipts                   | Keep            | Core to avoiding duplicate pushes after imports and upgrades.                                                   |
| Remote-behind-local repair                    | Keep, harden    | Important for remote reset/recovery; should be planned and tested separately.                                   |
| Replace empty/unprojected local from remote   | Keep, harden    | Useful restart/recovery path, but destructive and projection-count based.                                       |
| Autosave                                      | Keep, split     | Central IDE reliability workflow; should remain conservative under conflicts.                                   |
| Retry autosave connection failures            | Keep            | Good reliability behavior for transient network outages. Consider extending to manual sync only if UX wants it. |
| Module-level latest status/control globals    | Simplify        | Works for current RPC wiring, but obscures lifecycle readiness and test isolation.                              |
| Snapshot reload on `idle` status              | Keep, harden    | Required for UI to see imported/restored history; should report reload failure distinctly.                      |

## Future Boundaries

- `historySync/service.ts`: Effect service definition and dependency
  composition.
- `historySync/statusBus.ts`: status state, PubSub, global bridge for existing
  RPC/config streams.
- `historySync/remoteStore.ts`: MySQL schema, connection validation, reads,
  max sequence, batched writes.
- `historySync/localRepository.ts`: SQLite reads/writes for events, receipts,
  sync state, projection counts, import transactions.
- `historySync/planner.ts`: pure functions for first-sync merge, delta
  selection, autosave eligibility, receipt seeding, mapping suggestions, and
  remote repair decisions.
- `historySync/backup.ts`: backup creation, backup summary, restore table copy,
  compatibility validation.
- `historySync/projectMappings.ts`: mapping persistence, sync IDs, suggestions,
  plan construction, exact-path auto-persist, and action application.
- `historySync/config.ts`: settings, secret-backed MySQL connection
  configuration, config snapshots, connection testing, and configured startup
  status decisions.
- `historySync/syncRunner.ts`: first/full/autosave sync algorithm execution,
  import coordination, and autosave retry handling.
- `historySync/projectMappingController.ts`: mapping RPC orchestration and sync
  continuation decisions.
- `historySync/restoreController.ts`: backup restore RPC orchestration and
  post-restore status publication.

Keep `apps/server/src/historySync.ts` as a compatibility facade for transitional
imports. New server-internal code should import from the direct owner modules.

## Cleanup Progress

- Completed: `historySync/planner.ts` now owns pure planning helpers for first
  sync merge/rescue, event rewrite/normalization, delta selection, receipt
  planning, autosave eligibility/selection, remote repair predicates, project
  candidate collection, active thread counting, and local replacement
  predicates.
- Completed: `historySync/remoteStore.ts` now owns MySQL schema setup,
  connection validation/summary/string building, pooled remote access, remote
  event reads, remote max-sequence reads, batched `INSERT IGNORE` writes, and
  retryable MySQL error classification.
- Completed: `historySync/localRepository.ts` now owns core SQLite event,
  receipt, state/client ID, projection-count, autosave thread-row, and
  import/replace/delta repository operations.
- Completed: `historySync/projectMappings.ts` now owns mapping
  persistence, sync IDs, exact-path/basename suggestions, mapping plan creation,
  exact-path auto-persist, and map/skip/map-folder action application.
- Completed: `historySync/backup.ts` now owns backup path handling, backup
  summary reads, pre-sync backup creation, restore table copy, attach/detach
  handling, and restore error normalization.
- Completed: `historySync/statusBus.ts` now owns latest status state, status
  logging, subscriber fanout, public status reads/subscriptions, and the service
  publish bridge.
- Completed: `historySync/lifecycle.ts` now owns run locking, stopped-state
  handling, startup scheduling, autosave debouncing, shutdown flush, and status
  stream exposure.
- Completed: `historySync/projectionReload.ts` now owns projection reload calls,
  projection progress fanout, and reload failure normalization.
- Completed: backup restore schema preflight now validates attached backup table
  compatibility before destructive restore deletes run.
- Completed: mapping contract drift cleanup removed unused
  `map-folder.createIfMissing` and `repo-identity` contract surface.
- Completed: destructive recovery guardrails now provide structured local
  replacement decisions and table-list alignment checks.
- Completed: `historySync/facade.ts` now owns module-level service control
  registration, disabled config fallback before readiness, and not-ready
  dispatch for mutating/manual calls.
- Completed: `historySync/config.ts` now owns settings, secret-backed MySQL
  config, config snapshots, connection testing, and configured startup status
  decisions.
- Completed: `historySync/syncRunner.ts` now owns first/full/autosave sync
  algorithm execution, import coordination, and autosave retry handling.
- Completed: `historySync/projectMappingController.ts` now owns mapping RPC
  orchestration and sync continuation decisions.
- Completed: `historySync/restoreController.ts` now owns backup restore RPC
  orchestration and post-restore status publication.
- Completed: `historySync/service.ts` now owns Effect service composition and
  dependency wiring; `historySync.ts` is now the compatibility export facade.
- Completed: facade consumer migration moved internal server imports and tests
  to the modules that own the referenced behavior.
- Completed: public facade freeze and audit backlog reset kept
  `historySync.ts` as an explicit compatibility facade and moves the audit from
  extraction tracking to hardening tracking.
- Completed: first-sync recovery phase tracking added durable phase metadata so
  interrupted initial syncs are auditable before automatic resume is considered.
- Completed: first-sync recovery visibility surfaced durable phase metadata in
  settings without adding automatic resume.
- Active slice: local commit atomicity is making receipt and sync-state writes a
  single SQLite commit after successful remote pushes/imports.
- Remaining after the active slice: future work should focus on behavior
  hardening, not further mechanical extraction, unless a new owner boundary
  becomes clearly useful.

## Reliability Risks

- Interrupted first sync can leave remote merge events pushed while local import
  or state write fails. Add explicit planner/run-step tests and consider a
  resumable phase marker.
- Import transactions protect SQLite writes, but remote pushes are not
  transactional with local state writes. Receipts/state must be idempotent and
  recomputable.
- Autosave conflict handling stops further autosave on unknown remote events.
  That is conservative, but the status should make manual sync recovery obvious.
- Failed or interrupted syncs now run lifecycle stale-sync recovery so a stuck
  `syncing` status is republished as `error` instead of lingering forever.
- Initial sync phase tracking is durable local state, separate from lifecycle
  stale-status recovery, and should be used for future resumable first-sync work.
- Initial sync recovery visibility is informational only; automatic resume
  remains future work and needs a separate recovery design.
- Receipt and sync-state writes should commit atomically locally after remote
  work succeeds; remote MySQL pushes are still outside the SQLite transaction.
- Project mappings can go stale if local projects are deleted or remote changes
  after plan creation. `syncId` covers remote sequence, not local project drift.
- Backup restore assumes the backup schema has all copied tables. A migration
  after backup creation can make restore fail halfway unless compatibility is
  validated before deleting local tables.
- Projection reload failure after import/restore can leave event storage updated
  but UI projections stale. Treat reload failure as a first-class sync failure.
- Startup uses module-level readiness globals. RPCs before service init fail
  with "not ready" except config, which returns a disabled fallback; this
  mismatch should be made explicit.
- `clearLocalHistory` and restore table lists must stay aligned with future
  projection/checkpoint tables, or old data can leak into restored/imported
  projections.

## Test Matrix

Prioritize package-local Vitest tests around fake repositories/stores after the
split. Avoid brittle end-to-end MySQL/browser tests for core correctness.

- Pure planner table tests:
  - first-sync empty remote push, remote import, local merge, ID collision
    rescue, project rewrite, skipped project filtering.
  - autosave candidate selection, contiguous gating, terminal/session states,
    remote-covered receipt seeding, unknown remote conflict.
  - remote-behind-local repair and last synced sequence advancement.
  - project mapping suggestions and stale `syncId`.
- Fake `RemoteHistoryStore` tests:
  - ensure schema before access, batched insert ordering, duplicate event
    idempotency, max-sequence reads, retryable connection error classification.
- Fake `LocalHistoryRepository` tests:
  - receipt seeding, import replace vs delta, state/client ID preservation,
    mapping persistence, projection-count recovery decisions.
- Backup/restore tests:
  - backup summary, missing backup, schema/table mismatch preflight, successful
    restore, reload failure status.
- Service lifecycle tests:
  - not configured, configured but initial sync missing, startup auto full sync,
    running lock, pending autosave reschedule, stopped autosave after error,
    manual sync clears stopped.
- Contract/UI logic tests:
  - keep status decoding for every state stable.
  - topbar/settings status text for retrying, mapping, sync progress, and error.

## Remaining Hardening Backlog

1. Make interrupted first sync resumable or explicitly recoverable.
   - Remote merge events can be pushed before local import/state writes finish,
     so use the durable phase marker to design recovery before changing
     behavior.

2. Strengthen remote/local commit idempotency.
   - Remote pushes and local state/receipt writes are not transactional together;
     keep receipt seeding and duplicate-push prevention recomputable.

3. Validate local project drift before applying saved mappings.
   - `syncId` protects remote sequence drift, but deleted or changed local
     projects can still make persisted mappings stale.

4. Improve autosave conflict UX without weakening safety.
   - Unknown newer remote events should continue blocking autosave, but the
     status and manual recovery path can be made clearer.

5. Keep destructive table operations aligned with schema growth.
   - `clearLocalHistory`, restore table copies, projection tables, checkpoint
     tables, and future history-derived tables need a single review point before
     migrations add new local history state.
