import { ChevronRightIcon, CircleIcon, CpuIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import type { ThreadSubagent } from "../../session-logic";
import { cn } from "../../lib/utils";

export interface ComposerSubagentsBarProps {
  subagents: ReadonlyArray<ThreadSubagent>;
}

const SUBAGENT_ROW_HEIGHT_PX = 38;
const SUBAGENT_LIST_VERTICAL_PADDING_PX = 12;
export const SUBAGENT_LIST_MAX_HEIGHT_PX =
  SUBAGENT_ROW_HEIGHT_PX * 4 + SUBAGENT_LIST_VERTICAL_PADDING_PX;

function shortThreadId(threadId: string): string {
  return threadId.length <= 8 ? threadId : threadId.slice(0, 8);
}

function statusClassName(status: ThreadSubagent["status"]): string {
  switch (status) {
    case "running":
      return "border-primary/20 bg-primary/8 text-primary/80";
    case "failed":
      return "border-destructive/25 bg-destructive/8 text-destructive/80";
    case "closed":
      return "border-border/60 bg-muted/30 text-muted-foreground/75";
    case "completed":
      return "border-emerald-500/20 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300";
    default:
      return "border-border/60 bg-muted/30 text-muted-foreground/75";
  }
}

function statusLabel(status: ThreadSubagent["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export const ComposerSubagentsBar = memo(function ComposerSubagentsBar({
  subagents,
}: ComposerSubagentsBarProps) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (subagents.length === 0) {
      setExpanded(false);
    }
  }, [subagents.length]);

  if (subagents.length === 0) {
    return null;
  }

  const runningCount = subagents.filter((subagent) => subagent.running).length;
  const countLabel =
    runningCount > 0
      ? `Subagents (${subagents.length}, ${runningCount} running)`
      : `Subagents (${subagents.length})`;

  return (
    <div className="mb-1.5 overflow-hidden rounded-md border border-border/70 bg-card/45">
      <div className="flex min-h-8 items-center gap-1.5 px-2">
        <button
          type="button"
          data-scroll-anchor-ignore
          aria-expanded={expanded}
          className="group flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:text-foreground/80",
              expanded && "rotate-90",
            )}
          />
          <span className="truncate text-[11px] font-medium text-muted-foreground/85 group-hover:text-foreground/90">
            {countLabel}
          </span>
        </button>
      </div>
      {expanded && (
        <div className="border-border/55 border-t">
          <div
            className="overflow-y-auto px-1.5 py-1.5"
            data-composer-subagents-scroll="true"
            style={{ maxHeight: SUBAGENT_LIST_MAX_HEIGHT_PX }}
          >
            <div className="flex flex-col gap-1">
              {subagents.map((subagent) => {
                const title =
                  subagent.nickname || subagent.role || shortThreadId(subagent.threadId);
                const meta = [subagent.role, subagent.model, subagent.reasoningEffort]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <div
                    key={subagent.threadId}
                    className="flex min-h-[38px] items-center gap-2 rounded-sm px-1.5 text-[11px] hover:bg-muted/35"
                    data-composer-subagent-row="true"
                  >
                    <CpuIcon
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-muted-foreground/70"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-foreground/90">{title}</div>
                      <div className="truncate text-muted-foreground/75">
                        {subagent.promptPreview || meta || subagent.threadId}
                      </div>
                    </div>
                    <span
                      className={cn(
                        "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]",
                        statusClassName(subagent.status),
                      )}
                    >
                      <CircleIcon aria-hidden="true" className="size-2 fill-current" />
                      {statusLabel(subagent.status)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
