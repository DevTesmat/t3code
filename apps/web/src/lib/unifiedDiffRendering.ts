import { parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs/react";

import { buildPatchCacheKey } from "./diffRendering";

export const DIFF_RENDER_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 80%,
    var(--destructive)
  );

  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  min-height: 1.75rem !important;
  background-color: color-mix(in srgb, var(--card) 96%, var(--background)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
  font-size: 11px !important;
  font-weight: 500 !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0 !important;
  z-index: 10 !important;
  min-height: 1.75rem !important;
  background-color: color-mix(in srgb, var(--card) 98%, var(--background)) !important;
  border-bottom: 1px solid var(--border) !important;
  box-shadow: 0 1px 0 color-mix(in srgb, var(--border) 58%, transparent) !important;
  backdrop-filter: blur(8px);
}

[data-title] {
  cursor: pointer;
  color: color-mix(in srgb, var(--foreground) 86%, var(--muted-foreground)) !important;
  font-size: 11px !important;
  font-weight: 500 !important;
  transition:
    color 120ms ease,
    text-decoration-color 120ms ease;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
}

[data-title]:hover {
  color: color-mix(in srgb, var(--foreground) 84%, var(--primary)) !important;
  text-decoration-color: currentColor;
}
`;

export const INLINE_FILE_CHANGE_RUNNING_UNSAFE_CSS = `
[data-title]::after {
  content: '...';
  display: inline-block;
  margin-left: 0.35rem;
  color: var(--muted-foreground);
  animation: inline-file-change-dots 1.05s steps(4, end) infinite;
}

@keyframes inline-file-change-dots {
  0% {
    clip-path: inset(0 100% 0 0);
  }
  25% {
    clip-path: inset(0 66% 0 0);
  }
  50% {
    clip-path: inset(0 33% 0 0);
  }
  75%,
  100% {
    clip-path: inset(0 0 0 0);
  }
}
`;

export const INLINE_DIFF_RENDER_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-font-size: 11px;
  --diffs-line-height: 16px;
  --diffs-header-font-size: 10px;
  --diffs-gap-block: 2px;
  --diffs-gap-inline: 6px;
}

[data-diffs-header],
[data-file-info] {
  min-height: 1.35rem !important;
  padding-inline: 0.5rem !important;
  padding-right: 1.75rem !important;
  font-size: 10px !important;
  line-height: 1.2 !important;
}

[data-header-content] {
  gap: 0.35rem !important;
}

[data-title],
[data-prev-name],
[data-metadata],
[data-unmodified-lines] {
  font-size: 10px !important;
  line-height: 1.2 !important;
}

[data-separator-wrapper] {
  min-height: 1.25rem !important;
}

[data-separator-first][data-separator='line-info'],
[data-separator-first][data-separator='line-info-basic'] {
  display: none !important;
}

[data-separator-content] {
  padding-block: 0 !important;
  padding-inline: 0.5rem !important;
}

[data-line],
[data-column-number],
[data-no-newline],
[data-code] {
  font-size: 11px !important;
  line-height: 16px !important;
}

[data-line],
[data-column-number],
[data-no-newline] {
  padding-inline: 0.65ch !important;
}

[data-column-number] {
  padding-left: 1ch !important;
}
`;

export type RenderablePatch =
  | {
      kind: "files";
      files: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };

export function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  if (!patch) return null;
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return null;

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (files.length > 0) {
      return { kind: "files", files };
    }

    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

export function stripDiffPathPrefix(pathValue: string): string {
  if (pathValue.startsWith("a/") || pathValue.startsWith("b/")) {
    return pathValue.slice(2);
  }
  return pathValue;
}

export function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  return stripDiffPathPrefix(fileDiff.name ?? fileDiff.prevName ?? "");
}

export function resolveFileDiffMatchPaths(fileDiff: FileDiffMetadata): string[] {
  return [
    ...new Set(
      [fileDiff.name, fileDiff.prevName]
        .filter((pathValue): pathValue is string => Boolean(pathValue))
        .map(stripDiffPathPrefix),
    ),
  ];
}

export function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}
