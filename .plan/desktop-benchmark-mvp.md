# Desktop Benchmark MVP Plan

## Status

This file is the source of truth for the desktop benchmark MVP. Keep it updated whenever scope, ordering, implementation details, or completion status changes.

Current state: the first dev-only benchmark MVP is implemented and has passed live runs. `bun run dev:desktop:bench` starts an isolated desktop stack, creates a benchmark project and thread, sends `Reply exactly with: TEST`, verifies the final assistant reply, writes per-run metrics, writes a batch summary, and shuts the stack down. The runner now supports `--provider`, `--model`, and `--runs`. Formatting, lint, and typecheck pass; the full repo test run currently fails in an existing web timeline assertion unrelated to the benchmark path.

## Goal

Add a dev-only benchmark harness that starts T3 Code Desktop with a clean history, creates a thread in a default benchmark project, sends the prompt `Reply exactly with: TEST`, verifies the agent output, and records timings for model/app comparisons.

The first MVP should answer one question reliably: how long does the same minimal live agent run take for a given model/configuration?

## Non-Negotiable Constraints

- Keep benchmark behavior completely separated from production builds.
- Do not add benchmark UI, endpoints, fixtures, or automation to packaged production behavior unless explicitly gated off by dev-only runtime checks.
- Every benchmark run starts with a clean `T3CODE_HOME`.
- The scenario must be deterministic at the app-action level:
  - same workspace/project path
  - same prompt
  - same thread creation flow
  - same output assertion
  - same metric schema
- The harness must fail clearly when the response is not exactly `TEST`.
- The MVP must not mutate user history, user workspaces, or normal desktop settings.

## Proposed Developer Entry Point

Add a root script:

```sh
bun run dev:desktop:bench
```

The script should:

1. Create a fresh run directory under a repo-local ignored benchmark root, for example `.t3-bench/runs/<run-id>`.
2. Create a minimal benchmark workspace/project directory inside that run directory.
3. Start the normal desktop dev stack through the existing dev-runner path, with benchmark-only env:
   - `T3CODE_HOME=<fresh-run-home>`
   - `T3CODE_BENCHMARK_MODE=1`
   - `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=0`
   - stable port offset or isolated dev instance
4. Wait for the server/web/desktop app to become ready.
5. Drive the app or server through the same actions every run.
6. Write metrics to `.t3-bench/runs/<run-id>/result.json`.
7. Exit non-zero if startup, thread creation, turn completion, or output verification fails.

## MVP Scenario

Name: `exact-test-reply`

Steps:

1. Start from empty benchmark history.
2. Open T3 Code Desktop in dev mode.
3. Create or select the default benchmark project.
4. Create a new thread.
5. Send prompt:

```text
Reply exactly with: TEST
```

6. Wait for the assistant turn to finish.
7. Extract the final assistant answer.
8. Assert normalized final answer is exactly `TEST`.
9. Persist timings and model/provider metadata.

## Metrics For MVP

Capture at least:

- `runId`
- `batchId`
- `runIndex`
- `runCount`
- `scenario`
- `startedAt`
- `turnStartedAt`
- `completedAt`
- `success`
- `providerInstanceId`
- `model`
- `modelOptions`
- `desktopReadyMs`
- `serverReadyMs`
- `threadCreateMs`
- `turnWallClockMs`
- `timeToFirstAssistantEventMs`
- `timeToFinalAssistantEventMs`
- `timeToFirstAssistantFromTurnMs`
- `timeToFinalAssistantFromTurnMs`
- `tokenUsage`
- `inputTokens`
- `cachedInputTokens`
- `outputTokens`
- `reasoningOutputTokens`
- `totalTokens`
- `outputTokensPerSecond`
- `finalAssistantText`
- `error`, when failed

For repeated runs, write a batch summary with min, median, p95, and max for startup, thread creation, turn timing, output token, reasoning token, and output TPS metrics.

Captured when available from provider/runtime events:

- input tokens
- output tokens
- reasoning tokens
- output tokens per second
- tool call count
- provider retry count

## Production Separation Design

Use layered gates:

- Script gate: benchmark entrypoint exists only as a dev script.
- Environment gate: benchmark behavior requires `T3CODE_BENCHMARK_MODE=1`.
- Web gate: any benchmark-specific UI must also require `import.meta.env.DEV`.
- Server gate: any benchmark-specific API or automation route must reject unless `T3CODE_BENCHMARK_MODE=1`.
- Packaging gate: production desktop build scripts must not reference benchmark scripts.

The MVP should prefer external automation and existing APIs over adding app-visible benchmark UI. A benchmark panel can come later after metrics stabilize.

## Implementation Stages

### Stage 1: Harness Plan and Boundaries

Status: complete for MVP.

- [x] Create this plan file.
- [x] Confirm the best automation path:
  - drive the WebSocket/API directly, or
  - drive the desktop UI with Playwright/Electron automation.
- [x] Identify existing server RPC methods for project/thread creation and turn dispatch.
- [x] Identify the canonical event that marks assistant turn completion.
- [x] Decide where final assistant text should be read from for assertion.
- [x] Confirm the benchmark runner can reuse the existing web RPC client code from a Node/Bun script without pulling browser-only modules.
- [x] Confirm how desktop auth/bootstrap affects an external benchmark RPC client.

Expected outcome: the MVP path is small enough to implement without adding benchmark behavior to production code.

Implementation notes:

- Use direct RPC automation for the MVP. UI-driving can be added later as a separate scenario class.
- Dispatch commands through `orchestration.dispatchCommand`.
- Use `project.create` to create the benchmark project.
- Use `thread.turn.start` with `bootstrap.createThread` to create the thread and send the first user message in one command.
- Subscribe to thread events through `orchestration.subscribeThread`, or replay events through `orchestration.replayEvents` if the runner connects after dispatch.
- Treat first assistant `thread.message-sent` event with `role: "assistant"` as time-to-first assistant event.
- Treat a non-empty final assistant `thread.message-sent` with `role: "assistant"` and `streaming: false`, plus `thread.session-set` with `status: "ready"` and `activeTurnId: null`, as the completion boundary.
- Accumulate assistant streaming deltas by message id because Codex can emit an initial empty assistant message before the text delta arrives.
- Read final assistant text from the accumulated assistant stream for the benchmark thread, then compare `text.trim()` to `TEST`.

### Stage 2: Dev Script and Clean Runtime Home

Status: complete for MVP.

- [x] Add `dev:desktop:bench` to root `package.json`.
- [x] Add a benchmark runner script under `scripts/`.
- [x] Ensure each run creates a fresh `.t3-bench/runs/<run-id>/home`.
- [x] Add `.t3-bench/` to `.gitignore` if it is not already ignored.
- [x] Start the existing `dev:desktop` stack with benchmark env.
- [x] Ensure child processes are cleaned up on success and failure.
- [ ] Add explicit Ctrl+C cleanup handling.

Expected outcome: a clean benchmark desktop session can start and stop without touching normal user state.

Progress notes:

- `scripts/desktop-benchmark-mvp.ts` starts `scripts/dev-runner.ts dev:desktop` with `T3CODE_BENCHMARK_MODE=1`, an isolated `T3CODE_HOME`, and an isolated port offset.
- Desktop dev benchmark mode writes a bootstrap handoff JSON to the path provided by `T3CODE_BENCHMARK_BOOTSTRAP_PATH`.
- The desktop backend now supports one or more extra desktop bootstrap tokens in its bootstrap envelope so the benchmark runner does not race the renderer for the normal one-use desktop token.

### Stage 3: Minimal Scenario Automation

Status: complete for MVP.

- [x] Wait for app readiness.
- [x] Create/select benchmark project.
- [x] Create a new thread.
- [x] Send `Reply exactly with: TEST`.
- [x] Wait for completion.
- [x] Assert final assistant response is exactly `TEST`.

Expected outcome: the harness can run one deterministic scenario end to end.

Progress notes:

- The runner exchanges the benchmark bootstrap token for a bearer session, then exchanges that for a WebSocket token.
- The runner uses a Node-safe Effect RPC WebSocket client built from `@t3tools/contracts` instead of importing browser/web RPC modules.
- The runner dispatches `project.create`, then dispatches `thread.turn.start` with `bootstrap.createThread`.
- Completion is defined as accumulated non-empty final assistant `thread.message-sent` plus `thread.session-set` status `ready` and `activeTurnId: null`.
- A live run on 2026-05-16 created the project/thread and verified the final reply `TEST`.

### Stage 4: Metrics and Result File

Status: complete for MVP.

- [x] Record timing boundaries with monotonic timers.
- [x] Persist result JSON in the run directory.
- [x] Persist batch summary JSON with aggregate stats.
- [x] Print a concise terminal summary.
- [x] Include enough metadata to compare model changes across runs.
- [x] Add CLI overrides for provider instance and model.
- [x] Add repeated clean-run execution with `--runs`.
- [x] Add turn-relative assistant timing metrics.
- [x] Add token usage and output TPS extraction from `context-window.updated` runtime activities when providers emit usage.
- [x] Add `fixed-output` scenario for a longer throughput-oriented response.

Expected outcome: repeated runs produce comparable local benchmark artifacts.

### Stage 5: Validation

Status: mostly complete; one unrelated repo test failure remains.

- [ ] Add focused tests for pure runner helpers where possible.
- [x] Run `bun fmt` / `bun run fmt:check`.
- [x] Run `bun lint`.
- [x] Run `bun typecheck`.
- [ ] Run `bun run test`.
- [x] Manually run `bun run dev:desktop:bench` with a real provider when credentials are available.

Progress notes:

- `bun run fmt:check` passed.
- `bun run lint` passed.
- `bun run typecheck` passed.
- `bun run dev:desktop:bench` passed on 2026-05-16 with `codex/gpt-5.4-mini`, result file `.t3-bench/runs/2026-05-16T09-20-55-257Z-814061/result.json`, and timing summary: turn `3579ms`, first assistant `10440ms`, final assistant `10486ms`.
- `bun run dev:desktop:bench -- --provider codex --model gpt-5.4-mini --runs 1` passed on 2026-05-16, result file `.t3-bench/runs/2026-05-16T21-18-13-774Z-843fc3-run-001-394802/result.json`, summary file `.t3-bench/runs/2026-05-16T21-18-13-774Z-843fc3-summary.json`, and timing summary: turn `5227ms`, first assistant from turn `5152ms`, final assistant from turn `5181ms`.
- `bun run dev:desktop:bench -- --scenario fixed-output --provider codex --model gpt-5.4-mini --runs 1` passed on 2026-05-16, result file `.t3-bench/runs/2026-05-16T21-24-57-551Z-307bd9-run-001-5d94ed/result.json`, summary file `.t3-bench/runs/2026-05-16T21-24-57-551Z-307bd9-summary.json`, and timing/token summary: turn `5821ms`, first assistant from turn `4324ms`, final assistant from turn `5813ms`, output tokens `384`, reasoning output tokens `37`, output TPS `66.06`.
- `bun run test` currently fails in `apps/web/src/components/chat/MessagesTimeline.test.tsx` at `auto-renders running file-change output from the hydrated live buffer`: the rendered markup contains the inline file change patch but no longer contains the expected literal `diffs-container` string.

Expected outcome: repo checks pass, and the MVP works against a live desktop dev session.

## Open Questions

- Should the benchmark drive the UI or the server RPC layer?
  - UI driving measures more of the app, but is more brittle.
  - RPC driving is faster and less flaky, but misses frontend interaction overhead.
  - MVP recommendation: use the server/API layer for deterministic timing, then add optional UI-driven scenarios later.
- Which model/provider should be the default benchmark target?
  - MVP recommendation: use the currently configured default provider/model unless a CLI flag overrides it.
- Should the harness support a model matrix in MVP?
  - Current status: single `--provider` / `--model` overrides and repeated runs are implemented. Matrix support remains out of scope until TPS extraction is stable.
- How should exact output be normalized?
  - MVP recommendation: trim leading/trailing whitespace only. Any other text fails.

## Out Of Scope For MVP

- Benchmark dashboard UI.
- Multi-model matrix runner.
- Web-search or subagent scenarios.
- Historical comparison database.
- Packaged desktop benchmark mode.
- Synthetic provider mocks.
- Automated TPS claims beyond what provider/runtime metrics expose.
