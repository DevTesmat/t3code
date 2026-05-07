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

| Capability                                    | Label          | Purpose / note                                                                                                                |
| --------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| MySQL connection config and secret storage    | Keep           | Required for user-controlled remote history storage. Keep password secret-only.                                               |
| Explicit first sync                           | Keep           | Important safety gate before destructive local import.                                                                        |
| Pre-sync SQLite backup                        | Keep, hardened | Required rollback path for first sync. Schema/table compatibility and missing-backup guidance are covered.                    |
| Push local to empty remote on first sync      | Keep           | Best path for single-device setup.                                                                                            |
| Merge local client events after remote import | Keep, split    | Preserves local work during first sync; merge/recovery decisions are planner-owned and runner-executed.                       |
| Project mapping wizard                        | Keep, split    | Required when workspace roots differ between machines; persistence, RPC orchestration, and continuation policy are separated. |
| Exact-path auto mapping                       | Keep, covered  | Low-risk convenience with stale/changed local project behavior covered.                                                       |
| Basename suggestion                           | Keep, explicit | Useful suggestion only; never auto-applied and covered as unresolved planner output.                                          |
| `map-folder.createIfMissing` field            | Removed        | Contract no longer exposes folder creation because server only records a generated project ID.                                |
| `repo-identity` suggestion reason             | Removed        | Contract no longer exposes this suggestion because server never produced it.                                                  |
| Local pushed-event receipts                   | Keep           | Core to avoiding duplicate pushes after imports and upgrades.                                                                 |
| Remote-behind-local repair                    | Keep, hardened | Important for remote reset/recovery; now shares the receipt/state commit planner.                                             |
| Replace empty/unprojected local from remote   | Keep, hardened | Useful restart/recovery path; destructive decisions are explicit planner output.                                              |
| Autosave                                      | Keep, split    | Central IDE reliability workflow; conflict, receipt, and push decisions are planner-owned and runner-executed.                |
| Retry autosave connection failures            | Keep, explicit | Autosave-only retry is intentional; manual/full/initial retry remains out of scope unless UX requests it.                     |
| Module-level latest status/control globals    | Keep, explicit | Compatibility bridge; config fallback and not-ready manual dispatch are documented by facade tests.                           |
| Snapshot reload on `idle` status              | Keep, covered  | Required for UI to see imported/restored history; projection reload failures are normalized and tested.                       |

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
- Completed: local commit atomicity now routes paired receipt and sync-state
  writes through a single local commit path after successful remote
  pushes/imports, with rollback-style receipt restoration on state-write
  failure.
- Completed: interrupted first-sync recovery now consults durable phase metadata
  before retrying, skips already-covered remote writes when event IDs prove the
  previous push succeeded, resumes safe local import/state-write steps, and
  keeps the recovery marker visible when remote drift or collision rescue makes
  automatic resume unsafe.
- Completed: remote/local commit idempotency now uses pure planner helpers for
  remote event-ID coverage and post-push/import local commit decisions. Autosave
  receipt repair, remote-behind-local repair, post-import push, and normal
  pending-local push now share the same receipt/state commit plan so receipts
  can be recomputed while the synced cursor only advances through proven
  contiguous coverage.
- Completed: local project drift validation now filters saved mappings against
  current local project projections before planning or sync rewrites, keeps
  skipped mappings valid, and folds local project identity into the opaque
  mapping `syncId` so apply fails through the existing stale-plan path when the
  local project list changes after the wizard loads.
- Completed: autosave remote conflict UX now keeps the conservative stopped
  autosave behavior but publishes stable recovery copy, records structured
  conflict metadata in logs, and renders the known conflict as a warning with
  explicit Sync now guidance in topbar/settings UI while generic errors remain
  destructive.
- Completed: destructive history-sync table operations now use a single
  manifest for local-history replacement, restore-only mapping/state tables, and
  explicitly excluded non-history tables. Local import clearing and backup
  restore delete/copy operations iterate the manifest, and migration-backed
  guard tests fail when future history-derived tables are not classified.
- Completed: first-sync recovery edge coverage now covers backup-phase restart,
  mapped/skipped project rewrites during recovery, missing backup restore/config
  visibility, and collision-rescue blocked recovery.
- Completed: final audited split work moved first-sync orchestration decisions
  and autosave conflict/receipt/push decisions behind named planner helpers
  while preserving runner-owned side effects.
- Completed: final project-mapping simplification made apply continuation a
  named controller policy and locked basename suggestions as unresolved,
  non-auto-persisted planner output.
- Completed: retry scope is now explicit and tested as autosave-only for
  retryable connection failures.
- Next due item: no named remaining hardening backlog item.
- Remaining work should focus on behavior hardening, not further mechanical
  extraction, unless a new owner boundary becomes clearly useful.

## Agent Handoff Expectations

- After completing any item in this file, clearly tell the user what was
  completed and what item is due next.
- Do not say the history sync cleanup/hardening work is finished until every
  task in this file's remaining backlog has been completed, verified, and
  reflected in this audit.
- If a task is intentionally deferred or blocked, state the blocker and name the
  next actionable task instead of implying the backlog is complete.

## Residual Review

- Accepted invariant: remote MySQL pushes are not transactional with local
  SQLite writes. This is expected across two stores; receipt/state commits are
  idempotent and recomputable through the shared planner path.
- Covered: autosave conflict handling intentionally stops autosave on unknown
  newer remote events, exposes Sync now recovery copy, and keeps conflict,
  receipt, and push decisions in pure planner helpers.
- Accepted retry scope: only autosave retries retryable connection failures.
  Manual/full/initial syncs still surface errors immediately so semantic
  conflicts and explicit user actions are not retried unexpectedly.
- Covered: failed or interrupted syncs run lifecycle stale-sync recovery so a
  stuck `syncing` status is republished as `error`.
- Accepted conservative branch: initial sync recovery automatically resumes only
  provable phase retries. Collision rescue, partial merge coverage, and
  unexpected remote drift stay manual-review paths and have explicit
  runner/planner coverage.
- Covered: project mappings are validated against current local project rows.
  Drift between wizard load and apply intentionally fails through the existing
  stale-plan path.
- Covered: basename mapping suggestions remain suggestions only. Exact-path
  matches can auto-persist, but basename matches stay unresolved until the user
  explicitly maps or skips them.
- Covered: backup restore validates manifest table compatibility before
  destructive deletes; missing backup guidance is tested at backup, restore, and
  config-controller boundaries.
- Covered: projection reload failure after import/restore is normalized as a
  first-class `HistorySyncConfigError` and tested.
- Covered compatibility behavior: module-level facade globals keep a disabled
  config fallback before service registration while manual operations fail with
  "not ready"; facade tests document the contract.
- Covered guardrail: `clearLocalHistory` and restore table lists share
  `tableManifest.ts`; migration-backed manifest tests require future
  history-derived tables to be classified or explicitly excluded.

## Test Matrix

Prioritize package-local Vitest tests around fake repositories/stores after the
split. Avoid brittle end-to-end MySQL/browser tests for core correctness.

- Pure planner table tests:
  - first-sync empty remote push, remote import, local merge, recovery phase
    decisions, ID collision rescue, project rewrite, skipped project filtering.
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

No named remaining hardening backlog item. All residual audit entries are
classified above as covered behavior or accepted invariants rather than due
work.
