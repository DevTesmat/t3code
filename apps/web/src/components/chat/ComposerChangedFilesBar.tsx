import { type TurnId } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import { type TurnDiffSummary } from "../../types";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";

export interface ComposerChangedFilesBarProps {
  turnSummary: TurnDiffSummary | null;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onExpandedChangeRequest?: () => void;
  maxExpandedHeightPx?: number | null;
}

export const ComposerChangedFilesBar = memo(function ComposerChangedFilesBar({
  turnSummary,
  resolvedTheme,
  onOpenTurnDiff,
  onExpandedChangeRequest,
  maxExpandedHeightPx = null,
}: ComposerChangedFilesBarProps) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [turnSummary?.turnId]);

  if (!turnSummary || turnSummary.files.length === 0) {
    return null;
  }

  const summaryStat = summarizeTurnDiffStats(turnSummary.files);
  const firstFilePath = turnSummary.files[0]?.path;

  return (
    <div className="mb-1.5 overflow-hidden rounded-md border border-border/70 bg-card/45">
      <div className="flex min-h-8 items-center gap-1.5 px-2">
        <button
          type="button"
          data-scroll-anchor-ignore
          aria-expanded={expanded}
          className="group flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => {
            onExpandedChangeRequest?.();
            setExpanded((value) => !value);
          }}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:text-foreground/80",
              expanded && "rotate-90",
            )}
          />
          <span className="truncate text-[11px] font-medium text-muted-foreground/85 group-hover:text-foreground/90">
            Changed files ({turnSummary.files.length})
          </span>
          {hasNonZeroStat(summaryStat) && (
            <span className="shrink-0 font-mono text-[10px] tabular-nums">
              <DiffStatLabel additions={summaryStat.additions} deletions={summaryStat.deletions} />
            </span>
          )}
        </button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="h-6 shrink-0 px-2 text-[10px]"
          onClick={() => onOpenTurnDiff(turnSummary.turnId, firstFilePath)}
        >
          View diff
        </Button>
      </div>
      {expanded && (
        <div className="border-border/55 border-t">
          <div
            className="overflow-y-auto px-1.5 py-1.5"
            data-composer-changed-files-scroll="true"
            style={maxExpandedHeightPx ? { maxHeight: maxExpandedHeightPx } : undefined}
          >
            <ChangedFilesTree
              key={`composer-changed-files-tree:${turnSummary.turnId}`}
              turnId={turnSummary.turnId}
              files={turnSummary.files}
              allDirectoriesExpanded
              resolvedTheme={resolvedTheme}
              onOpenTurnDiff={onOpenTurnDiff}
            />
          </div>
        </div>
      )}
    </div>
  );
});
