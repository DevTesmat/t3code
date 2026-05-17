# Subagent Startup Gate

This file is the source of truth for the subagent model-selection gate work.

Current state: T3Code can persist a default subagent model/reasoning selection and a no-prompt flag. The UI can display and edit these controls on subagent rows. Runtime projection now distinguishes pending subagents from running subagents and promotes pending rows to running only after child activity arrives. Subagent startup `request_user_input` prompts with the deterministic question ids `subagent_model` and `subagent_reasoning_effort` now render as pending inline subagent rows, stay out of the generic composer prompt, and submit the selected model/reasoning back to the model so it can call the real `spawnAgent`.

The shared Codex collaboration instructions now state that `request_user_input` is available in every T3Code collaboration mode, including Default, Plan, and future modes unless a later developer instruction explicitly disables it. The T3Code-managed Codex app-server process also starts with `--enable default_mode_request_user_input`; without that under-development Codex feature flag the router rejects `request_user_input` in Default mode before T3Code can render the inline gate.

## Goal

T3Code should own subagent startup state closely enough that the UI reflects reality:

1. Show pending user input when the subagent model cannot be inferred or no-prompt is off.
2. Show running when the model can be inferred from persisted defaults and no-prompt is on.
3. Show completed when the subagent finishes or wait reports completion.

## Protocol Constraint

Codex app-server currently exposes `collabAgentToolCall` only as item notifications after the tool call has already started or completed. There is no generated server request or approval callback for pre-execution `spawnAgent` gating.

Strict pre-spawn blocking therefore requires upstream app-server support for a collab-agent startup callback, or replacing built-in `spawnAgent` with a T3Code-owned dynamic/MCP tool path.

## Implemented Local Gate

- When no-prompt is enabled and a default subagent model exists, T3Code injects collaboration instructions requiring `spawnAgent` to include the default `model` and selected `reasoning_effort`.
- Otherwise, T3Code injects collaboration instructions requiring `request_user_input` before `spawnAgent`, using the deterministic question ids `subagent_model` and `subagent_reasoning_effort`, so the app presents a pending inline subagent state before a subagent is created.
- `request_user_input` availability is documented in shared collaboration instructions instead of being scoped only to Default mode.
- Codex app-server startup enables `default_mode_request_user_input`, keeping the real router behavior aligned with those instructions in Default mode.
- Projection keeps app-server `pendingInit` as `pending`, not `running`, and promotes to `running` on first child transcript/activity.
- The inline pending subagent row owns the model/reasoning controls and answers the pending user-input request directly.

## Remaining Work

- Add upstream/app-server support for a true pre-spawn callback, or implement a T3Code-owned subagent dynamic tool that starts child provider sessions itself.
- Move model/reasoning selection from the generic composer pending-input panel into the inline subagent startup box once T3Code owns the pre-spawn request object directly.
- Add end-to-end coverage with logs proving no child thread is created before the selection resolves.
