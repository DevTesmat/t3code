# File Change Synthetic Stream Plan

## Goal

Make live Codex file-change previews arrive at the UI as append-style deltas instead of repeated full snapshots whenever the patch stream grows monotonically.

## Constraints

- Keep the server path lightweight: no timers, no artificial long-running workers, no large-file reads outside the existing bare-hunk resolver caps.
- Preserve correctness: if a new Codex snapshot is not an append-compatible continuation, publish a snapshot reset instead of emitting bad deltas.
- Keep the browser preview parser simple: it should render whatever accumulated text the live buffer exposes.

## Steps

1. [x] Track the last resolved file-change snapshot per thread/turn/item on the server.
2. [x] Convert append-compatible snapshot growth into small synthetic command-output deltas.
3. [x] Fall back to snapshot replacement for non-prefix updates, truncation, or empty output.
4. [x] Update tests for delta streaming, fallback replacement, and resolved hunk headers.
5. [x] Run focused tests plus `bun fmt`, `bun lint`, and `bun typecheck`.
