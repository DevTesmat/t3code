# Plan: Codex Tool Failure State

## Summary

Normalize Codex tool failures into explicit, visible runtime state instead of generic work-log warnings.
The first target is `apply_patch verification failed`, which Codex currently reports through stderr
as plain process log lines.

## Motivation

- Tool failures must not be eaten or hidden behind generic labels.
- Known recoverable failures should preserve enough context for the model to retry correctly.
- Unknown provider/runtime failures should still fail gracefully and remain visible to users.
- The Work Log should show failed edit attempts as useful history, separate from later successful retries.

## Evidence

Thread `849c01a9-4b53-4ea9-b416-25aabef58db2` produced canonical `runtime.warning`
events from `process/stderr` for an `apply_patch verification failed` error. The useful payload
contained the target path and expected lines, but the UI rendered four generic `Runtime warning`
rows because each stderr line was projected independently.

## Scope

- Codex provider/runtime normalization only.
- Canonical runtime failure metadata that other providers can adopt later.
- Orchestration activity projection for managed file-edit failures.
- Web work-log derivation and compact failed-edit rendering.

## Out Of Scope

- Replacing Codex app-server's provider-native tool result handling.
- Broad retries across all providers.
- Turning every warning into a blocking turn error.

## Decisions

- Provider-native model feedback comes first. T3 observes and displays Codex failures, and only adds
  synthetic model feedback later if tests prove Codex does not already return the failed tool result
  to the model.
- Weak correlation must stay honest. If T3 cannot confidently attach a failure to a specific tool
  call, it should render a visible unscoped runtime warning instead of fabricating a tool identity.
- Known patch verification failures are recoverable, so they should not stop the active turn.

## Implementation Status

| Area | Status | Notes |
|------|--------|-------|
| Plan doc | Done | This file is the source of truth for the rollout. |
| Canonical metadata | Done | `runtime.warning` carries optional managed failure metadata with recoverability, item type, path, reason, expected content, and optional tool id. |
| Codex normalization | Done | `CodexAdapter` buffers adjacent `apply_patch verification failed` stderr into one managed retryable warning. |
| Orchestration projection | Done | Managed patch warnings project as failed `file_change` tool activities; unmanaged warnings stay generic. |
| Web work log | Done | Work-log derivation preserves failure detail and renders compact failed edit rows with expandable expected content. |
| Tests | Done | Focused adapter, ingestion, work-log derivation, UI rendering, and full required validation all pass. |

## Proposed Changes

1. Add a managed failure payload to canonical runtime warnings with `kind`, `recoverability`,
   `itemType`, `path`, `reason`, `expectedContent`, and optional `toolCallId`.
2. In the Codex adapter boundary, detect `apply_patch verification failed` stderr starts, collect
   following stderr lines as expected content, and emit one structured warning instead of multiple
   generic warnings.
3. Keep weak correlation unscoped: patch verification failures get a synthetic managed-failure tool
   identity unless Codex provides a confident tool id later.
4. In ingestion, project managed file-change failures as `tool.completed` activities with
   `status: "failed"` and rich failure detail; leave unmanaged warnings as normal runtime warnings.
5. In the web work log, derive failed file-change rows from the managed payload and show a compact
   failed row with expandable details for the expected content.

## Risks

- Codex stderr formats may change; the classifier should fail open to visible generic warnings.
- Over-correlation could attach a failure to the wrong edit. Prefer unscoped warning when unsure.
- Grouping stderr requires buffering; flush pending failures on the next non-continuation event.

## Validation

- `bun fmt` - passed
- `bun lint` - passed
- `bun typecheck` - passed
- Focused package-local `bun run test` - passed for server adapter/ingestion and web work-log/rendering tests
- Full root `bun run test` - passed

## Done Criteria

- A patch verification failure appears as one useful failed edit row, not multiple generic warnings.
- The row shows the target path and exact expected content that was not present.
- The active turn remains running so Codex can retry.
- Later successful edits remain separate from the failed attempt.
- Unknown stderr/runtime failures remain visible and graceful.
