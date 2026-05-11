# Scalability and Reliability Hardening Plan

## Status

This file is the source of truth for the scalability work from the May 2026 audit. Keep it updated whenever scope, ordering, implementation details, or completion status changes.

Current state: Stage 3 in progress. Replay RPC pagination and shell-stream gap recovery are implemented and verified in dev logs. Provider ingestion now exposes enqueue/backpressure accounting through worker health and operational health; explicit overflow recovery policy remains open. Thread subscription snapshots now bound initial message hydration and expose page metadata, while older message page loading remains open.

## Goal

Make T3 Code behave correctly and smoothly with very large histories: many projects, many threads, long-running threads, heavy event streams, reconnects, restarts, and history sync backfills.

Correctness comes first. Performance work must not introduce missed events, stale projections, silent data loss, or ambiguous sync state.

## Non-Negotiable Invariants

- Reconnect recovery must be complete or explicitly incomplete. The client must never silently believe it caught up when events were skipped.
- Provider/runtime events must not be silently dropped. If backpressure is hit, the system must count it, surface health, and choose an explicit failure/recovery path.
- Thread bodies must not be required for global shell/sidebar operation.
- Opening a huge thread must be bounded or paged.
- History sync must avoid whole-history materialization in normal startup, latest-first, priority-thread, append, and mapping flows.
- UI work should scale with visible or active data where possible, not total historical data.

## Confirmed Risks

### Critical: Replay Truncation

`orchestration.replayEvents` collects `orchestrationEngine.readEvents(...)` without a requested limit. The event store default is 1,000 events, and the protocol has no `nextCursor` or `hasMore`. A client more than 1,000 events behind can silently miss events.

Relevant files:

- `apps/server/src/ws.ts`
- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`
- `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`
- `packages/contracts/src/orchestration.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/environments/runtime/service.ts`

### High: Full Server Read Model

The server hot read model is a full `OrchestrationReadModel`, including thread messages, activities, plans, and checkpoints. This makes historical content baseline server heap.

Relevant files:

- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- `apps/server/src/orchestration/projector.ts`
- `apps/server/src/orchestration/decider.ts`

### High: Unbounded Thread Detail Snapshot

Thread subscription snapshots previously hydrated and sent the entire thread detail. Initial subscription snapshots now send only the latest bounded message page with protocol-visible page metadata. Activities, proposed plans, checkpoints, and older-message page retrieval still need dedicated pagination before this stage is complete.

Relevant files:

- `apps/server/src/ws.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- `packages/contracts/src/orchestration.ts`
- `apps/web/src/store.ts`
- `apps/web/src/components/ChatView.tsx`

### High: O(Thread History) Shell Summary Refresh

Common projection events refresh shell summary state by loading all messages, plans, activities, and approvals for the thread. This can become quadratic for long threads.

Relevant files:

- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- `apps/server/src/persistence/Layers/ProjectionThreadMessages.ts`
- `apps/server/src/persistence/Layers/ProjectionThreadActivities.ts`
- `apps/server/src/persistence/Layers/ProjectionThreadProposedPlans.ts`
- `apps/server/src/persistence/Layers/ProjectionPendingApprovals.ts`

### High: History Sync Whole-Log Paths

Several history sync flows still materialize entire local or remote event logs. Latest-first bootstrap also rereads local history per remote page.

Relevant files:

- `.plan/history-sync-latest-first-mysql.md`
- `apps/server/src/historySync/syncRunner.ts`
- `apps/server/src/historySync/localRepository.ts`
- `apps/server/src/historySync/remoteStore.ts`
- `apps/server/src/historySync/projectMappingController.ts`
- `apps/server/src/historySync/projectMappings.ts`

### High: Provider Ingestion Backpressure Is Not Observable

Provider runtime ingestion uses a bounded worker. Shared worker health now reports attempted, accepted, processed, failed, dropped, and coalesced counts, and provider ingestion logs rejected enqueue paths. The remaining gap is deciding whether a real overflow/rejection should fail the affected provider session or trigger provider/session recovery.

Relevant files:

- `packages/shared/src/DrainableWorker.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- `apps/server/src/operationalHealth.test.ts`

### Medium: Logger Writer Retention

Provider event logging keeps one writer per thread until logger shutdown. Many distinct threads can retain many writer scopes.

Relevant files:

- `apps/server/src/provider/Layers/EventNdjsonLogger.ts`

### Medium: Frontend Active Thread CPU Hot Paths

Activity and message updates repeatedly rebuild full derived arrays and indexes. Rendering is virtualized in the timeline, but derivation still scales with retained message/activity count.

Relevant files:

- `apps/web/src/store.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/session-logic.ts`
- `apps/web/src/components/chat/MessagesTimeline.tsx`
- `apps/web/src/components/chat/MessagesTimeline.logic.ts`

### Medium: Frontend Global List Hot Paths

Sidebar and command palette operate over all sidebar threads/projects. Thread row preview limits help DOM size, but grouping, sorting, filtering, and rendering project rows still scale globally.

Relevant files:

- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/Sidebar.logic.ts`
- `apps/web/src/components/CommandPalette.tsx`
- `apps/web/src/components/CommandPalette.logic.ts`
- `apps/web/src/components/CommandPaletteResults.tsx`

## Implementation Stages

### Stage 1: Lossless Replay Protocol

Status: in progress.

- [x] Replace array-only replay with a paged result:
  - `events`
  - `nextSequence`
  - `hasMore`
  - optional server-side `limit`
- [x] Update contracts and server implementation together.
- [x] Update current web replay callers to loop until `hasMore === false`.
- [x] Wire paged replay into live environment gap recovery.
- [x] Make incomplete live replay explicit in UI/runtime state if a page fails.
- [x] Add tests for replay pagination beyond a single response page.
- [ ] Add tests for interrupted live paged replay and retry behavior.

Progress notes:

- `orchestration.replayEvents` now returns `{ events, nextSequence, hasMore }`.
- The server fetches `limit + 1` events, returns only the requested page, and uses the extra event to compute `hasMore`.
- `ChatView` command-event replay now loops through all pages via `apps/web/src/orchestrationReplay.ts`.
- Environment shell subscriptions now detect sequence gaps and replay missing domain-event pages before applying the gapped shell event.
- Replay failures are surfaced to the saved environment runtime state as connection errors.
- Focused coverage exists for contract decoding, server WebSocket paging, and the web replay loop.

Expected outcome: reconnect recovery is complete, bounded per request, and protocol-visible.

### Stage 2: Provider Backpressure Accounting

- [x] Make `DrainableWorker` track attempted, accepted, rejected/dropped, processed, and failed counts.
- [x] Stop hardcoding `dropped: 0` in drainable worker health.
- [x] Make provider runtime ingestion handle `enqueue === false`.
- [ ] Decide the failure policy for queue overflow:
  - fail affected provider session, or
  - pause/recover by forcing a provider/session resync, if available.
- [x] Expose overflow/backpressure state through operational health.
- [x] Add tests for bounded queue backpressure accounting and surfaced health.

Progress notes:

- `WorkerHealthSnapshot` now includes `attempted` and `accepted` counters.
- `DrainableWorker` counts enqueue attempts before bounded queue admission, counts accepted work when it is actually queued, and counts rejected offers as dropped.
- Bounded queue behavior remains lossless backpressure by default; tests assert a blocked enqueue is visible as `attempted > accepted` without dropping work.
- `ProviderRuntimeIngestion` logs rejected enqueue attempts with source, event id/type, thread id, capacity, backlog, and counters.
- `OperationalHealth` passes the richer provider ingestion health snapshot through unchanged.
- `KeyedCoalescingWorker` reports attempted/accepted/coalesced counters for terminal history style workers.

Expected outcome: event pressure cannot cause invisible data loss.

### Stage 3: Thread Detail Pagination

- [ ] Split thread detail contract into shell plus paged resources:
  - [x] bounded initial message page metadata on thread subscription snapshots
  - [ ] explicit older-message page fetch API/UI
  - activities
  - proposed plans
  - checkpoints
  - command output/file diffs where needed
- [x] Add stable latest-message server query for subscription snapshots.
- [x] Make `subscribeThread` send bounded initial message detail.
- [ ] Keep live updates append/update based.
- [ ] Add UI loading states for older detail pages.
- [ ] Add tests for opening a thread with more than the initial page size.

Progress notes:

- `OrchestrationThreadDetailSnapshot` now optionally includes `pageInfo.messages` with `limit`, `included`, and `hasMoreBefore`.
- `ProjectionSnapshotQuery.getThreadDetailSnapshotById` returns the latest `THREAD_DETAIL_INITIAL_MESSAGE_LIMIT` messages for subscription snapshots, using `limit + 1` to detect older content.
- `ProjectionSnapshotQuery.getThreadDetailById` remains the full-detail internal query for existing server-side callers.
- `subscribeThread` initial and history-sync reload snapshots now use the bounded detail snapshot path.
- Focused coverage seeds more than the initial message limit and verifies the subscription snapshot contains only the latest page in stable chronological order.

Expected outcome: opening a huge thread is bounded, and older content loads on demand.

### Stage 4: Shell-Only Hot Read Model

- [ ] Define a shell read model for command decisions and global subscriptions.
- [ ] Move thread body access behind targeted query APIs.
- [ ] Audit `decider.ts`, provider ingestion, checkpointing, and project setup for thread-body assumptions.
- [ ] Keep only fields needed for command invariants, sidebar state, active sessions, and latest turn state in the hot model.
- [ ] Add regression tests for command decisions after removing full bodies from the hot model.

Expected outcome: total historical messages/activities are no longer baseline server heap.

### Stage 5: Incremental Shell Summary Projection

- [ ] Replace `refreshThreadShellSummary` full scans with incremental updates or targeted SQL aggregates.
- [ ] Maintain latest user message timestamp at message projection time.
- [ ] Maintain pending approval/user-input counters at activity/approval projection time.
- [ ] Maintain actionable proposed plan state at proposed-plan and turn-state projection time.
- [ ] Keep repair/rebuild paths for projection recovery.
- [ ] Add tests for summary correctness across message, plan, activity, approval, revert, and replay paths.

Expected outcome: common event projection is O(1) or bounded, not O(thread history).

### Stage 6: History Sync Paging and Indexing

Use `.plan/history-sync-latest-first-mysql.md` as the detailed sync architecture. This stage tracks the audit-driven cleanup that must align with that plan.

- [ ] Remove normal-path all-local-event materialization.
- [ ] Remove normal-path all-remote-event materialization.
- [ ] Fix latest-first bootstrap so it does not reread full local history per remote page.
- [ ] Replace remote fallback/index backfill paths that load all remote events.
- [ ] Make project mapping use indexed/project-level remote reads instead of full remote history.
- [ ] Revisit per-event pushed receipt growth and add retention or compact cursor strategy.
- [ ] Add tests with large synthetic histories for latest-first, priority-thread, append, and mapping flows.

Expected outcome: sync startup and backfill scale by page/thread, not total history.

### Stage 7: Frontend Active Thread Derivation

- [ ] Build a shared per-thread activity projection so ChatView does not sort/scan activities multiple times per event.
- [ ] Make message updates append-friendly in store and avoid rebuilding full `ids` and `byId` records for each streaming delta.
- [ ] Review timeline auto-scroll content key generation for work rows so it avoids large string construction on every update.
- [ ] Add performance-oriented tests or benchmarks for streaming assistant deltas and activity bursts.

Expected outcome: active chat CPU cost is bounded by changed/visible data where practical.

### Stage 8: Frontend Global List Scaling

- [ ] Virtualize project rows or add a project search/collapse strategy that avoids rendering all projects.
- [ ] Cap command palette thread results before render.
- [ ] Consider server/client paged thread search for command palette.
- [ ] Reduce sidebar regroup/sort work on single-thread shell updates.
- [ ] Add regression tests for large sidebar datasets and command palette filtering.

Expected outcome: many projects/threads do not make routine navigation or palette usage janky.

### Stage 9: Logger Writer Lifecycle

- [ ] Add idle cleanup or LRU limits for provider event logger thread writers.
- [ ] Ensure cleanup flushes pending batches.
- [ ] Add tests for many-thread writer churn.

Expected outcome: provider logging resource usage scales with active/recent threads, not all threads since process start.

## Suggested Order

1. Stage 1: Lossless replay protocol.
2. Stage 2: Provider backpressure accounting.
3. Stage 5: Incremental shell summary projection.
4. Stage 3: Thread detail pagination.
5. Stage 4: Shell-only hot read model.
6. Stage 6: History sync paging and indexing.
7. Stage 7: Frontend active thread derivation.
8. Stage 8: Frontend global list scaling.
9. Stage 9: Logger writer lifecycle.

Stages 3 and 4 are closely related. If implementation gets simpler by doing the shell-only read model first, update this file before changing the order.

## Validation Requirements

Each completed stage should include focused tests for the changed behavior plus the repository completion checks:

- `bun fmt`
- `bun lint`
- `bun typecheck`

Use `bun run test`, never `bun test`. For focused tests, run the package-local test script from the relevant package directory.

## Open Design Questions

- What maximum replay page size should the server allow by default?
- Should thread detail default to newest-first or oldest-first pages for old content?
- What is the correct provider-ingestion overflow policy for Codex app-server sessions?
- Should old message/activity projection rows be retained forever, compacted, or moved to archive tables?
- Should history sync receipts be represented by compact cursors/ranges instead of one row per event?
