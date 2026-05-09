import type { HistorySyncPendingEventReview, HistorySyncStatus } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ClockIcon,
  CloudIcon,
  LoaderIcon,
  RefreshCwIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { ensureLocalApi } from "../localApi";
import { useServerConfig } from "../rpc/serverState";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { cn } from "~/lib/utils";

export const HISTORY_SYNC_AUTOSAVE_REMOTE_CONFLICT_MESSAGE =
  "Autosave paused because another device synced newer history. Use Sync now to import remote changes before autosave resumes.";

export function isHistorySyncAutosaveRemoteConflictStatus(status: HistorySyncStatus): boolean {
  return (
    status.state === "error" && status.message === HISTORY_SYNC_AUTOSAVE_REMOTE_CONFLICT_MESSAGE
  );
}

function formatDateTime(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function useRetryCountdown(status: HistorySyncStatus | null): string | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (status?.state !== "retrying") return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [status?.state]);

  if (status?.state !== "retrying") return null;
  return formatDuration(new Date(status.nextRetryAt).getTime() - now);
}

export function getHistorySyncTopbarStatusSummary(status: HistorySyncStatus): {
  readonly label: string;
  readonly detail: string;
  readonly tone: "idle" | "active" | "warning" | "error";
  readonly Icon: typeof CloudIcon;
} {
  switch (status.state) {
    case "syncing":
      return {
        label:
          status.lane === "latest-bootstrap"
            ? "Loading recent threads"
            : status.lane === "priority-thread"
              ? "Syncing opened thread"
              : "History sync running",
        detail: status.progress?.label ?? "Syncing history",
        tone: "active",
        Icon: LoaderIcon,
      };
    case "retrying":
      return {
        label: "History sync retrying",
        detail: `Retry ${status.attempt}/${status.maxAttempts} scheduled`,
        tone: "warning",
        Icon: RefreshCwIcon,
      };
    case "error":
      if (isHistorySyncAutosaveRemoteConflictStatus(status)) {
        return {
          label: "History sync paused",
          detail: "Use Sync now to import remote changes before autosave resumes.",
          tone: "warning",
          Icon: AlertTriangleIcon,
        };
      }
      return {
        label: "History sync failed",
        detail: status.message,
        tone: "error",
        Icon: AlertTriangleIcon,
      };
    case "idle":
      return {
        label: "History sync idle",
        detail: `Last synced ${formatDateTime(status.lastSyncedAt)}`,
        tone: "idle",
        Icon: CheckCircle2Icon,
      };
    case "needs-initial-sync":
      return {
        label: "History sync needs setup",
        detail: "Initial sync has not run",
        tone: "warning",
        Icon: CloudIcon,
      };
    case "needs-project-mapping":
      return {
        label: "History sync needs mapping",
        detail: `${status.unresolvedProjectCount} project mapping${
          status.unresolvedProjectCount === 1 ? "" : "s"
        } needed`,
        tone: "warning",
        Icon: CloudIcon,
      };
    case "disabled":
      return {
        label: "History sync disabled",
        detail: status.configured ? "Configured but disabled" : "Not configured",
        tone: "idle",
        Icon: CloudIcon,
      };
  }
}

export function shouldShowHistorySyncTopbarStatus(
  status: HistorySyncStatus | null,
): status is HistorySyncStatus {
  if (!status) return false;
  return status.state !== "disabled" || status.configured;
}

export function getHistorySyncTopbarProgressPercent(status: HistorySyncStatus): number | null {
  if (status.state !== "syncing" || !status.progress) return null;
  return Math.min(
    100,
    Math.max(0, (status.progress.current / Math.max(1, status.progress.total)) * 100),
  );
}

export const HistorySyncTopbarStatus = memo(function HistorySyncTopbarStatus() {
  const navigate = useNavigate();
  const status = useServerConfig()?.historySync ?? null;
  const retryCountdown = useRetryCountdown(status);
  const [pendingReview, setPendingReview] = useState<HistorySyncPendingEventReview | null>(null);
  const [pendingReviewError, setPendingReviewError] = useState<string | null>(null);
  const [isLoadingPendingReview, setIsLoadingPendingReview] = useState(false);
  const [isRunningSync, setIsRunningSync] = useState(false);
  const summary = useMemo(
    () => (status ? getHistorySyncTopbarStatusSummary(status) : null),
    [status],
  );

  const loadPendingReview = useCallback(async () => {
    setIsLoadingPendingReview(true);
    setPendingReviewError(null);
    try {
      const next = await ensureLocalApi().server.getHistorySyncPendingEvents();
      setPendingReview(next);
    } catch (error) {
      setPendingReviewError(
        error instanceof Error ? error.message : "Failed to load pending sync events.",
      );
    } finally {
      setIsLoadingPendingReview(false);
    }
  }, []);

  const handleRunSync = useCallback(async () => {
    setIsRunningSync(true);
    try {
      await ensureLocalApi().server.runHistorySync();
      await loadPendingReview();
    } catch (error) {
      setPendingReviewError(error instanceof Error ? error.message : "Failed to run history sync.");
    } finally {
      setIsRunningSync(false);
    }
  }, [loadPendingReview]);

  if (!shouldShowHistorySyncTopbarStatus(status) || !summary) {
    return null;
  }

  const { Icon } = summary;
  const progressPercent = getHistorySyncTopbarProgressPercent(status);
  const progressRadius = 13;
  const progressCircumference = 2 * Math.PI * progressRadius;
  const progressOffset =
    progressPercent === null
      ? progressCircumference
      : progressCircumference * (1 - progressPercent / 100);
  const failures =
    status.state === "retrying"
      ? status.recentFailures
      : status.state === "error"
        ? (status.retry?.recentFailures ?? [])
        : [];

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) void loadPendingReview();
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  aria-label={summary.label}
                  className={cn(
                    "no-drag-region relative shrink-0",
                    summary.tone === "error" && "text-destructive",
                    summary.tone === "warning" && "text-amber-700",
                  )}
                  size="icon-xs"
                  variant="outline"
                >
                  {progressPercent !== null ? (
                    <svg
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-[-2px] size-[calc(100%+4px)] -rotate-90"
                      viewBox="0 0 30 30"
                    >
                      <circle
                        className="stroke-muted-foreground/15"
                        cx="15"
                        cy="15"
                        fill="none"
                        r={progressRadius}
                        strokeWidth="1.5"
                      />
                      <circle
                        className="stroke-foreground/55 transition-[stroke-dashoffset] duration-300"
                        cx="15"
                        cy="15"
                        fill="none"
                        r={progressRadius}
                        strokeDasharray={progressCircumference}
                        strokeDashoffset={progressOffset}
                        strokeLinecap="round"
                        strokeWidth="1.5"
                      />
                    </svg>
                  ) : null}
                  <Icon className={cn("size-3.5", summary.tone === "active" && "animate-spin")} />
                  {summary.tone === "error" || summary.tone === "warning" ? (
                    <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-current" />
                  ) : null}
                </Button>
              }
            />
          }
        />
        <TooltipPopup side="bottom">{summary.label}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" className="w-80 p-0" side="bottom">
        <div className="space-y-3 p-3">
          <div className="flex items-start gap-2">
            <Icon
              className={cn(
                "mt-0.5 size-4 shrink-0",
                summary.tone === "active" && "animate-spin",
                summary.tone === "error" && "text-destructive",
                summary.tone === "warning" && "text-amber-700",
              )}
            />
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">{summary.label}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{summary.detail}</div>
            </div>
          </div>

          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <span className="text-muted-foreground">Last sync</span>
            <span className="min-w-0 truncate text-foreground">
              {"lastSyncedAt" in status ? formatDateTime(status.lastSyncedAt) : "Never"}
            </span>
            {status.state === "syncing" ? (
              <>
                <span className="text-muted-foreground">Started</span>
                <span className="min-w-0 truncate text-foreground">
                  {formatDateTime(status.startedAt)}
                </span>
                {status.partial ? (
                  <>
                    <span className="text-muted-foreground">Threads</span>
                    <span className="min-w-0 truncate text-foreground">
                      {status.partial.loadedThreadCount}/{status.partial.totalThreadCount} loaded
                    </span>
                  </>
                ) : null}
              </>
            ) : null}
            {status.state === "retrying" ? (
              <>
                <span className="text-muted-foreground">Next retry</span>
                <span className="flex min-w-0 items-center gap-1 truncate text-foreground">
                  <ClockIcon className="size-3 shrink-0" />
                  {retryCountdown ? `in ${retryCountdown}` : formatDateTime(status.nextRetryAt)}
                </span>
                <span className="text-muted-foreground">First fail</span>
                <span className="min-w-0 truncate text-foreground">
                  {formatDateTime(status.firstFailedAt)}
                </span>
              </>
            ) : null}
            {status.state === "error" && status.retry ? (
              <>
                <span className="text-muted-foreground">Retries</span>
                <span className="text-foreground">
                  {status.retry.attempt}/{status.retry.maxAttempts} exhausted
                </span>
                <span className="text-muted-foreground">Final fail</span>
                <span className="min-w-0 truncate text-foreground">
                  {formatDateTime(status.retry.finalFailedAt)}
                </span>
              </>
            ) : null}
          </div>

          <div className="rounded-md border border-border/60 bg-muted/20 p-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-medium text-muted-foreground">Pending local events</div>
              <Button
                size="xs"
                variant="ghost"
                disabled={isLoadingPendingReview}
                onClick={() => void loadPendingReview()}
              >
                {isLoadingPendingReview ? "Loading..." : "Refresh"}
              </Button>
            </div>
            {pendingReview ? (
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <span className="text-muted-foreground">Total</span>
                <span className="text-foreground">{pendingReview.totalCount}</span>
                <span className="text-muted-foreground">Pushable</span>
                <span className="text-foreground">{pendingReview.pushableCount}</span>
                <span className="text-muted-foreground">Deferred</span>
                <span className="text-foreground">{pendingReview.deferredCount}</span>
                <span className="text-muted-foreground">Sequences</span>
                <span className="min-w-0 truncate text-foreground">
                  local {pendingReview.localMaxSequence} / remote {pendingReview.remoteMaxSequence}
                </span>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                {pendingReviewError ?? (isLoadingPendingReview ? "Loading..." : "Not loaded")}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={isRunningSync || status.state === "syncing"}
              onClick={() => void handleRunSync()}
            >
              {isRunningSync || status.state === "syncing" ? "Syncing..." : "Sync now"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void navigate({ to: "/settings/connections" })}
            >
              Settings
            </Button>
          </div>

          {failures.length > 0 ? (
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">Recent failures</div>
              <ScrollArea className="h-28 rounded-md border border-border bg-muted/20">
                <div className="space-y-2 p-2">
                  {failures.toReversed().map((failure) => (
                    <div key={`${failure.attempt}-${failure.failedAt}`} className="text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-foreground">
                          Attempt {failure.attempt}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {formatDateTime(failure.failedAt)}
                        </span>
                      </div>
                      <div className="mt-0.5 break-words text-muted-foreground">
                        {failure.message}
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
