# Optimization Reliability Performance Audit

T3 Code is an agent-first desktop/web runtime. Performance and reliability
failures usually show up at the coordination boundaries: provider runtime
queues, orchestration projection, WebSocket snapshot fanout, SQLite
persistence, terminal output, history sync, and large React timelines. This
audit preserves the current review state for future slices: measure first,
bound risky queues, make recovery explicit, and keep user-facing behavior
predictable under long streams, reconnects, restarts, and provider crashes.

## Lifecycle Map

1. Provider event ingestion
   - Provider adapters publish `ProviderRuntimeEvent` values through in-memory
     queues or pubsubs.
   - `ProviderRuntimeIngestionLive` consumes provider events and selected
     orchestration domain events through a bounded `DrainableWorker`.
   - Runtime event IDs are deduplicated before projection-driving events are
     dispatched.
   - Buffered assistant/proposed-plan state has explicit cache capacities and
     TTLs, but adapter-local queues before ingestion are still mostly
     unbounded.

2. Orchestration and projection
   - `OrchestrationEngine` appends domain events and command receipts.
   - `ProjectionPipeline` rebuilds read models into projection tables and
     publishes bootstrap progress.
   - `OperationalHealthService` reports projection lag from persisted
     projection state, but queue/backlog fields are still placeholders.

3. WebSocket/RPC streaming
   - WebSocket RPC routes in `apps/server/src/ws.ts` serve commands and
     streaming subscriptions.
   - Shell and thread subscriptions send initial snapshots, then merge live
     orchestration events with command-output and history-sync-triggered
     snapshots.
   - Server config, auth access, terminal events, and git status each have
     independent streaming paths with their own fanout/backpressure behavior.

4. Persistence
   - SQLite access is serialized by `NodeSqliteClient` through a semaphore.
   - Current transaction acquisition serializes transaction scopes but does not
     issue SQLite `BEGIN`, `COMMIT`, or `ROLLBACK`.
   - Some call sites compensate for this explicitly, especially paired history
     sync receipt/state commits.
   - Migrations are statically imported and run at startup.

5. Terminal and process output
   - Terminal sessions own process lifecycle, output fanout, persisted history,
     and restart/close behavior.
   - Terminal persistence uses a keyed coalescing worker, which is the right
     shape for high-frequency output.
   - Provider command output previews and live command output snapshots feed the
     chat timeline and thread streams.

6. Web runtime state
   - Zustand stores own thread/session state, composer drafts, UI state, and
     terminal state.
   - Composer drafts persist through debounced local storage and verify image
     attachment persistence after writes.
   - Large timelines use `LegendList`; diff rendering uses dedicated
     virtualized rendering in the diff panel.

7. Desktop startup and readiness
   - Electron starts or connects to the backend, waits for readiness, then
     exposes the web runtime.
   - Startup command gating queues commands until readiness, but the gate queue
     is unbounded.
   - Running-thread quit and power-save protections exist and should remain
     part of reliability preflight.

8. Observability
   - Server traces are always written to local NDJSON.
   - Optional OTLP traces and metrics are documented.
   - Existing metrics cover important durations, but live queue depth, dropped
     events, memory pressure, and event-loop delay are not yet first-class
     operational signals.

## Feature-Purpose Inventory

| Capability                                       | Label          | Purpose / note                                                                                                          |
| ------------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Bounded `DrainableWorker` for ingestion/reactors | Keep, expand   | Good primitive for deterministic tests and backpressure. More runtime boundaries should expose capacity/backlog.        |
| Unbounded provider adapter queues/pubsubs        | Harden         | Risk under long streams, terminal spam, stalled ingestion, or disconnected subscribers.                                 |
| SQLite semaphore serialization                   | Keep, hardened | Prevents concurrent native SQLite access, but must become real transaction handling for atomic multi-write operations.  |
| History sync compensating receipt rollback       | Replace        | Useful guard today, but it signals missing transaction semantics in the persistence layer.                              |
| Projection lag operational health                | Keep, expand   | Useful persisted lag view; add queue depth, worker age, event-loop lag, memory, and dropped/coalesced counts.           |
| History-sync idle snapshot reload                | Keep, coalesce | Required after imports/restores, but per-subscriber snapshot reload can fan out expensive queries.                      |
| WebSocket merged live streams                    | Keep, audited  | Needed for responsive UI; add shared fanout/backpressure rules per stream type.                                         |
| Terminal keyed coalescing persistence            | Keep           | Correct shape for repeated output updates and should be copied where latest-state persistence is enough.                |
| Composer local-storage persistence               | Keep, measure  | Debounced persistence is reasonable; add payload-size and write-duration guardrails for large attachments/drafts.       |
| Timeline virtualization                          | Keep, expand   | `LegendList` is appropriate; add browser perf fixtures for large threads, streaming deltas, tool logs, and large diffs. |
| Bundle budget script                             | Keep, enforce  | Web build already checks bundle budget; include it in release and performance preflight.                                |
| Local trace NDJSON                               | Keep           | Good debugging baseline; add trace queries and thresholds for queue saturation and slow snapshot rebuilds.              |

## Future Boundaries

- `persistence/NodeSqliteClient.ts`: own real SQLite transaction semantics,
  busy timeout, WAL policy, statement streaming support decision, and
  interrupt/finalizer behavior.
- `shared/BoundedEventBuffer.ts`: shared bounded queue/pubsub policy for
  provider events, terminal output, command output, and lifecycle fanout.
- `shared/WorkerHealth.ts`: common backlog, capacity, oldest-item age,
  processed, failed, dropped, and coalesced counters for worker-style services.
- `server/operationalHealth.ts`: aggregate queue health, projection lag,
  provider sessions, event-loop delay, memory, startup readiness, and database
  latency into one low-cost snapshot.
- `orchestration/SnapshotInvalidation.ts`: coalesce shell/thread snapshot
  reloads by key and share reload results across subscribers.
- `provider/RuntimeBackpressure.ts`: provider adapter policy for blocking,
  coalescing, dropping low-value deltas, or stopping unhealthy sessions.
- `terminal/OutputBackpressure.ts`: terminal output chunking, history
  compaction, subscriber fanout, and persistence flush policy.
- `web/performanceScenarios.ts`: browser fixtures for large timelines, long
  streams, large diffs, many projects, queued prompts, and reconnect recovery.
- `bun run preflight:release`: repeatable local preflight that runs quality
  gates, browser perf assertions, enforced synthetic load scenarios, bundle
  budget, and desktop smoke coverage.

## Audit Progress

- Completed: initial repo-wide audit identified the highest-risk reliability
  and performance topics: missing SQLite transaction semantics, unbounded
  provider/runtime queues, placeholder queue health, WebSocket snapshot fanout,
  and large frontend coordination surfaces.
- Completed: existing guardrails confirmed clean at audit start:
  `bun run fmt:check`, `bun lint`, and `bun typecheck` all pass on the audited
  baseline.
- Completed: current good patterns are documented so follow-up work can reuse
  them: bounded `DrainableWorker`, keyed coalescing terminal persistence,
  projection lag snapshots, timeline virtualization, bundle budget checks, and
  always-on local tracing.
- Completed: `NodeSqliteClient` now makes Node SQLite transaction behavior
  explicit with `BEGIN IMMEDIATE`, commit/rollback semantics from Effect SQL,
  no-op nested transaction savepoints, and focused rollback/interruption tests.
- Completed: history sync pushed-receipt and sync-state commits now rely on
  `sql.withTransaction` instead of manual receipt restoration on state-write
  failure.
- Completed: shared `DrainableWorker` and `KeyedCoalescingWorker` now expose
  low-cost health snapshots, and operational health surfaces provider
  ingestion, command reactor, checkpoint reactor, thread deletion, terminal
  persistence, and startup command-gate pressure.
- Completed: provider runtime event backpressure now has explicit event
  classes, bounded runtime queues/pubsubs for Codex, Claude, Cursor, OpenCode,
  ACP, central provider fanout, provider registry fanout, server settings,
  auth credential changes, git status, and lifecycle events.
- Completed: WebSocket history-sync snapshot reloads now share in-flight shell
  and per-thread reloads, debounce repeated idle notifications, and log
  subscriber counts plus load durations around actual reload work.
- Completed: repeatable synthetic performance/load scenarios now live behind
  `bun run perf:load`, covering long provider streams, terminal output floods,
  many active sessions, reconnecting WebSocket clients, and large
  timeline/diff workloads with optional budget enforcement.
- Completed: composer draft persistence now tracks serialized payload size and
  write duration, warns on oversized/slow writes, compacts persisted image
  attachment payloads when drafts exceed budget, and swallows storage failures
  so local-storage quota errors do not break composer state.
- Completed: browser perf assertions now cover large timeline mount/streaming
  rerender, large inline diff rendering, large composer changed-file summaries,
  and sidebar project/thread derivation.
- Completed: release and CI preflight now include enforced synthetic load
  scenarios, web bundle budget checks, and desktop smoke coverage alongside
  format, lint, typecheck, Vitest, browser tests, desktop build, and preload
  verification. `bun run preflight:release` captures the same local gate.
- Backlog status: cleared for this audit.
- Remaining work should focus on residual-risk follow-up audits, not this
  completed hardening backlog.

## Agent Handoff Expectations

- After completing any item in this file, clearly tell the user what was
  completed and what item is due next.
- Do not say the optimization/reliability/performance work is finished until
  every task in this file's remaining backlog has been completed, verified, and
  reflected in this audit.
- If a task is intentionally deferred or blocked, state the blocker and name the
  next actionable task instead of implying the backlog is complete.
- Prefer focused slices with measurement before and after. If measurement is
  missing, add the measurement first unless the bug is an obvious correctness
  failure.

## Residual Review

- Accepted invariant: provider sessions can generate events faster than the UI
  can display them. The system must bound memory and preserve semantically
  important events rather than assuming consumers always keep up.
- Accepted invariant: local SQLite and remote MySQL history sync cannot be one
  atomic transaction. Local SQLite multi-write operations now use real local
  transactions where grouped writes must commit or roll back together.
- Accepted transaction constraint: nested `sql.withTransaction` calls on the
  Node SQLite client reuse the active transaction without savepoints; caught
  nested failures do not partially roll back inner writes.
- Accepted conservative policy: command and provider events should prefer
  blocking or session degradation over silent loss for lifecycle, approval,
  user-input, checkpoint, and final-message events.
- Open risk: adapter-local unbounded queues can accumulate before bounded
  ingestion sees backpressure.
- Open risk: load scenarios are now repeatable, budgeted, and release-gated,
  but they remain synthetic harnesses; future audits should add browser/server
  integration gates for reconnect and long-stream recovery.
- Open risk: runtime event buffers are bounded with conservative blocking
  semantics, but coalescible/droppable event classes still use the
  must-deliver path until a measured lossy/coalescing buffer is introduced.
- Open risk: browser perf assertions now cover the main timeline, composer,
  sidebar, and inline diff flows and run in CI/release browser tests, but the
  timing budgets are still intentionally broad to avoid CI noise.
- Open risk: large React coordination components are harder to profile and
  reason about, even when subcomponents are memoized and virtualized.

## Test Matrix

Prioritize deterministic package-local tests for core behavior, then add
browser/load scenarios where timing and rendering behavior matter.

- SQLite transaction tests:
  - multi-statement success commits all writes.
  - typed failure rolls back all writes.
  - defect/interruption releases transaction state and does not leak the
    semaphore.
  - nested transaction behavior is explicit and tested.
  - history sync receipt/state commits no longer need manual restoration.
- Queue and backpressure tests:
  - bounded worker blocks or fails according to its documented policy.
  - provider lifecycle/final events are never dropped under saturation.
  - assistant/token deltas can be coalesced without changing final transcript
    state.
  - queue health reports capacity, backlog, oldest age, processed, failed,
    dropped, and coalesced counts.
- WebSocket recovery tests:
  - reconnect receives a stable snapshot plus live events without duplication.
  - history-sync idle snapshot reload is coalesced across multiple
    subscribers.
  - slow subscribers cannot create unbounded memory growth.
  - command-output snapshots and deltas preserve order across reconnect.
- Projection and orchestration tests:
  - projection lag health tracks lag after delayed projector execution.
  - projector bootstrap progress remains monotonic.
  - event replay and snapshot rebuild stay consistent after restart.
- Terminal/process tests:
  - high-volume output is chunked/coalesced within memory budget.
  - terminal history persistence flushes on close/restart/shutdown.
  - process timeout and force-kill behavior releases all resources.
- Frontend performance tests:
  - large thread with many work entries opens within a fixed budget.
  - streaming assistant deltas do not rerender the entire app shell.
  - large diffs stay virtualized and do not block composer input.
  - local-storage draft writes stay debounced and bounded for large draft sets.
- Desktop readiness tests:
  - commands queued before backend readiness are bounded and drained in order.
  - backend readiness timeout reports actionable state.
  - running-thread quit guard and power-save blocker remain active through
    reconnects.

## Remaining Hardening Backlog

Cleared for this audit.
