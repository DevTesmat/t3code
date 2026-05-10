# Inline Turn Diff Rendering

## Current State

The right-side diff panel and the completed inline file-change preview already use
the same diff rendering library:

- `@pierre/diffs` parses unified patches through `parsePatchFiles`.
- `@pierre/diffs/react` renders parsed files through `FileDiff`.
- Shared wrapper logic lives in `apps/web/src/lib/unifiedDiffRendering.ts`.

The main right-side diff panel is implemented in `apps/web/src/components/DiffPanel.tsx`.
It loads a checkpoint diff, parses it with `getRenderablePatch`, sorts the parsed
`FileDiffMetadata` entries, and renders each file with `FileDiff` inside
`Virtualizer`.

The completed inline preview is implemented in
`apps/web/src/components/chat/MessagesTimeline.tsx`:

- `CompletedChangedFilesDiffPreview` loads the same turn checkpoint range through
  `checkpointDiffQueryOptions`.
- It parses the same unified diff with `getRenderablePatch`.
- It filters the parsed files down to the changed file paths associated with the
  timeline work entry.
- It renders those files with `FileDiff`.

So the completed inline preview is already library-compatible with the panel.
The differences are mostly presentation and scope:

- The panel can show a whole turn or the whole conversation.
- The inline preview intentionally shows only the file paths attached to that
  timeline work entry.
- The panel exposes stacked/split and wrapping controls.
- The inline preview hardcodes unified rendering, hides file headers, and uses a
  compact CSS override.

Running file-change previews are different on purpose. `LiveFileChangePreview`
uses a custom line renderer because the live stream can be partial, can arrive
before hunk/file metadata is complete, and may not be parseable by
`@pierre/diffs` until the change is finished.

## Library Contract

Use the local helpers instead of calling `@pierre/diffs` directly from feature
components:

```ts
const renderablePatch = getRenderablePatch(rawUnifiedDiff, cacheScope);
```

`getRenderablePatch` returns one of:

- `null` when there is no patch to render.
- `{ kind: "files", files }` when `parsePatchFiles` produced one or more
  `FileDiffMetadata` entries.
- `{ kind: "raw", text, reason }` when the patch is empty, unsupported, or failed
  to parse.

Render parsed file diffs with `FileDiff`:

```tsx
<FileDiff
  fileDiff={fileDiff}
  options={{
    diffStyle: "unified",
    lineDiffType: "none",
    overflow: settings.diffWordWrap ? "wrap" : "scroll",
    theme: resolveDiffThemeName(resolvedTheme),
    themeType: resolvedTheme,
    unsafeCSS: DIFF_RENDER_UNSAFE_CSS,
  }}
/>
```

Important options currently used by T3 Code:

- `diffStyle`: `"unified"` or `"split"`.
- `lineDiffType`: currently `"none"` in both right-panel and inline views.
- `overflow`: `"wrap"` or `"scroll"`.
- `theme`: mapped through `resolveDiffThemeName`, currently `pierre-light` or
  `pierre-dark`.
- `themeType`: the app-resolved `"light"` or `"dark"` theme.
- `unsafeCSS`: app-level CSS variable overrides for matching T3 Code styling.
- `disableFileHeader`: useful only for compact inline previews. Do not set it if
  the inline view should visually match the full panel headers.

Cache scopes should be stable and specific. Use the raw patch plus a meaningful
scope through `buildPatchCacheKey` indirectly via `getRenderablePatch`. Examples:

- Right panel: `diff-panel:${resolvedTheme}`.
- Inline turn preview: `inline-diff:${resolvedTheme}`.
- If inline rendering becomes configurable by style, include that style in the
  scope as well.

## Correct Way To Make Inline Match The Panel

Keep the turn-specific data boundary, but share the rendering surface.

The data boundary should remain checkpoint-based:

1. Resolve the timeline work entry's `turnId`.
2. Look up the corresponding `TurnDiffSummary`.
3. Convert its checkpoint turn count into a range:
   `fromTurnCount = checkpointTurnCount - 1`, `toTurnCount = checkpointTurnCount`.
4. Load the raw unified diff through `checkpointDiffQueryOptions`.
5. Parse it with `getRenderablePatch`.
6. Filter the parsed `FileDiffMetadata[]` to the work entry's `changedFiles`.

That preserves the specific diff for the turn while avoiding stale local git
state. It also keeps the same server contract used by the panel:
`orchestration.getTurnDiff`.

The rendering should be extracted from `DiffPanel.tsx` into a shared component,
for example:

```tsx
<DiffFileList
  files={matchingFiles}
  diffStyle={diffRenderMode}
  wordWrap={settings.diffWordWrap}
  resolvedTheme={resolvedTheme}
  variant="inline"
/>
```

The shared component should own:

- the `FileDiff` call;
- `resolveDiffThemeName`;
- `DIFF_RENDER_UNSAFE_CSS`;
- file render keys from `buildFileDiffRenderKey`;
- optional `Virtualizer` usage for large lists;
- raw patch fallback styling if the caller passes a raw render result.

The callers should own:

- which diff range to query;
- which files to include;
- route navigation and editor opening;
- panel-only controls such as turn chips;
- inline-only expansion state.

For closest visual parity, remove inline-only renderer differences:

- Do not use `disableFileHeader: true` unless compactness is more important than
  matching the panel.
- Use the same `diffStyle` value as the panel. If no inline control is desired,
  read the same setting or default used by the panel.
- Use the same `DIFF_RENDER_UNSAFE_CSS` first. Add inline sizing overrides only
  at the container level where possible.
- Keep `overflow` tied to `settings.diffWordWrap`, as both views already do.

For performance, keep filtering before rendering. Rendering every file in a
large turn and hiding the unrelated ones would regress the current large-inline
diff behavior. Existing browser tests assert that inline rendering only renders
the selected file from a large turn diff.

## What Not To Do

- Do not parse or style diff text manually for completed file changes.
- Do not read the current worktree diff for inline historical turns; that would
  show current state rather than the turn-specific checkpoint diff.
- Do not hand-edit generated protocol files when changing diff contracts.
- Do not use the root `bun run test` with individual test file paths.

## Suggested Follow-Up

Refactor toward a shared diff renderer in `apps/web/src/components/`, then switch
both `DiffPanel.tsx` and `CompletedChangedFilesDiffPreview` to use it. Keep the
custom live renderer for running partial streams unless the live stream is first
made parse-safe and complete enough for `@pierre/diffs`.
