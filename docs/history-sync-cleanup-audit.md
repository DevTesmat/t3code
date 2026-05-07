# History Sync Cleanup Audit

History sync is currently implemented as one large service in
`apps/server/src/historySync.ts`. It owns settings/config, global RPC facades,
status streaming, MySQL access, SQLite import/export, merge planning, autosave
gating, project mapping, backup restore, and projection reload. This audit is a
non-mutating cleanup plan: preserve behavior first, extract testable boundaries,
then harden the risky paths.

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

| Capability                                    | Label               | Purpose / note                                                                                                  |
| --------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------- |
| MySQL connection config and secret storage    | Keep                | Required for user-controlled remote history storage. Keep password secret-only.                                 |
| Explicit first sync                           | Keep                | Important safety gate before destructive local import.                                                          |
| Pre-sync SQLite backup                        | Keep, harden        | Required rollback path for first sync. Needs schema/table compatibility checks.                                 |
| Push local to empty remote on first sync      | Keep                | Best path for single-device setup.                                                                              |
| Merge local client events after remote import | Keep, split         | Preserves local work during first sync. Move to pure planner tests before refactor.                             |
| Project mapping wizard                        | Keep, simplify      | Required when workspace roots differ between machines. Split planner from persistence.                          |
| Exact-path auto mapping                       | Keep                | Low-risk convenience. Test stale/changed local project behavior.                                                |
| Basename suggestion                           | Keep cautiously     | Useful but under-justified for reliability; never auto-apply.                                                   |
| `map-folder.createIfMissing` field            | Remove or implement | Contract exposes it but server only records a generated project ID; no folder/project creation occurs.          |
| `repo-identity` suggestion reason             | Remove or implement | Contract allows it but server never produces it.                                                                |
| Local pushed-event receipts                   | Keep                | Core to avoiding duplicate pushes after imports and upgrades.                                                   |
| Remote-behind-local repair                    | Keep, harden        | Important for remote reset/recovery; should be planned and tested separately.                                   |
| Replace empty/unprojected local from remote   | Keep, harden        | Useful restart/recovery path, but destructive and projection-count based.                                       |
| Autosave                                      | Keep, split         | Central IDE reliability workflow; should remain conservative under conflicts.                                   |
| Retry autosave connection failures            | Keep                | Good reliability behavior for transient network outages. Consider extending to manual sync only if UX wants it. |
| Module-level latest status/control globals    | Simplify            | Works for current RPC wiring, but obscures lifecycle readiness and test isolation.                              |
| Snapshot reload on `idle` status              | Keep, harden        | Required for UI to see imported/restored history; should report reload failure distinctly.                      |

## Future Boundaries

- `historySync/service.ts`: Effect service lifecycle, startup delay, shutdown
  finalizer, run lock, stopped flag, autosave scheduling.
- `historySync/statusBus.ts`: status state, PubSub, global bridge for existing
  RPC/config streams.
- `historySync/remoteStore.ts`: MySQL schema, connection validation, reads,
  max sequence, batched writes.
- `historySync/localRepository.ts`: SQLite reads/writes for events, receipts,
  mappings, sync state, projection counts, import transactions.
- `historySync/planner.ts`: pure functions for first-sync merge, delta
  selection, autosave eligibility, receipt seeding, mapping suggestions, and
  remote repair decisions.
- `historySync/backup.ts`: backup creation, backup summary, restore table copy,
  compatibility validation.
- `historySync/projectMappings.ts`: mapping plan/apply orchestration around the
  pure planner and local repository.

Keep `apps/server/src/historySync.ts` initially as the compatibility facade so
RPC imports and tests can move gradually.

## Reliability Risks

- Interrupted first sync can leave remote merge events pushed while local import
  or state write fails. Add explicit planner/run-step tests and consider a
  resumable phase marker.
- Import transactions protect SQLite writes, but remote pushes are not
  transactional with local state writes. Receipts/state must be idempotent and
  recomputable.
- Autosave conflict handling stops further autosave on unknown remote events.
  That is conservative, but the status should make manual sync recovery obvious.
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
  - remove or implement unused `createIfMissing` and `repo-identity`.
  - status decoding for every state remains stable.
  - topbar/settings status text for retrying, mapping, sync progress, and error.

## Ordered Cleanup Backlog

1. Extract pure planner functions without changing behavior.
   - Files: add `apps/server/src/historySync/planner.ts`, keep re-exports from
     `historySync.ts` temporarily.
   - Tests: move/expand existing first-sync, autosave, mapping, receipt, and
     remote-repair tests into table-driven planner tests.
   - Must not change event ordering, sequence assignment, project rewrite, or
     autosave gating.

2. Introduce remote/local interfaces behind the existing service.
   - Files: `remoteStore.ts`, `localRepository.ts`.
   - Tests: use fake stores for full-sync and autosave orchestration cases.
   - Must preserve MySQL schema and SQLite migration compatibility.

3. Split status bus and lifecycle orchestration.
   - Files: `statusBus.ts`, `service.ts`, compatibility facade in
     `historySync.ts`.
   - Tests: startup statuses, global subscriber behavior, RPC not-ready behavior,
     running lock, pending autosave.
   - Must preserve `subscribeServerConfig` and orchestration snapshot reload
     semantics.

4. Harden backup/restore.
   - Files: `backup.ts`.
   - Tests: missing backup, incompatible backup schema, restore reload failure.
   - Behavior change to consider: validate attached backup tables before any
     local delete.

5. Clean contract drift.
   - Files: `packages/contracts/src/server.ts`, web mapping UI if needed.
   - Decide whether to remove or implement `createIfMissing` and
     `repo-identity`.
   - Must coordinate schema changes through server/web tests.

6. Make projection reload failure explicit.
   - Files: local repository/import path plus `apps/server/src/ws.ts` snapshot
     reload behavior if needed.
   - Tests: import succeeds but reload fails, restore succeeds but reload fails,
     status/result reported to user.

7. Revisit destructive recovery paths.
   - Files: planner and local repository.
   - Tests: replace-empty-local predicates and table coverage.
   - Behavior to preserve until explicitly changed: projection-count based local
     replacement remains available for recovery.
