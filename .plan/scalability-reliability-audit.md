# Scalability and Reliability Hardening Plan

## Status

This file is the source of truth for the scalability work from the May 2026 audit. Keep it updated whenever scope, ordering, implementation details, or completion status changes.

Current state: Stages 1, 2, 3, 4, and 5 are complete. Replay RPC pagination and shell-stream gap recovery are implemented, including retry coverage for interrupted live paged replay. Provider ingestion now exposes enqueue/backpressure accounting through worker health and operational health, and rejected must-deliver runtime events now best-effort fail the affected session instead of leaving projection continuity ambiguous. Thread subscription snapshots now bound initial message, activity, proposed-plan, checkpoint, and persisted file-diff hydration and expose page metadata for paged resources; older messages, activities, proposed plans, and checkpoints can be loaded through explicit bounded page APIs, with the active-thread UI loading them together when older history is requested. Older persisted file diffs are fetched on demand for visible file-change rows by tool-call id instead of unconditionally hydrating all diffs on thread open. Thread shell summary refresh now uses targeted SQL aggregates instead of hydrating all thread messages, proposed plans, activities, and approvals; latest user-message timestamps, pending approval/user-input counts, latest pending user-input timestamp, and actionable proposed-plan state are now maintained incrementally on normal projection events. The orchestration engine now retains compact command-decision state instead of the full historical thread read model; full read models remain available as on-demand projection snapshots for compatibility.

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

Thread subscription snapshots previously hydrated and sent the entire thread detail. Initial subscription snapshots now send only the latest bounded message, activity, proposed-plan, checkpoint, and persisted file-diff pages with protocol-visible page metadata for paged resources. Dedicated older-page retrieval now exists for messages, activities, proposed plans, and checkpoints; older persisted file diffs load on demand by tool-call id when a visible file-change row needs its patch preview.

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

Status: complete.

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
- [x] Add tests for interrupted live paged replay and retry behavior.

Progress notes:

- `orchestration.replayEvents` now returns `{ events, nextSequence, hasMore }`.
- The server fetches `limit + 1` events, returns only the requested page, and uses the extra event to compute `hasMore`.
- `ChatView` command-event replay now loops through all pages via `apps/web/src/orchestrationReplay.ts`.
- Environment shell subscriptions now detect sequence gaps and replay missing domain-event pages before applying the gapped shell event.
- Replay failures are surfaced to the saved environment runtime state as connection errors.
- Focused coverage exists for contract decoding, server WebSocket paging, and the web replay loop.
- Live shell gap replay now advances the local replay cursor after each applied page, so an interrupted multi-page replay retries from the last applied page rather than replaying from the original gap start.

Expected outcome: reconnect recovery is complete, bounded per request, and protocol-visible.

### Stage 2: Provider Backpressure Accounting

- [x] Make `DrainableWorker` track attempted, accepted, rejected/dropped, processed, and failed counts.
- [x] Stop hardcoding `dropped: 0` in drainable worker health.
- [x] Make provider runtime ingestion handle `enqueue === false`.
- [x] Decide the failure policy for queue overflow:
  - fail affected provider session for rejected must-deliver runtime events
  - keep rejected coalescible/droppable events observable through logs and health counters
- [x] Expose overflow/backpressure state through operational health.
- [x] Add tests for bounded queue backpressure accounting and surfaced health.

Progress notes:

- `WorkerHealthSnapshot` now includes `attempted` and `accepted` counters.
- `DrainableWorker` counts enqueue attempts before bounded queue admission, counts accepted work when it is actually queued, and counts rejected offers as dropped.
- Bounded queue behavior remains lossless backpressure by default; tests assert a blocked enqueue is visible as `attempted > accepted` without dropping work.
- `ProviderRuntimeIngestion` logs rejected enqueue attempts with source, event id/type, thread id, capacity, backlog, and counters.
- `OperationalHealth` passes the richer provider ingestion health snapshot through unchanged.
- `KeyedCoalescingWorker` reports attempted/accepted/coalesced counters for terminal history style workers.
- Provider runtime ingestion now treats a rejected must-deliver runtime event as a projection-continuity failure and best-effort marks the affected thread session `error`; rejected coalescible/droppable events remain logged/backpressure-health signals.

Expected outcome: event pressure cannot cause invisible data loss.

### Stage 3: Thread Detail Pagination

Status: complete.

- [x] Split thread detail contract into shell plus paged resources:
  - [x] bounded initial message page metadata on thread subscription snapshots
  - [x] explicit older-message page fetch API/UI
  - [x] bounded initial activity page metadata on thread subscription snapshots
  - [x] bounded initial proposed-plan page metadata on thread subscription snapshots
  - [x] bounded initial checkpoint page metadata on thread subscription snapshots
  - [x] explicit older activity page fetch API/UI
  - [x] explicit older proposed-plan page fetch API/UI
  - [x] explicit older checkpoint page fetch API/UI
  - [x] command output/file diffs where needed
- [x] Add stable latest-message server query for subscription snapshots.
- [x] Make `subscribeThread` send bounded initial message detail.
- [x] Keep live updates append/update based.
- [x] Add UI loading states for older detail pages.
- [x] Add tests for opening a thread with more than the initial page size.

Progress notes:

- `OrchestrationThreadDetailSnapshot` now optionally includes `pageInfo.messages` with `limit`, `included`, and `hasMoreBefore`.
- `ProjectionSnapshotQuery.getThreadDetailSnapshotById` returns the latest `THREAD_DETAIL_INITIAL_MESSAGE_LIMIT` messages for subscription snapshots, using `limit + 1` to detect older content.
- `ProjectionSnapshotQuery.getThreadDetailById` remains the full-detail internal query for existing server-side callers.
- `subscribeThread` initial and history-sync reload snapshots now use the bounded detail snapshot path.
- Focused coverage seeds more than the initial message limit and verifies the subscription snapshot contains only the latest page in stable chronological order.
- `orchestration.getThreadMessagesPage` fetches a bounded page before an already loaded message id, preserving stable chronological order and `hasMoreBefore` metadata.
- The web store records message page metadata, merges bounded reconnect snapshots without discarding already loaded older messages, and prepends older pages by id.
- `ChatView` auto-loads older pages when the user scrolls near the top and keeps a small top-of-thread loading action as a fallback.
- Subscription snapshots now also bound activities, proposed plans, and checkpoints with resource-specific `pageInfo` metadata. The web store merges these bounded reconnect snapshots without discarding older resources already present locally.
- `orchestration.getThreadActivitiesPage`, `orchestration.getThreadProposedPlansPage`, and `orchestration.getThreadCheckpointsPage` fetch bounded older resource pages before a loaded activity id, proposed-plan id, or checkpoint turn count. `ChatView` requests all eligible older resource pages together so older timeline content stays coherent.
- Live command output is already memory-bounded and retained for active/recent entries. Persisted file-diff snapshots are now capped on initial thread subscribe, and `orchestration.getThreadCommandOutputSnapshot` fetches a single live-or-persisted snapshot by thread/tool-call id for visible older file-change rows.
- Main thread activity pagination now ignores activity kinds that are hidden from the main timeline, including `subagent.*` activity. This prevents hidden subagent transcript churn from keeping the main "Load older history" affordance visible on otherwise short-looking threads.

Expected outcome: opening a huge thread is bounded, and older content loads on demand.

### Stage 4: Shell-Only Hot Read Model

- [x] Define a shell read model for command decisions and global subscriptions.
  - [x] Decouple thread subscription snapshot sequencing from `OrchestrationEngine.getReadModel()` by adding a projection-state-only snapshot sequence query.
- [x] Move thread body access behind targeted query APIs.
- [x] Audit `decider.ts`, provider ingestion, checkpointing, and project setup for thread-body assumptions.
- [x] Keep only fields needed for command invariants, sidebar state, active sessions, and latest turn state in the hot model.
- [x] Add regression tests for command decisions after removing full bodies from the hot model.

Expected outcome: total historical messages/activities are no longer baseline server heap.

Progress notes:

- `ProjectionSnapshotQuery.getSnapshotSequence()` now reads only projector cursor state and computes the same safe minimum snapshot sequence used by shell/full snapshots.
- `orchestration.subscribeThread` initial and history-sync reload snapshots now use the sequence-only projection query instead of touching the engine's in-memory read model for `snapshotSequence`.
- Provider turn start now reads the requested user message and user-message count through `ProjectionSnapshotQuery.getThreadTurnStartContext()` instead of scanning `thread.messages` from the hot model.
- Provider session stop now reads collaboration receiver thread ids through `ProjectionSnapshotQuery.getThreadCollabReceiverThreadIds()` instead of scanning `thread.activities` from the hot model.
- Orchestration command decisions now support `ProjectionSnapshotQuery.getThreadProposedPlanById()` for source proposed-plan validation, and the live engine path uses that targeted query instead of scanning the source thread's `proposedPlans` body.
- Provider runtime ingestion now uses `ProjectionSnapshotQuery.getThreadCheckpointProgress()` to decide provider diff placeholder checkpoint existence and next turn count instead of scanning `thread.checkpoints`.
- Provider runtime ingestion assistant-message completion now uses `ProjectionSnapshotQuery.getThreadAssistantMessageContext()` instead of scanning `thread.messages` to detect existing turn assistant output, streaming rows, and empty projected assistant messages.
- Provider runtime ingestion proposed-plan finalization now reuses `ProjectionSnapshotQuery.getThreadProposedPlanById()` to preserve existing implementation metadata instead of passing `thread.proposedPlans` through the hot event handler.
- Checkpoint diff finalization now uses `ProjectionSnapshotQuery.getLatestAssistantMessageIdForTurn()` for the assistant-message fallback instead of scanning `thread.messages`.
- Checkpoint capture and baseline paths now use the bounded checkpoint-progress projection query for real/placeholder checkpoint detection and max turn count instead of scanning `thread.checkpoints`.
- Checkpoint revert now uses `ProjectionSnapshotQuery.getThreadCheckpointRevertContext()` to read only the current turn count, target checkpoint ref, and stale checkpoint refs needed for restore/delete/rollback decisions.
- Project setup scripts, shell-stream project metadata enrichment, stale session recovery, and idle provider session reaping now use projection shell queries instead of full `OrchestrationEngine.getReadModel()` snapshots.
- Provider runtime ingestion no longer calls `OrchestrationEngine.getReadModel()`; runtime event processing uses per-thread shell lookups, proposed-plan lookups, snapshot sequence reads, and workspace cwd shell/project resolution.
- Provider command handling and checkpoint handling no longer call `OrchestrationEngine.getReadModel()`; they use thread/project shell queries plus existing targeted message/checkpoint/proposed-plan queries.
- No non-test server runtime caller of `OrchestrationEngine.getReadModel()` remains outside the service interface documentation.
- `OrchestrationEngine` now retains a compact command-decision read model instead of the full historical read model. The compact model preserves project/thread identity, deletion/archive/pin state, runtime/interaction mode, sessions, latest turns, and work-duration summaries, while stripping messages, activities, checkpoints, and proposed-plan bodies after bootstrap and every applied event. Public `getReadModel()` remains a full projection snapshot query so compatibility is preserved without pinning full history in engine memory.
- Command decision regression coverage now proves source proposed-plan validation works through the targeted projection lookup after body compaction, and projection-failure reconciliation is verified through subsequent command decisions instead of direct access to private engine state.

### Stage 5: Incremental Shell Summary Projection

- [x] Replace `refreshThreadShellSummary` full scans with incremental updates or targeted SQL aggregates.
- [x] Maintain latest user message timestamp at message projection time.
- [x] Maintain pending approval/user-input counters at activity/approval projection time.
- [x] Maintain actionable proposed plan state at proposed-plan and turn-state projection time.
- [x] Keep repair/rebuild paths for projection recovery.
- [x] Add tests for summary correctness across message, plan, activity, approval, revert, and replay paths.

Expected outcome: common event projection is O(1) or bounded, not O(thread history).

Progress notes:

- `refreshThreadShellSummary` now reads latest user message time, pending approval count, pending user-input state, and actionable proposed-plan state through one targeted SQL aggregate query.
- The refresh path no longer materializes all messages, proposed plans, activities, and pending approval rows for the thread on every dirty summary update.
- Focused projection and summary migration coverage passes against the aggregate semantics.
- Normal `thread.message-sent` projection now maintains `latest_user_message_at` directly and does not run the summary aggregate; revert still uses the aggregate repair path because it can remove the latest retained user message.
- Pending approval request/resolve/stale-failure transitions now update `pending_approval_count` directly where previous approval state is known.
- Pending user-input request/resolve/stale-failure transitions now maintain a dedicated `projection_pending_user_inputs` table, and thread summaries read `pending_user_input_count` / `latest_pending_user_input_at` from that bounded state instead of scanning all activities. Migration 039 backfills the new projection and repairs thread summaries from existing activity history.
- Normal proposed-plan upserts, session active-turn changes, and turn-diff completions now maintain `has_actionable_proposed_plan` directly with the same latest-turn-plan/fallback-latest-plan semantics as the repair aggregate.
- Revert and lagging-projector replay tests now cover the summary repair path: revert recomputes stale latest-user-message cache state, prunes reverted pending user-input rows from the bounded table, and a pending user-input projector behind the rest of projection state can rebuild its bounded table and repair the thread summary from event history.
- Migration 039 backfill is deterministic and idempotent for duplicate request ids by replaying the earliest request activity per request id, matching the live projector's first-request-wins behavior.

### Stage 6: History Sync Paging and Indexing

Use `.plan/history-sync-latest-first-mysql.md` as the detailed sync architecture. This stage tracks the audit-driven cleanup that must align with that plan.

- [ ] Remove normal-path all-local-event materialization.
- [ ] Remove normal-path all-remote-event materialization.
- [x] Fix latest-first bootstrap so it does not reread full local history per remote page.
- [ ] Replace remote fallback/index backfill paths that load all remote events.
- [ ] Make project mapping use indexed/project-level remote reads instead of full remote history.
- [ ] Revisit per-event pushed receipt growth and add retention or compact cursor strategy.
- [ ] Add tests with large synthetic histories for latest-first, priority-thread, append, and mapping flows.

Expected outcome: sync startup and backfill scale by page/thread, not total history.

Progress notes:

- Latest-first bootstrap page dedupe now queries local event refs only for the candidate remote page sequences, instead of rereading all local orchestration events once per remote thread page.
- Completed full-sync runs now have a fast path that checks remote max sequence and unpushed local rows before loading the full local event log, so already-current workspaces can return idle without materializing all local history.
- Autosave now has a pre-visible-sync pushability boundary: when remote history has not advanced, it checks for unpushed local events and runs the existing autosave pushability planner before publishing `syncing`. No-op autosave reschedules from close-together events stay invisible instead of flashing the spinner.
- The project mapping wizard now reads remote project candidates from the remote project/thread indexes instead of requiring full remote event history. The older event-based planner remains available for sync paths that already have event pages loaded or for fallback compatibility.
- Autosave pushability now treats a thread as settled when a provider session transitions from an observed active turn to a settled session with `activeTurnId: null`, even if the provider produced no `thread.turn-diff-completed` event. This keeps text-only/no-diff turns from remaining permanently deferred while still keeping active turns unpushable.
- The right-side Tasks/Plan visualization and its composer toggle are temporarily disabled because the sidebar lifecycle is not reliable enough under sync refreshes and thread changes. Plan creation, refinement, import, and implementation remain enabled; the sidebar needs a separate redesign before it is reintroduced.
- Autosave no longer reads the full local event log on the common completed-sync path where remote history has not advanced. Pushability and push planning use unpushed local events plus projection thread state, avoiding multi-GB transient server allocations when autosave starts after sending a message.
- Completed full-sync startup now uses the same bounded push planner when remote history is current but local receipt state has a few pending events. This avoids reading the full local event log just to push a small startup tail.

### Stage 7: Frontend Active Thread Derivation

- [ ] Build a shared per-thread activity projection so ChatView does not sort/scan activities multiple times per event.
- [ ] Make message updates append-friendly in store and avoid rebuilding full `ids` and `byId` records for each streaming delta.
- [ ] Review timeline auto-scroll content key generation for work rows so it avoids large string construction on every update.
- [ ] Add performance-oriented tests or benchmarks for streaming assistant deltas and activity bursts.

Expected outcome: active chat CPU cost is bounded by changed/visible data where practical.

Progress notes:

- Fixed a streaming flicker regression in the active timeline: message/reasoning content length changes no longer schedule an imperative `scrollToEnd` on every streamed chunk. LegendList remains the scroll owner through `maintainScrollAtEnd`, avoiding scroll anchoring fights while the agent is working.
- Thread history pagination now loads a coherent detail window instead of repainting one resource at a time: older message pages are paired with any older activities, proposed plans, and checkpoints needed to cover the same oldest message timestamp, then committed in one store update with viewport anchoring. The previous 1-second backfill polling loop has been replaced by deterministic window backfill.
- Timeline work-group row ids now anchor to the following timeline boundary when available, so prepending older work events no longer renames/remounts an already visible work group.
- Initial thread-detail snapshots now use the latest message page as the visual anchor and extend activities, proposed plans, and checkpoints back to the same oldest message timestamp before publishing the snapshot. This avoids refresh/sync first-paint flicker on event-dense threads where 500 activities covers far less time than 500 chat messages.

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

## Remaining Suggested Order

1. Stage 6: History sync paging and indexing.
2. Stage 7: Frontend active thread derivation.
3. Stage 8: Frontend global list scaling.
4. Stage 9: Logger writer lifecycle.

Stages 1, 2, 3, 4, and 5 are complete. Stage 6 should come next because history sync still has whole-log materialization paths.

## Validation Requirements

Each completed stage should include focused tests for the changed behavior plus the repository completion checks:

- `bun fmt`
- `bun run fmt:check`
- `bun lint`
- `bun typecheck`
- `bun run test`

Use `bun run test`, never `bun test`. For focused tests, run the package-local test script from the relevant package directory.

## Open Design Questions

- Stage 6 needs a remote-store paging contract that can resume safely across partial pushes and conflict-recovery states.
- Should old message/activity projection rows be retained forever, compacted, or moved to archive tables?
- Should history sync receipts be represented by compact cursors/ranges instead of one row per event?
