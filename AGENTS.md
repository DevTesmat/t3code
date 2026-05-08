# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- CI and release preflight use `bun run fmt:check`; run it when checking formatting without writing changes.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).
- Do not pass individual test file paths to the root `bun run test` command; Turbo interprets them as task names. For a focused test, run the package-local test script from that package directory, or use the full root `bun run test`.
- When searching thread logs, use `bun run logs:thread -- --logs <logs-dir> --thread <thread-id>` instead of manually searching with terminal commands. The script accepts the logs folder and canonical thread id, parses rotated provider logs reliably, and avoids false matches from embedded/copied log text. Use `--include-server`, `--grep <text>`, or `--around <id>` when needed.

## Planning Style

- Keep plans relatively short. Include the core concept behind the approach, then provide only enough detail in critical sections for the next steps to be clear and reviewable.
- Avoid over-specifying routine work. Expand only where correctness, reliability, data flow, failure handling, or cross-package behavior could be affected.

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server and CLI package. Owns WebSocket/API routing, provider runtime orchestration, provider instances, auth/session bootstrap, workspace/project access, terminal/process execution, checkpointing, git integration, persistence, and desktop history sync.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, orchestration projections, provider/workspace controls, terminal surfaces, and client-side state. Connects to the server via WebSocket.
- `apps/desktop`: Electron shell. Owns native desktop bootstrap, preload bridge, local environment discovery, folder picking IPC, desktop update integration, and packaging-specific behavior. Keep preload/API changes explicit and verify the built preload bundle when release behavior is affected.
- `apps/marketing`: Astro marketing/download site. Owns public pages and release/download presentation; do not couple app runtime logic into this package.
- `packages/contracts`: Shared Effect Schema schemas and TypeScript contracts for auth, provider/provider-instance events, provider runtime messages, WebSocket/RPC protocol, terminal, IPC, environment, workspace/project, settings, git, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by server, web, and desktop. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Browser/client runtime helpers for known environment and scoped runtime state. Keep it UI-safe and free of server-only dependencies.
- `packages/effect-codex-app-server`: Generated and hand-written Effect client/protocol wrapper for Codex app-server JSON-RPC. Treat `src/_generated/*` as generated protocol surface; update via the package generator instead of hand-editing generated files.
- `packages/effect-acp`: Generated and hand-written Effect client/protocol wrapper for ACP providers. Treat `src/_generated/*` as generated protocol surface; update via the package generator instead of hand-editing generated files.

## Reliability Expectations

- Provider instance lifecycle, auth state, workspace access, terminal streams, history sync, and orchestration projections must remain predictable across reconnects, restarts, partial streams, and provider crashes.
- Prefer explicit schemas and shared protocol types over ad hoc payloads. Cross-package protocol changes should start in `packages/contracts` or the generated protocol packages, then flow outward to server/web/desktop consumers.
- Release and CI parity matters: keep release preflight aligned with CI for format, lint, typecheck, Vitest, browser tests, desktop build, and preload verification.

## Codex App Server (Important)

T3 Code is currently Codex-first. The server starts `codex app-server` (JSON-RPC over stdio) per provider session, then streams structured events to the browser through WebSocket push messages.

How we use it in this codebase:

- Session startup/resume and turn lifecycle are brokered in `apps/server/src/codexAppServerManager.ts`.
- Provider dispatch and thread event logging are coordinated in `apps/server/src/providerManager.ts`.
- WebSocket server routes NativeApi methods in `apps/server/src/wsServer.ts`.
- Web app consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent` (provider runtime activity is projected into orchestration events server-side).

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.
