import type { FileDiffMetadata } from "@pierre/diffs/react";
import { memo } from "react";
import { ChevronRightIcon, FilePenLineIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { resolveFileDiffPath } from "../../lib/unifiedDiffRendering";

type CompactDiffTokenKind = "equal" | "added" | "removed";

interface CompactDiffToken {
  key: string;
  kind: CompactDiffTokenKind;
  text: string;
}

interface CompactDiffRow {
  key: string;
  kind: "change";
  deletionLineNumber: number;
  additionLineNumber: number;
  tokens: CompactDiffToken[];
}

interface CompactDiffSeparatorRow {
  key: string;
  kind: "separator";
  lines: number;
}

type CompactDiffRenderableRow = CompactDiffRow | CompactDiffSeparatorRow;

export interface CompactDiffRenderModel {
  filePath: string;
  additions: number;
  deletions: number;
  rows: CompactDiffRenderableRow[];
}

const MAX_COMPACT_ROWS = 80;
const MAX_COMPACT_BLOCK_LINES = 80;
const MAX_LINE_LENGTH = 260;
const MAX_LINE_TOKENS = 160;
const MIN_CHANGED_LINE_EQUAL_RATIO = 0.25;

export const CompactInlineDiff = memo(function CompactInlineDiff(props: {
  model: CompactDiffRenderModel;
  className?: string | undefined;
  onOpenFileDiff?: ((filePath: string) => void) | undefined;
}) {
  const { model, className, onOpenFileDiff } = props;

  return (
    <div className={cn("min-w-max", className)} data-compact-inline-diff="true">
      <div
        data-diffs-header
        className="sticky top-0 z-10 flex min-h-8 min-w-0 items-center gap-2 border-b border-border/55 bg-card/95 pr-8 pl-2 backdrop-blur"
      >
        <span className="flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-primary/80 bg-primary/10 text-primary">
          <FilePenLineIcon aria-hidden="true" className="size-3" strokeWidth={2.2} />
        </span>
        {onOpenFileDiff ? (
          <button
            type="button"
            data-title
            className="min-w-0 truncate text-left text-[11px] leading-4 font-medium text-foreground/90"
            title={model.filePath}
            onClick={() => onOpenFileDiff(model.filePath)}
          >
            {model.filePath}
          </button>
        ) : (
          <span
            data-title
            className="min-w-0 truncate text-[11px] leading-4 font-medium text-foreground/90"
            title={model.filePath}
          >
            {model.filePath}
          </span>
        )}
        <span className="min-w-0 flex-1" />
        <span data-metadata className="flex shrink-0 items-center gap-1 font-mono text-[11px]">
          {model.deletions > 0 ? (
            <span data-deletions-count className="text-destructive">
              -{model.deletions}
            </span>
          ) : null}
          {model.additions > 0 ? (
            <span data-additions-count className="text-success">
              +{model.additions}
            </span>
          ) : null}
        </span>
      </div>
      <div className="font-mono text-[11px] leading-4">
        {model.rows.map((row) => {
          if (row.kind === "separator") {
            return <CompactSeparatorRow key={row.key} lines={row.lines} />;
          }
          return <CompactChangeRow key={row.key} row={row} />;
        })}
      </div>
    </div>
  );
});

function CompactSeparatorRow({ lines }: { lines: number }) {
  return (
    <div data-separator="line-info" className="grid grid-cols-[6.5ch_minmax(0,1fr)]">
      <div data-column-number />
      <div data-separator-wrapper>
        <div data-separator-content>
          <span data-unmodified-lines>{lines} unmodified lines</span>
        </div>
      </div>
    </div>
  );
}

function CompactChangeRow({ row }: { row: CompactDiffRow }) {
  const shouldCollapseLineNumbers = row.deletionLineNumber === row.additionLineNumber;

  return (
    <div className="grid grid-cols-[6.5ch_minmax(0,1fr)]">
      <div
        data-column-number
        data-line-type="change-addition"
        className="flex items-center justify-end gap-1 border-r border-border/35 text-[10px]"
      >
        {shouldCollapseLineNumbers ? (
          <span data-collapsed-line-number className="text-amber-500/95 dark:text-amber-300/90">
            {row.additionLineNumber}
          </span>
        ) : (
          <>
            <span className="text-destructive/85">{row.deletionLineNumber}</span>
            <ChevronRightIcon aria-hidden="true" className="size-2.5 text-muted-foreground/45" />
            <span className="text-success/90">{row.additionLineNumber}</span>
          </>
        )}
      </div>
      <div
        data-line
        data-line-type="change-addition"
        className="whitespace-pre bg-background/35 text-foreground"
      >
        {row.tokens.map((token) => (
          <CompactDiffSpan key={token.key} token={token} />
        ))}
      </div>
    </div>
  );
}

function CompactDiffSpan({ token }: { token: CompactDiffToken }) {
  if (token.kind === "equal") {
    return <>{token.text}</>;
  }

  return (
    <span
      data-diff-span
      className={cn(
        token.kind === "removed"
          ? "bg-destructive/20 text-destructive line-through decoration-destructive/70"
          : "bg-success/20 text-success",
      )}
    >
      {token.text}
    </span>
  );
}

export function buildCompactDiffRenderModel(
  fileDiff: FileDiffMetadata,
): CompactDiffRenderModel | null {
  if (fileDiff.type === "new" || fileDiff.type === "deleted") return null;

  const rows: CompactDiffRenderableRow[] = [];
  let additions = 0;
  let deletions = 0;
  let compactChangeRows = 0;

  for (const [hunkIndex, hunk] of fileDiff.hunks.entries()) {
    if (hunk.collapsedBefore > 0) {
      rows.push({
        key: `separator:${hunkIndex}:before`,
        kind: "separator",
        lines: hunk.collapsedBefore,
      });
    }

    for (const [contentIndex, content] of hunk.hunkContent.entries()) {
      if (content.type === "context") {
        continue;
      }

      if (
        content.deletions !== content.additions ||
        content.deletions === 0 ||
        content.deletions > MAX_COMPACT_BLOCK_LINES
      ) {
        return null;
      }

      additions += content.additions;
      deletions += content.deletions;

      for (let lineOffset = 0; lineOffset < content.deletions; lineOffset += 1) {
        const deletionLineIndex = content.deletionLineIndex + lineOffset;
        const additionLineIndex = content.additionLineIndex + lineOffset;
        const deletionLine = fileDiff.deletionLines[deletionLineIndex];
        const additionLine = fileDiff.additionLines[additionLineIndex];
        if (deletionLine === undefined || additionLine === undefined) {
          return null;
        }

        if (deletionLine === additionLine) {
          continue;
        }

        const tokens = diffCompactLine(deletionLine, additionLine);
        if (!tokens || !hasEnoughSharedContent(tokens, deletionLine, additionLine)) return null;

        compactChangeRows += 1;
        if (compactChangeRows > MAX_COMPACT_ROWS) return null;

        rows.push({
          key: `change:${hunkIndex}:${contentIndex}:${lineOffset}`,
          kind: "change",
          deletionLineNumber: hunk.deletionStart + deletionLineIndex - hunk.deletionLineIndex,
          additionLineNumber: hunk.additionStart + additionLineIndex - hunk.additionLineIndex,
          tokens,
        });
      }
    }
  }

  if (compactChangeRows === 0) return null;

  return {
    filePath: resolveFileDiffPath(fileDiff),
    additions,
    deletions,
    rows,
  };
}

function diffCompactLine(deletionLine: string, additionLine: string): CompactDiffToken[] | null {
  if (deletionLine.length > MAX_LINE_LENGTH || additionLine.length > MAX_LINE_LENGTH) {
    return null;
  }

  const deletionTokens = tokenizeDiffLine(deletionLine);
  const additionTokens = tokenizeDiffLine(additionLine);
  if (deletionTokens.length > MAX_LINE_TOKENS || additionTokens.length > MAX_LINE_TOKENS) {
    return null;
  }

  const operations = buildTokenDiffOperations(deletionTokens, additionTokens);
  if (operations.length === 0) return null;

  return mergeAdjacentTokens(operations);
}

function hasEnoughSharedContent(
  tokens: ReadonlyArray<CompactDiffToken>,
  deletionLine: string,
  additionLine: string,
): boolean {
  const equalLength = tokens
    .filter((token) => token.kind === "equal")
    .reduce((total, token) => total + token.text.trim().length, 0);
  const comparableLength = Math.max(deletionLine.trim().length, additionLine.trim().length);
  return comparableLength === 0 || equalLength / comparableLength >= MIN_CHANGED_LINE_EQUAL_RATIO;
}

function tokenizeDiffLine(line: string): string[] {
  return line.match(/\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]+/gu) ?? [];
}

function buildTokenDiffOperations(
  deletionTokens: ReadonlyArray<string>,
  additionTokens: ReadonlyArray<string>,
): CompactDiffToken[] {
  const rows = deletionTokens.length + 1;
  const columns = additionTokens.length + 1;
  const lcsLengths = Array.from({ length: rows }, () => new Uint16Array(columns));

  for (let deletionIndex = deletionTokens.length - 1; deletionIndex >= 0; deletionIndex -= 1) {
    for (let additionIndex = additionTokens.length - 1; additionIndex >= 0; additionIndex -= 1) {
      lcsLengths[deletionIndex]![additionIndex] =
        deletionTokens[deletionIndex] === additionTokens[additionIndex]
          ? lcsLengths[deletionIndex + 1]![additionIndex + 1]! + 1
          : Math.max(
              lcsLengths[deletionIndex + 1]![additionIndex]!,
              lcsLengths[deletionIndex]![additionIndex + 1]!,
            );
    }
  }

  const operations: CompactDiffToken[] = [];
  let deletionIndex = 0;
  let additionIndex = 0;
  while (deletionIndex < deletionTokens.length || additionIndex < additionTokens.length) {
    if (
      deletionIndex < deletionTokens.length &&
      additionIndex < additionTokens.length &&
      deletionTokens[deletionIndex] === additionTokens[additionIndex]
    ) {
      operations.push({ key: "", kind: "equal", text: deletionTokens[deletionIndex]! });
      deletionIndex += 1;
      additionIndex += 1;
      continue;
    }

    if (
      additionIndex < additionTokens.length &&
      (deletionIndex >= deletionTokens.length ||
        lcsLengths[deletionIndex]![additionIndex + 1]! >
          lcsLengths[deletionIndex + 1]![additionIndex]!)
    ) {
      operations.push({ key: "", kind: "added", text: additionTokens[additionIndex]! });
      additionIndex += 1;
      continue;
    }

    operations.push({ key: "", kind: "removed", text: deletionTokens[deletionIndex]! });
    deletionIndex += 1;
  }

  return operations;
}

function mergeAdjacentTokens(tokens: ReadonlyArray<CompactDiffToken>): CompactDiffToken[] {
  const merged: CompactDiffToken[] = [];
  let offset = 0;
  for (const token of tokens) {
    const previous = merged.at(-1);
    if (previous?.kind === token.kind) {
      previous.text += token.text;
      offset += token.text.length;
      continue;
    }
    merged.push({ ...token, key: `${token.kind}:${offset}:${token.text}` });
    offset += token.text.length;
  }
  return merged;
}
