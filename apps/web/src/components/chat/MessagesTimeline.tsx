import { type EnvironmentId, type MessageId, type ThreadId, type TurnId } from "@t3tools/contracts";
import { FileDiff } from "@pierre/diffs/react";
import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type WheelEvent,
  type TouchEvent,
  type PointerEvent,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  deriveTimelineEntries,
  formatElapsed,
  type ActiveTurnActivityState,
} from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  type LucideIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { MessageCopyButton } from "./MessageCopyButton";
import { WorkingDots } from "./WorkingDots";
import {
  computeStableMessagesTimelineRows,
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatTimestamp } from "../../timestampFormat";
import { useSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { isScrollViewportAtBottom } from "./scrollStickiness";
import {
  DIFF_RENDER_UNSAFE_CSS,
  INLINE_FILE_CHANGE_RUNNING_UNSAFE_CSS,
  getRenderablePatch,
  resolveFileDiffPath,
  resolveFileDiffMatchPaths,
  type RenderablePatch,
} from "../../lib/unifiedDiffRendering";

import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  debugFileChangeStream,
  useLiveCommandOutput,
  type LiveCommandOutputKey,
  type LiveCommandOutputSnapshot,
} from "../../liveCommandOutput";

// ---------------------------------------------------------------------------
// Context — shared state consumed by every row component via useContext.
// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded — self-ticking
// components such as LiveElapsed handle it.
// ---------------------------------------------------------------------------

interface TimelineRowSharedState {
  activeTurnInProgress: boolean;
  activeTurnId: TurnId | null | undefined;
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
  timestampFormat: TimestampFormat;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  activeThreadId: ThreadId;
  activeThreadEnvironmentId: EnvironmentId;
  turnDiffSummaryByTurnId: ReadonlyMap<TurnId, TurnDiffSummary>;
  inferredCheckpointTurnCountByTurnId: Readonly<Record<TurnId, number>>;
  onRevertUserMessage: (messageId: MessageId) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onPreserveViewportRequest?: ((anchor: HTMLElement, mutate: () => void) => void) | undefined;
  onOpenTurnDiff?: ((turnId: TurnId, filePath?: string) => void) | undefined;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnId?: TurnId | null;
  activeTurnStartedAt: string | null;
  activeTurnActivityState?: ActiveTurnActivityState | undefined;
  listRef: RefObject<LegendListRef | null>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  turnDiffSummaryByTurnId: Map<TurnId, TurnDiffSummary>;
  inferredCheckpointTurnCountByTurnId: Record<TurnId, number>;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenTurnDiff?: ((turnId: TurnId, filePath?: string) => void) | undefined;
  activeThreadId: ThreadId;
  activeThreadEnvironmentId: EnvironmentId;
  markdownCwd: string | undefined;
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  onScrollViewportChange?: ((scrollViewport: HTMLElement) => void) | undefined;
  onUserScrollAwayFromEnd?: (() => void) | undefined;
  onPreserveViewportRequest?: ((anchor: HTMLElement, mutate: () => void) => void) | undefined;
  suppressMaintainScrollAtEnd?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  isWorking,
  activeTurnInProgress,
  activeTurnId,
  activeTurnStartedAt,
  activeTurnActivityState,
  listRef,
  timelineEntries,
  completionDividerBeforeEntryId,
  turnDiffSummaryByAssistantMessageId,
  turnDiffSummaryByTurnId,
  inferredCheckpointTurnCountByTurnId,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  onOpenTurnDiff,
  activeThreadId,
  activeThreadEnvironmentId,
  markdownCwd,
  timestampFormat,
  workspaceRoot,
  onIsAtEndChange,
  onScrollViewportChange,
  onUserScrollAwayFromEnd,
  onPreserveViewportRequest,
  suppressMaintainScrollAtEnd = false,
}: MessagesTimelineProps) {
  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId,
        isWorking,
        activeTurnStartedAt,
        activeTurnActivityState,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
      }),
    [
      timelineEntries,
      completionDividerBeforeEntryId,
      isWorking,
      activeTurnStartedAt,
      activeTurnActivityState,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
    ],
  );
  const rows = useStableRows(rawRows);

  const handleScroll = useCallback(
    (event: unknown) => {
      const currentTarget =
        typeof event === "object" && event !== null && "currentTarget" in event
          ? event.currentTarget
          : null;
      if (currentTarget instanceof HTMLElement) {
        onScrollViewportChange?.(currentTarget);
      }

      const state = listRef.current?.getState?.();
      if (state?.isAtEnd) {
        onIsAtEndChange(state.isAtEnd);
      }
    },
    [listRef, onIsAtEndChange, onScrollViewportChange],
  );

  const releaseStickinessIfAwayFromEnd = useCallback(
    (scrollViewport: HTMLElement) => {
      if (!isScrollViewportAtBottom(scrollViewport)) {
        onUserScrollAwayFromEnd?.();
      }
    },
    [onUserScrollAwayFromEnd],
  );

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLElement>) => {
      if (event.deltaY < 0) {
        onUserScrollAwayFromEnd?.();
        return;
      }
      releaseStickinessIfAwayFromEnd(event.currentTarget);
    },
    [onUserScrollAwayFromEnd, releaseStickinessIfAwayFromEnd],
  );

  const touchStartYRef = useRef<number | null>(null);
  const handleTouchStart = useCallback((event: TouchEvent<HTMLElement>) => {
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMove = useCallback(
    (event: TouchEvent<HTMLElement>) => {
      const nextY = event.touches[0]?.clientY;
      if (
        touchStartYRef.current !== null &&
        nextY !== undefined &&
        nextY > touchStartYRef.current
      ) {
        onUserScrollAwayFromEnd?.();
        return;
      }
      releaseStickinessIfAwayFromEnd(event.currentTarget);
    },
    [onUserScrollAwayFromEnd, releaseStickinessIfAwayFromEnd],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (event.currentTarget === event.target) {
        releaseStickinessIfAwayFromEnd(event.currentTarget);
      }
    },
    [releaseStickinessIfAwayFromEnd],
  );

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      releaseStickinessIfAwayFromEnd(event.currentTarget);
    },
    [releaseStickinessIfAwayFromEnd],
  );

  const previousRowCountRef = useRef(rows.length);
  useEffect(() => {
    const previousRowCount = previousRowCountRef.current;
    previousRowCountRef.current = rows.length;

    if (previousRowCount > 0 || rows.length === 0) {
      return;
    }

    onIsAtEndChange(true);
    const frameId = window.requestAnimationFrame(() => {
      void listRef.current?.scrollToEnd?.({ animated: false });
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [listRef, onIsAtEndChange, rows.length]);

  const autoScrollContentKey = useMemo(() => buildTimelineAutoScrollContentKey(rows), [rows]);
  const previousAutoScrollContentKeyRef = useRef(autoScrollContentKey);
  useEffect(() => {
    const previousAutoScrollContentKey = previousAutoScrollContentKeyRef.current;
    previousAutoScrollContentKeyRef.current = autoScrollContentKey;

    if (
      previousAutoScrollContentKey === autoScrollContentKey ||
      rows.length === 0 ||
      suppressMaintainScrollAtEnd
    ) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      void listRef.current?.scrollToEnd?.({ animated: false });
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [autoScrollContentKey, listRef, rows.length, suppressMaintainScrollAtEnd]);

  // Memoised context value — only changes on state transitions, NOT on
  // every streaming chunk. Callbacks from ChatView are useCallback-stable.
  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      activeTurnInProgress,
      activeTurnId: activeTurnId ?? null,
      isWorking,
      isRevertingCheckpoint,
      timestampFormat,
      markdownCwd,
      workspaceRoot,
      activeThreadId,
      activeThreadEnvironmentId,
      turnDiffSummaryByTurnId,
      inferredCheckpointTurnCountByTurnId,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
      onPreserveViewportRequest,
    }),
    [
      activeTurnInProgress,
      activeTurnId,
      isWorking,
      isRevertingCheckpoint,
      timestampFormat,
      markdownCwd,
      workspaceRoot,
      activeThreadId,
      activeThreadEnvironmentId,
      turnDiffSummaryByTurnId,
      inferredCheckpointTurnCountByTurnId,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
      onPreserveViewportRequest,
    ],
  );

  // Stable renderItem — no closure deps. Row components read shared state
  // from TimelineRowCtx, which propagates through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden" data-timeline-root="true">
        <TimelineRowContent row={item} />
      </div>
    ),
    [],
  );

  if (rows.length === 0 && !isWorking) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <TimelineRowCtx.Provider value={sharedState}>
      <LegendList<MessagesTimelineRow>
        ref={listRef}
        data={rows}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        estimatedItemSize={90}
        initialScrollAtEnd
        maintainScrollAtEnd={!suppressMaintainScrollAtEnd}
        maintainScrollAtEndThreshold={0.1}
        maintainVisibleContentPosition
        onScroll={handleScroll}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        data-chat-messages-scroll="true"
        className="h-full overflow-x-hidden overscroll-y-contain px-3 sm:px-5"
        ListHeaderComponent={<div className="h-3 sm:h-4" />}
        ListFooterComponent={<div className="h-3 sm:h-4" />}
      />
    </TimelineRowCtx.Provider>
  );
});

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

function buildTimelineAutoScrollContentKey(rows: ReadonlyArray<MessagesTimelineRow>): string {
  return rows
    .map((row) => {
      switch (row.kind) {
        case "message":
          return [
            row.id,
            row.kind,
            row.message.text.length,
            row.message.streaming ? "streaming" : "settled",
            row.message.completedAt ?? "",
          ].join(":");
        case "proposed-plan":
          return [
            row.id,
            row.kind,
            row.proposedPlan.planMarkdown.length,
            row.proposedPlan.implementedAt ?? "",
            row.proposedPlan.implementationThreadId ?? "",
          ].join(":");
        case "separator":
          return [row.id, row.kind, row.label].join(":");
        case "work":
          return [
            row.id,
            row.kind,
            row.groupedEntries.length,
            ...row.groupedEntries.map((entry) =>
              [
                entry.id,
                entry.status ?? "",
                entry.label,
                entry.detail ?? "",
                entry.outputPreview?.lines.length ?? 0,
                entry.outputPreview?.truncated ? "truncated" : "full",
              ].join(":"),
            ),
          ].join("|");
        case "working":
          return [
            row.id,
            row.kind,
            row.activityState.kind,
            row.activityState.label,
            row.activityState.detail ?? "",
          ].join(":");
      }
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// TimelineRowContent — the actual row component
// ---------------------------------------------------------------------------

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

function TimelineRowContent({ row }: { row: TimelineRow }) {
  const ctx = use(TimelineRowCtx);

  return (
    <div
      className={cn(
        "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" && (
        <WorkGroupSection
          groupedEntries={row.groupedEntries}
          activityGroupKind={row.activityGroupKind}
        />
      )}

      {row.kind === "separator" && (
        <div className="flex items-center gap-3 py-2 text-muted-foreground text-xs">
          <div className="h-px flex-1 bg-border/70" />
          <span className="shrink-0 rounded-full border border-border/70 bg-background px-2 py-0.5">
            {row.label}
          </span>
          <div className="h-px flex-1 bg-border/70" />
        </div>
      )}

      {row.kind === "message" &&
        row.message.role === "user" &&
        (() => {
          const userImages = row.message.attachments ?? [];
          const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
          const terminalContexts = displayedUserMessage.contexts;
          const canRevertAgentWork = typeof row.revertTurnCount === "number";
          return (
            <div className="flex justify-end">
              <div className="group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
                {userImages.length > 0 && (
                  <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
                    {userImages.map(
                      (image: NonNullable<TimelineMessage["attachments"]>[number]) => (
                        <div
                          key={image.id}
                          className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
                        >
                          {image.previewUrl ? (
                            <button
                              type="button"
                              className="h-full w-full cursor-zoom-in"
                              aria-label={`Preview ${image.name}`}
                              onClick={() => {
                                const preview = buildExpandedImagePreview(userImages, image.id);
                                if (!preview) return;
                                ctx.onImageExpand(preview);
                              }}
                            >
                              <img
                                src={image.previewUrl}
                                alt={image.name}
                                className="block h-auto max-h-[220px] w-full object-cover"
                              />
                            </button>
                          ) : (
                            <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                              {image.name}
                            </div>
                          )}
                        </div>
                      ),
                    )}
                  </div>
                )}
                {(displayedUserMessage.visibleText.trim().length > 0 ||
                  terminalContexts.length > 0) && (
                  <UserMessageBody
                    text={displayedUserMessage.visibleText}
                    terminalContexts={terminalContexts}
                  />
                )}
                <div className="mt-1.5 flex items-center justify-end gap-2">
                  <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                    {displayedUserMessage.copyText && (
                      <MessageCopyButton text={displayedUserMessage.copyText} />
                    )}
                    {canRevertAgentWork && (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={ctx.isRevertingCheckpoint || ctx.isWorking}
                        onClick={() => ctx.onRevertUserMessage(row.message.id)}
                        title="Revert to this message"
                      >
                        <Undo2Icon className="size-3" />
                      </Button>
                    )}
                  </div>
                  <p className="text-right text-xs text-muted-foreground/50">
                    {formatTimestamp(row.message.createdAt, ctx.timestampFormat)}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "assistant" &&
        (() => {
          const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
          const assistantTurnStillInProgress =
            ctx.activeTurnInProgress &&
            ctx.activeTurnId !== null &&
            ctx.activeTurnId !== undefined &&
            row.message.turnId === ctx.activeTurnId;
          const assistantCopyState = resolveAssistantMessageCopyState({
            text: row.message.text ?? null,
            showCopyButton: row.showAssistantCopyButton,
            streaming: row.message.streaming || assistantTurnStillInProgress,
          });
          return (
            <>
              {row.showCompletionDivider && (
                <div className="my-3 flex items-center gap-3">
                  <span className="h-px flex-1 bg-border" />
                  <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
                    Response
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              <div className="min-w-0 px-1 py-0.5">
                <ChatMarkdown
                  text={messageText}
                  cwd={ctx.markdownCwd}
                  isStreaming={Boolean(row.message.streaming)}
                />
                <div className="mt-1.5 flex items-center gap-2">
                  <p className="text-[10px] text-muted-foreground/30">
                    {row.message.streaming ? (
                      <LiveMessageMeta
                        createdAt={row.message.createdAt}
                        durationStart={row.durationStart}
                        timestampFormat={ctx.timestampFormat}
                      />
                    ) : (
                      formatMessageMeta(
                        row.message.createdAt,
                        formatElapsed(row.durationStart, row.message.completedAt),
                        ctx.timestampFormat,
                      )
                    )}
                  </p>
                  {assistantCopyState.visible ? (
                    <div className="flex items-center opacity-0 transition-opacity duration-200  group-hover/assistant:opacity-100">
                      <MessageCopyButton
                        text={assistantCopyState.text ?? ""}
                        size="icon-xs"
                        variant="outline"
                        className="border-border/50 bg-background/35 text-muted-foreground/45 shadow-none hover:border-border/70 hover:bg-background/55 hover:text-muted-foreground/70"
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          );
        })()}

      {row.kind === "proposed-plan" && (
        <div className="min-w-0 px-1 py-0.5">
          <ProposedPlanCard
            planMarkdown={row.proposedPlan.planMarkdown}
            isStreaming={row.proposedPlan.streaming === true}
            environmentId={ctx.activeThreadEnvironmentId}
            cwd={ctx.markdownCwd}
            workspaceRoot={ctx.workspaceRoot}
            onToggleExpanded={ctx.onPreserveViewportRequest}
          />
        </div>
      )}

      {row.kind === "working" && (
        <div className="py-0.5 pl-1.5">
          <div className="flex min-h-4 items-center gap-2 pt-1 text-[11px] leading-4 text-muted-foreground/70">
            <span>{row.activityState.label}</span>
            {ctx.isWorking ? <WorkingDots className="text-muted-foreground/55" /> : null}
          </div>
          <div
            className={cn(
              "min-h-4 max-w-full truncate pt-0.5 text-[11px] leading-4 text-muted-foreground/45",
              !row.activityState.detail && "invisible",
            )}
            data-testid="working-activity-detail"
            aria-hidden={row.activityState.detail ? undefined : true}
          >
            {row.activityState.detail ?? "\u00a0"}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-ticking components — bypass LegendList memoisation entirely.
// Each owns a `nowMs` state value consumed in the render output so the
// React Compiler cannot elide the re-render as a no-op.
// ---------------------------------------------------------------------------

/** Live timestamp + elapsed duration for a streaming assistant message. */
function LiveMessageMeta({
  createdAt,
  durationStart,
  timestampFormat,
}: {
  createdAt: string;
  durationStart: string | null | undefined;
  timestampFormat: TimestampFormat;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [durationStart]);
  const elapsed = durationStart
    ? formatElapsed(durationStart, new Date(nowMs).toISOString())
    : null;
  return <>{formatMessageMeta(createdAt, elapsed, timestampFormat)}</>;
}

// ---------------------------------------------------------------------------
// Extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

/** Owns its own expand/collapse state so toggling re-renders only this row.
 *  State resets on unmount which is fine — work groups start collapsed. */
const WorkGroupSection = memo(function WorkGroupSection({
  groupedEntries,
  activityGroupKind,
}: {
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
  activityGroupKind: Extract<MessagesTimelineRow, { kind: "work" }>["activityGroupKind"];
}) {
  const { workspaceRoot } = use(TimelineRowCtx);
  const [isExpanded, setIsExpanded] = useState(false);
  const [activityGroupExpanded, setActivityGroupExpanded] = useState(false);
  const [expandedOutputKeys, setExpandedOutputKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [expandedInlineDiffKeys, setExpandedInlineDiffKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [collapsedDefaultOutputKeys, setCollapsedDefaultOutputKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [collapsedDefaultInlineDiffKeys, setCollapsedDefaultInlineDiffKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    hasOverflow && !isExpanded
      ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
      : groupedEntries;
  const hiddenCount = groupedEntries.length - visibleEntries.length;
  const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
  const onlyTerminalEntries = groupedEntries.every(isTerminalWorkEntry);
  const showHeader = activityGroupKind === "validation" || hasOverflow || !onlyToolEntries;
  const groupLabel =
    activityGroupKind === "validation"
      ? "Validation"
      : onlyTerminalEntries
        ? "Terminal"
        : onlyToolEntries
          ? "Tool calls"
          : "Work log";
  const activityStatus = workActivityGroupStatus(groupedEntries);
  const toggleOutputExpanded = useCallback((key: string, defaultExpanded: boolean) => {
    if (defaultExpanded) {
      setCollapsedDefaultOutputKeys((current) => {
        const next = new Set(current);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
      return;
    }
    setExpandedOutputKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);
  const toggleInlineDiffExpanded = useCallback((key: string, defaultExpanded: boolean) => {
    if (defaultExpanded) {
      setCollapsedDefaultInlineDiffKeys((current) => {
        const next = new Set(current);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
      return;
    }
    setExpandedInlineDiffKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  if (activityGroupKind === "exploration") {
    const isExploring = activityStatus === "running";
    return (
      <div className="px-0.5 py-0.5">
        <button
          type="button"
          className="group flex min-h-7 w-full items-center gap-1.5 rounded-lg px-1 py-0.5 text-left transition-colors duration-150 hover:bg-muted/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45"
          aria-expanded={activityGroupExpanded}
          onClick={() => setActivityGroupExpanded((value) => !value)}
          data-testid="exploration-group-toggle"
        >
          <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/55">
            <EyeIcon className="size-3" />
          </span>
          <span className="min-w-0 truncate text-[11px] leading-5 text-muted-foreground/80">
            Exploring
          </span>
          {isExploring ? <WorkingDots className="text-muted-foreground/55" /> : null}
          <span className="min-w-0 flex-1" />
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/45 opacity-0 transition-[opacity,transform,color] duration-150 group-hover:opacity-100 group-hover:text-muted-foreground/80 group-focus-visible:opacity-100",
              activityGroupExpanded && "rotate-90",
            )}
          />
        </button>
        {activityGroupExpanded && (
          <div className="mt-1 space-y-0.5">
            {groupedEntries.map((workEntry) => (
              <SimpleWorkEntryRow
                key={`work-row:${workEntry.id}`}
                workEntry={workEntry}
                workspaceRoot={workspaceRoot}
                outputExpanded={expandedOutputKeys.has(workEntryToolKey(workEntry))}
                defaultOutputCollapsed={collapsedDefaultOutputKeys.has(workEntryToolKey(workEntry))}
                defaultInlineDiffCollapsed={collapsedDefaultInlineDiffKeys.has(
                  workEntryToolKey(workEntry),
                )}
                onToggleOutputExpanded={toggleOutputExpanded}
                inlineDiffExpanded={expandedInlineDiffKeys.has(workEntryToolKey(workEntry))}
                onToggleInlineDiffExpanded={toggleInlineDiffExpanded}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
      {showHeader && (
        <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
          <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
            {groupLabel} ({groupedEntries.length})
          </p>
          {hasOverflow && (
            <button
              type="button"
              className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
              onClick={() => setIsExpanded((v) => !v)}
            >
              {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
            </button>
          )}
        </div>
      )}
      <div className="space-y-0.5">
        {visibleEntries.map((workEntry) => (
          <SimpleWorkEntryRow
            key={`work-row:${workEntry.id}`}
            workEntry={workEntry}
            workspaceRoot={workspaceRoot}
            outputExpanded={expandedOutputKeys.has(workEntryToolKey(workEntry))}
            defaultOutputCollapsed={collapsedDefaultOutputKeys.has(workEntryToolKey(workEntry))}
            defaultInlineDiffCollapsed={collapsedDefaultInlineDiffKeys.has(
              workEntryToolKey(workEntry),
            )}
            onToggleOutputExpanded={toggleOutputExpanded}
            inlineDiffExpanded={expandedInlineDiffKeys.has(workEntryToolKey(workEntry))}
            onToggleInlineDiffExpanded={toggleInlineDiffExpanded}
          />
        ))}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
}) {
  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            <span key={`user-terminal-context-inline-before:${context.header}:${cursor}`}>
              {props.text.slice(cursor, matchIndex)}
            </span>,
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            <span key={`user-message-terminal-context-inline-rest:${cursor}`}>
              {props.text.slice(cursor)}
            </span>,
          );
        }

        return (
          <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(<span key="user-message-terminal-context-inline-text">{props.text}</span>);
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
      {props.text}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Structural sharing — reuse old row references when data hasn't changed
// so LegendList (and React) can skip re-rendering unchanged items.
// ---------------------------------------------------------------------------

/** Returns a structurally-shared copy of `rows`: for each row whose content
 *  hasn't changed since last call, the previous object reference is reused. */
function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const prevState = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });

  return useMemo(() => {
    const nextState = computeStableMessagesTimelineRows(rows, prevState.current);
    prevState.current = nextState;
    return nextState.result;
  }, [rows]);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat);
  return `${formatTimestamp(createdAt, timestampFormat)} • ${duration}`;
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-foreground/92",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground/92",
  };
}

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
  workspaceRoot: string | undefined,
) {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
}

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function isTerminalWorkEntry(workEntry: Pick<TimelineWorkEntry, "command" | "itemType">): boolean {
  return workEntry.itemType === "command_execution" || Boolean(workEntry.command);
}

function terminalPrimaryLabel(workEntry: Pick<TimelineWorkEntry, "command">): string {
  return workEntry.command?.trim() || "Ran command";
}

function terminalCopyCommand(workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">): string {
  return workEntry.rawCommand?.trim() || workEntry.command?.trim() || "Ran command";
}

function shouldAutoShowTerminalOutput(
  workEntry: TimelineWorkEntry,
  liveOutput: LiveCommandOutputSnapshot,
): boolean {
  if (liveOutput.text.length > 0) {
    return true;
  }
  const outputPreview = workEntry.outputPreview;
  if (workEntry.status === "running" && workEntry.toolCallId) {
    return true;
  }
  if (!outputPreview || outputPreview.lines.length === 0) {
    return false;
  }
  return workEntry.status === "failed" || workEntry.status === "running";
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return TerminalIcon;
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return WrenchIcon;
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return HammerIcon;
  }

  return workToneIcon(workEntry.tone).icon;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

function commandOutputPreviewLabel(workEntry: TimelineWorkEntry): string | null {
  switch (workEntry.outputPreview?.stream) {
    case "stderr":
      return "stderr";
    case "mixed":
      return "mixed";
    case "unknown":
      return "last output";
    case "stdout":
    default:
      return "last output";
  }
}

function isManagedFailedEdit(workEntry: TimelineWorkEntry): boolean {
  return (
    workEntry.status === "failed" &&
    workEntry.itemType === "file_change" &&
    workEntry.failure?.kind === "apply_patch_verification_failed"
  );
}

function workEntryToolKey(workEntry: TimelineWorkEntry): string {
  return workEntry.toolKey ?? workEntry.toolCallId ?? workEntry.id;
}

function terminalStatusLabel(workEntry: Pick<TimelineWorkEntry, "status">): string {
  if (workEntry.status === "failed") return "Failed";
  if (workEntry.status === "completed") return "Completed";
  return "Running";
}

function terminalStatusClass(workEntry: Pick<TimelineWorkEntry, "status">): string {
  if (workEntry.status === "failed") {
    return "border-destructive/25 bg-destructive/8 text-destructive/80";
  }
  if (workEntry.status === "completed") {
    return "border-border/50 bg-muted/35 text-muted-foreground/80";
  }
  return "border-primary/20 bg-primary/8 text-primary/80";
}

function workActivityGroupStatus(
  entries: ReadonlyArray<Pick<TimelineWorkEntry, "status">>,
): TimelineWorkEntry["status"] | undefined {
  if (entries.some((entry) => entry.status === "failed")) return "failed";
  if (entries.some((entry) => entry.status === "running")) return "running";
  if (entries.length > 0 && entries.every((entry) => entry.status === "completed")) {
    return "completed";
  }
  return undefined;
}

const ToolOutputPreview = memo(function ToolOutputPreview(props: {
  workEntry: TimelineWorkEntry;
  liveOutput: LiveCommandOutputSnapshot;
}) {
  const { workEntry } = props;
  const liveOutput = props.liveOutput;
  const liveOutputVersion = liveOutput.version;
  const outputPreview = workEntry.outputPreview;
  const outputPreviewLabel = commandOutputPreviewLabel(workEntry);
  const outputIsError = outputPreview?.stream === "stderr";
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const outputText =
    liveOutput.text.length > 0 ? liveOutput.text : (outputPreview?.lines.join("\n") ?? "");
  const outputTruncated =
    liveOutput.text.length > 0 ? liveOutput.truncated : outputPreview?.truncated;

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !stickToBottomRef.current) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [liveOutputVersion, outputPreview?.lines, outputPreview?.truncated]);

  const handleScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= 4;
  }, []);

  return (
    <div className="pl-7 pr-1 pb-1">
      {outputPreviewLabel && (
        <div className="mb-1 font-mono text-[9px] leading-3 text-muted-foreground/55">
          {outputPreviewLabel}
        </div>
      )}
      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        className={cn(
          "h-28 max-w-full overflow-auto rounded-md border px-2 py-1 font-mono text-[11px] leading-4 whitespace-pre [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar]:w-1.5",
          outputIsError
            ? "border-destructive/25 bg-destructive/5 text-destructive/85"
            : "border-border/45 bg-muted/20 text-muted-foreground/85",
        )}
        data-testid="tool-output-preview"
      >
        <pre className="m-0 min-w-max font-inherit leading-inherit whitespace-pre">
          {outputText}
          {outputTruncated ? "\n[output truncated]" : ""}
        </pre>
      </div>
    </div>
  );
});

const ManagedFailedEditPreview = memo(function ManagedFailedEditPreview(props: {
  workEntry: TimelineWorkEntry;
}) {
  const failure = props.workEntry.failure;
  const expectedContent = failure?.expectedContent;
  const actualContentExcerpt = failure?.actualContentExcerpt;
  const attemptedPatch = failure?.attemptedPatch;
  if (!expectedContent && !actualContentExcerpt && !attemptedPatch) {
    return null;
  }
  const actualLabel =
    failure?.actualContentExcerptStartLine !== undefined &&
    failure.actualContentExcerptEndLine !== undefined
      ? `actual file lines ${failure.actualContentExcerptStartLine}-${failure.actualContentExcerptEndLine}`
      : "actual file snapshot";
  return (
    <div className="space-y-2 pl-7 pr-1 pb-1">
      {expectedContent && (
        <div>
          <div className="mb-1 font-mono text-[9px] leading-3 text-muted-foreground/55">
            expected content
            {failure?.expectedContentFound === false ? " (not found)" : ""}
          </div>
          <div
            className="max-h-56 overflow-auto rounded-md border border-destructive/25 bg-destructive/5 px-2 py-1 font-mono text-[11px] leading-4 text-destructive/85"
            data-testid="managed-failed-edit-preview"
          >
            <pre className="m-0 min-w-max font-inherit leading-inherit whitespace-pre">
              {expectedContent}
            </pre>
          </div>
        </div>
      )}
      {actualContentExcerpt && (
        <div>
          <div className="mb-1 font-mono text-[9px] leading-3 text-muted-foreground/55">
            {actualLabel}
            {failure?.actualContentExcerptTruncated ? " (excerpt)" : ""}
          </div>
          <div
            className="max-h-56 overflow-auto rounded-md border border-border/45 bg-muted/20 px-2 py-1 font-mono text-[11px] leading-4 text-muted-foreground/85"
            data-testid="managed-failed-edit-actual-preview"
          >
            <pre className="m-0 min-w-max font-inherit leading-inherit whitespace-pre">
              {actualContentExcerpt}
            </pre>
          </div>
        </div>
      )}
      {attemptedPatch && (
        <div>
          <div className="mb-1 font-mono text-[9px] leading-3 text-muted-foreground/55">
            attempted patch
          </div>
          <div
            className="max-h-56 overflow-auto rounded-md border border-border/45 bg-muted/20 px-2 py-1 font-mono text-[11px] leading-4 text-muted-foreground/85"
            data-testid="managed-failed-edit-attempt-preview"
          >
            <pre className="m-0 min-w-max font-inherit leading-inherit whitespace-pre">
              {attemptedPatch}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
});

const LIVE_FILE_CHANGE_RENDER_THROTTLE_MS = 120;

function useThrottledLiveFileChangeText(text: string, throttle: boolean): string {
  const [throttledText, setThrottledText] = useState(text);
  const pendingTextRef = useRef(text);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommitAtRef = useRef(0);

  useEffect(() => {
    pendingTextRef.current = text;

    const clearPendingTimeout = () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };

    const commit = () => {
      timeoutRef.current = null;
      lastCommitAtRef.current = Date.now();
      setThrottledText(pendingTextRef.current);
    };

    if (!throttle || typeof window === "undefined") {
      clearPendingTimeout();
      commit();
      return clearPendingTimeout;
    }

    const elapsedMs = Date.now() - lastCommitAtRef.current;
    if (elapsedMs >= LIVE_FILE_CHANGE_RENDER_THROTTLE_MS) {
      clearPendingTimeout();
      commit();
      return clearPendingTimeout;
    }

    if (timeoutRef.current === null) {
      timeoutRef.current = setTimeout(commit, LIVE_FILE_CHANGE_RENDER_THROTTLE_MS - elapsedMs);
    }

    return clearPendingTimeout;
  }, [text, throttle]);

  return throttledText;
}

function isCompleteLiveUnifiedPatchForDiffRenderer(text: string): boolean {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized.includes("diff --git ")) {
    return false;
  }

  for (const line of normalized.split("\n")) {
    if (!line.startsWith("@@")) {
      continue;
    }
    if (!/^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@(?:\s.*)?$/u.test(line)) {
      return false;
    }
  }

  return true;
}

function normalizeLiveUnifiedPatchForDiffRenderer(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
  if (!normalized.includes("diff --git ")) {
    return normalized;
  }
  const blocks = normalized.split(/(?=^diff --git )/mu).filter((block) => block.trim().length > 0);
  return blocks.map(normalizeLiveUnifiedPatchFileBlock).join("\n");
}

function normalizeLiveUnifiedPatchFileBlock(block: string): string {
  const lines = block.split("\n");
  const changeType = lines.some((line) => line === "new file mode 100644")
    ? "add"
    : lines.some((line) => line === "deleted file mode 100644")
      ? "delete"
      : null;
  if (changeType === null) {
    return block;
  }

  const headerEndIndex = lines.findIndex((line) => line.startsWith("+++ "));
  if (headerEndIndex < 0 || headerEndIndex >= lines.length - 1) {
    return block;
  }

  const headerLines = lines.slice(0, headerEndIndex + 1);
  const bodyLines = lines.slice(headerEndIndex + 1);
  const explicitHunkIndex = bodyLines.findIndex((line) => line.startsWith("@@"));
  if (explicitHunkIndex >= 0) {
    const normalizedBody = bodyLines.map((line) =>
      line.startsWith("@@") ? line : normalizeWholeFilePatchBodyLine(line, changeType),
    );
    return [...headerLines, ...normalizedBody].join("\n");
  }

  const hunkHeader =
    changeType === "add"
      ? `@@ -0,0 +1,${Math.max(bodyLines.length, 1)} @@`
      : `@@ -1,${Math.max(bodyLines.length, 1)} +0,0 @@`;
  return [
    ...headerLines,
    hunkHeader,
    ...bodyLines.map((line) => normalizeWholeFilePatchBodyLine(line, changeType)),
  ].join("\n");
}

function normalizeWholeFilePatchBodyLine(line: string, changeType: "add" | "delete"): string {
  if (line.startsWith("\\ No newline at end of file")) {
    return line;
  }
  if (changeType === "add") {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return line;
    }
    return `+${line.startsWith(" ") ? line.slice(1) : line}`;
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return line;
  }
  return `-${line.startsWith(" ") ? line.slice(1) : line}`;
}

function detectSingleDeletedFilePatchPath(text: string): string | null {
  const normalizedText = normalizeLiveUnifiedPatchForDiffRenderer(text);
  if (!isCompleteLiveUnifiedPatchForDiffRenderer(normalizedText)) {
    return null;
  }

  const blocks = normalizedText
    .split(/(?=^diff --git )/mu)
    .filter((block) => block.trim().length > 0);
  if (blocks.length !== 1) {
    return null;
  }

  const lines = blocks[0]?.split("\n") ?? [];
  const isDeletedFile = lines.some((line) => /^deleted file mode \d+$/u.test(line));
  const oldPath = lines
    .find((line) => line.startsWith("--- "))
    ?.slice(4)
    .trim();
  const newPath = lines
    .find((line) => line.startsWith("+++ "))
    ?.slice(4)
    .trim();
  if (!isDeletedFile || newPath !== "/dev/null" || !oldPath || oldPath === "/dev/null") {
    return null;
  }

  const deletedPath =
    oldPath.startsWith("a/") || oldPath.startsWith("b/") ? oldPath.slice(2) : oldPath;
  return normalizeDiffMatchPath(deletedPath);
}

function extractFirstLiveDiffPath(text: string): string | null {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const line of normalized.split("\n")) {
    if (line.startsWith("+++ ")) {
      const pathValue = line.slice(4).trim();
      if (pathValue && pathValue !== "/dev/null") {
        return normalizeDiffMatchPath(pathValue);
      }
    }
    if (line.startsWith("--- ")) {
      const pathValue = line.slice(4).trim();
      if (pathValue && pathValue !== "/dev/null") {
        return normalizeDiffMatchPath(pathValue);
      }
    }
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git\s+a\/(.+?)\s+b\/(.+)$/u.exec(line);
      const pathValue = match?.[2] ?? match?.[1];
      if (pathValue) {
        return normalizeDiffMatchPath(pathValue);
      }
    }
  }
  return null;
}

function resolveInlineFileChangeHeaderPath(
  changedFiles: ReadonlyArray<string>,
  workspaceRoot: string | undefined,
  liveText: string,
): string {
  const firstChangedFile = changedFiles[0];
  if (firstChangedFile) {
    return formatWorkspaceRelativePath(firstChangedFile, workspaceRoot);
  }
  return extractFirstLiveDiffPath(liveText) ?? "File change";
}

function getRenderableLiveFileChangePatch(
  text: string,
  cacheScope: string,
): RenderablePatch | null {
  if (!text.trim()) {
    return null;
  }
  const normalizedText = normalizeLiveUnifiedPatchForDiffRenderer(text);
  if (!isCompleteLiveUnifiedPatchForDiffRenderer(normalizedText)) {
    return {
      kind: "raw",
      text: normalizedText,
      reason: "Waiting for complete patch metadata.",
    };
  }
  return getRenderablePatch(normalizedText, cacheScope);
}

const MAX_STABLE_INLINE_FILE_CHANGE_PATCHES = 200;
const stableInlineFileChangePatches = new Map<string, RenderablePatch>();

function rememberStableInlineFileChangePatch(cacheKey: string, patch: RenderablePatch) {
  stableInlineFileChangePatches.delete(cacheKey);
  stableInlineFileChangePatches.set(cacheKey, patch);
  while (stableInlineFileChangePatches.size > MAX_STABLE_INLINE_FILE_CHANGE_PATCHES) {
    const oldestKey = stableInlineFileChangePatches.keys().next().value;
    if (!oldestKey) break;
    stableInlineFileChangePatches.delete(oldestKey);
  }
}

function useStableRenderableLiveFileChangePatch({
  text,
  running,
  resolvedTheme,
  stableCacheKey,
}: {
  text: string;
  running: boolean;
  resolvedTheme: string;
  stableCacheKey?: string | undefined;
}): RenderablePatch | null {
  const throttledText = useThrottledLiveFileChangeText(text, running);
  const patchCacheKey = stableCacheKey
    ? `inline-file-change:${stableCacheKey}:${resolvedTheme}`
    : null;
  const lastValidPatchRef = useRef<RenderablePatch | null>(
    patchCacheKey ? (stableInlineFileChangePatches.get(patchCacheKey) ?? null) : null,
  );
  const renderText = running ? throttledText : text;
  const currentPatch = useMemo(
    () =>
      getRenderableLiveFileChangePatch(
        renderText,
        patchCacheKey ?? `inline-file-change:${resolvedTheme}`,
      ),
    [renderText, patchCacheKey, resolvedTheme],
  );

  if (currentPatch?.kind === "files") {
    lastValidPatchRef.current = currentPatch;
    if (patchCacheKey) {
      rememberStableInlineFileChangePatch(patchCacheKey, currentPatch);
    }
    return currentPatch;
  }

  return (
    lastValidPatchRef.current ??
    (patchCacheKey ? (stableInlineFileChangePatches.get(patchCacheKey) ?? null) : null) ??
    currentPatch
  );
}

const LiveFileChangePreview = memo(function LiveFileChangePreview(props: {
  liveOutput: LiveCommandOutputSnapshot;
  running: boolean;
  expanded: boolean;
  changedFiles?: ReadonlyArray<string> | undefined;
  workspaceRoot?: string | undefined;
  standalone?: boolean | undefined;
  stablePatchCacheKey?: string | undefined;
  onToggleExpanded?: (() => void) | undefined;
  onOpenSelectedFileDiff?: ((filePath: string) => void) | undefined;
}) {
  const {
    liveOutput,
    running,
    expanded,
    changedFiles = [],
    workspaceRoot,
    standalone,
    stablePatchCacheKey,
    onToggleExpanded,
    onOpenSelectedFileDiff,
  } = props;
  const { resolvedTheme } = useTheme();
  const settings = useSettings();
  const containerClassName = standalone ? "pb-1" : "pl-7 pr-1 pb-1";
  const renderablePatch = useStableRenderableLiveFileChangePatch({
    text: liveOutput.text,
    running,
    resolvedTheme,
    stableCacheKey: stablePatchCacheKey,
  });
  const requestedPaths = useMemo(
    () => changedFiles.map((filePath) => normalizeDiffMatchPath(filePath, workspaceRoot)),
    [changedFiles, workspaceRoot],
  );
  const deletedFilePath = useMemo(
    () => detectSingleDeletedFilePatchPath(liveOutput.text),
    [liveOutput.text],
  );
  const headerFilePath = useMemo(
    () => resolveInlineFileChangeHeaderPath(changedFiles, workspaceRoot, liveOutput.text),
    [changedFiles, liveOutput.text, workspaceRoot],
  );
  const selectedFileDiff = useMemo(() => {
    if (renderablePatch?.kind !== "files") {
      return null;
    }
    if (requestedPaths.length === 0) {
      return renderablePatch.files[0] ?? null;
    }
    const fileDiffByPath = new Map<string, (typeof renderablePatch.files)[number]>();
    for (const fileDiff of renderablePatch.files) {
      for (const filePath of resolveFileDiffMatchPaths(fileDiff)) {
        fileDiffByPath.set(normalizeDiffMatchPath(filePath, workspaceRoot), fileDiff);
      }
    }
    for (const requestedPath of requestedPaths) {
      const fileDiff = fileDiffByPath.get(requestedPath);
      if (fileDiff) {
        return fileDiff;
      }
    }
    return renderablePatch.files[0] ?? null;
  }, [renderablePatch, requestedPaths, workspaceRoot]);
  useEffect(() => {
    debugFileChangeStream("preview-render", {
      sourceLength: liveOutput.text.length,
      version: liveOutput.version,
      updatedAt: liveOutput.updatedAt,
      running,
      expanded,
      renderableKind: renderablePatch?.kind ?? null,
      selectedFile:
        selectedFileDiff === null ? null : resolveFileDiffMatchPaths(selectedFileDiff).join(","),
    });
  }, [expanded, liveOutput, renderablePatch, running, selectedFileDiff]);

  if (liveOutput.text.length === 0) {
    return (
      <InlineFileChangeHeader
        className={containerClassName}
        filePath={headerFilePath}
        running={running}
        expanded={expanded}
        onToggleExpanded={onToggleExpanded}
        onOpenSelectedFileDiff={
          headerFilePath !== "File change" && onOpenSelectedFileDiff
            ? () => onOpenSelectedFileDiff(headerFilePath)
            : undefined
        }
      />
    );
  }

  if (selectedFileDiff) {
    const selectedFilePath = resolveFileDiffPath(selectedFileDiff);
    if (deletedFilePath !== null && normalizeDiffMatchPath(selectedFilePath) === deletedFilePath) {
      return (
        <DeletedFileBadge
          className={containerClassName}
          filePath={selectedFilePath}
          onOpenSelectedFileDiff={onOpenSelectedFileDiff}
        />
      );
    }

    return (
      <div className={cn(containerClassName, "relative")}>
        {onToggleExpanded && (
          <button
            type="button"
            aria-label={expanded ? "Collapse inline file diff" : "Expand inline file diff"}
            className="absolute top-1 -right-1 z-10 flex size-5 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45"
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpanded();
            }}
            data-testid="inline-file-change-expand-toggle"
          >
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
            />
          </button>
        )}
        <div
          onClickCapture={(event) => {
            const nativeEvent = event.nativeEvent as MouseEvent;
            const composedPath = nativeEvent.composedPath?.() ?? [];
            const clickedTitle = composedPath.some((node) => {
              if (!(node instanceof Element)) return false;
              return node.hasAttribute("data-title");
            });
            if (clickedTitle && onOpenSelectedFileDiff && selectedFilePath) {
              event.preventDefault();
              event.stopPropagation();
              onOpenSelectedFileDiff(selectedFilePath);
              return;
            }
            const clickedHeader = composedPath.some((node) => {
              if (!(node instanceof Element)) return false;
              return node.hasAttribute("data-diffs-header") || node.hasAttribute("data-file-info");
            });
            if (clickedHeader && onToggleExpanded) {
              event.preventDefault();
              event.stopPropagation();
              onToggleExpanded();
            }
          }}
          className={cn(
            "relative min-h-14 overflow-auto rounded-md border border-border/55 bg-card/25 [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar]:w-1.5",
            expanded ? "max-h-80" : "max-h-[7.25rem]",
          )}
        >
          {liveOutput.truncated && (
            <div className="border-b border-border/45 px-2 py-1 text-[10px] text-muted-foreground/55">
              Earlier streamed edits truncated.
            </div>
          )}
          <div data-testid="inline-file-change-patch">
            <FileDiff
              fileDiff={selectedFileDiff}
              options={{
                diffStyle: "unified",
                lineDiffType: "none",
                overflow: settings.diffWordWrap ? "wrap" : "scroll",
                theme: resolveDiffThemeName(resolvedTheme),
                themeType: resolvedTheme as InlineDiffThemeType,
                unsafeCSS: running
                  ? `${DIFF_RENDER_UNSAFE_CSS}\n${INLINE_FILE_CHANGE_RUNNING_UNSAFE_CSS}`
                  : DIFF_RENDER_UNSAFE_CSS,
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <InlineFileChangeHeader
      className={containerClassName}
      filePath={headerFilePath}
      running={running}
      expanded={expanded}
      onToggleExpanded={onToggleExpanded}
      onOpenSelectedFileDiff={
        headerFilePath && onOpenSelectedFileDiff
          ? () => onOpenSelectedFileDiff(headerFilePath)
          : undefined
      }
    />
  );
});

type InlineDiffThemeType = "light" | "dark";

const InlineFileChangeHeader = memo(function InlineFileChangeHeader(props: {
  className: string;
  filePath: string;
  running: boolean;
  expanded: boolean;
  onToggleExpanded?: (() => void) | undefined;
  onOpenSelectedFileDiff?: (() => void) | undefined;
}) {
  const { className, filePath, running, expanded, onToggleExpanded, onOpenSelectedFileDiff } =
    props;
  return (
    <div className={className}>
      <div
        className="flex min-h-8 min-w-0 items-center gap-2 rounded-md border border-border/55 bg-card/25 px-2 text-left"
        data-testid="inline-file-change-header"
        onClick={onToggleExpanded}
      >
        {onOpenSelectedFileDiff ? (
          <button
            type="button"
            className="min-w-0 truncate font-mono text-[11px] font-medium text-foreground/80 underline decoration-transparent underline-offset-2 transition-colors hover:text-primary hover:decoration-current focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45"
            title={filePath}
            onClick={(event) => {
              event.stopPropagation();
              onOpenSelectedFileDiff();
            }}
          >
            {filePath}
          </button>
        ) : (
          <span
            className="min-w-0 truncate font-mono text-[11px] font-medium text-foreground/80"
            title={filePath}
          >
            {filePath}
          </span>
        )}
        {running ? <WorkingDots className="shrink-0 text-muted-foreground/55" /> : null}
        <span className="min-w-0 flex-1" />
        {onToggleExpanded ? (
          <button
            type="button"
            aria-label={expanded ? "Collapse inline file diff" : "Expand inline file diff"}
            className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45"
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpanded();
            }}
            data-testid="inline-file-change-expand-toggle"
          >
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
            />
          </button>
        ) : null}
      </div>
    </div>
  );
});

const DeletedFileBadge = memo(function DeletedFileBadge(props: {
  className: string;
  filePath: string;
  onOpenSelectedFileDiff?: ((filePath: string) => void) | undefined;
}) {
  const { className, filePath, onOpenSelectedFileDiff } = props;
  const content = (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center rounded-sm border border-destructive/55 bg-destructive/10 text-destructive">
        <XIcon aria-hidden="true" className="size-3" strokeWidth={2.4} />
      </span>
      <span className="min-w-0 truncate font-mono text-[11px] font-medium text-destructive/90">
        {filePath}
      </span>
    </>
  );

  if (onOpenSelectedFileDiff) {
    return (
      <div className={className}>
        <button
          type="button"
          className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md border border-destructive/25 bg-destructive/8 px-2.5 py-2 text-left transition-colors hover:border-destructive/35 hover:bg-destructive/12 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/35"
          title={filePath}
          aria-label={`Deleted ${filePath}`}
          data-testid="inline-file-delete-badge"
          onClick={() => onOpenSelectedFileDiff(filePath)}
        >
          {content}
        </button>
      </div>
    );
  }

  return (
    <div className={className}>
      <div
        className="flex min-h-9 min-w-0 items-center gap-2 rounded-md border border-destructive/25 bg-destructive/8 px-2.5 py-2"
        title={filePath}
        data-testid="inline-file-delete-badge"
      >
        {content}
      </div>
    </div>
  );
});

function normalizeDiffMatchPath(pathValue: string, workspaceRoot?: string | undefined): string {
  let normalized = pathValue.replace(/\\/g, "/").trim();
  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  const normalizedRoot = workspaceRoot?.replace(/\\/g, "/").replace(/\/+$/u, "");
  if (normalizedRoot && normalized.startsWith(`${normalizedRoot}/`)) {
    normalized = normalized.slice(normalizedRoot.length + 1);
  }

  return normalized;
}

const InlineChangedFilesDiffPreview = memo(function InlineChangedFilesDiffPreview(props: {
  workEntry: TimelineWorkEntry;
  changedFiles: ReadonlyArray<string>;
  workspaceRoot: string | undefined;
  liveOutput: LiveCommandOutputSnapshot;
  expanded: boolean;
  stablePatchCacheKey?: string | undefined;
  onToggleExpanded?: (() => void) | undefined;
  onOpenSelectedFileDiff?: ((filePath: string) => void) | undefined;
}) {
  const {
    workEntry,
    changedFiles,
    workspaceRoot,
    liveOutput,
    expanded,
    stablePatchCacheKey,
    onToggleExpanded,
    onOpenSelectedFileDiff,
  } = props;
  const isRunningFileChange = workEntry.status === "running";
  return (
    <LiveFileChangePreview
      liveOutput={liveOutput}
      running={isRunningFileChange}
      expanded={expanded}
      changedFiles={changedFiles}
      workspaceRoot={workspaceRoot}
      stablePatchCacheKey={stablePatchCacheKey}
      onToggleExpanded={onToggleExpanded}
      onOpenSelectedFileDiff={onOpenSelectedFileDiff}
    />
  );
});

function InlineDiffMessage({
  children,
  minLines = 1,
  standalone,
}: {
  children: ReactNode;
  minLines?: number;
  standalone?: boolean | undefined;
}) {
  return (
    <div className={standalone ? "pb-1" : "pl-7 pr-1 pb-1"}>
      <div
        className={cn(
          "rounded-md border border-border/45 bg-muted/15 px-2 py-1.5 text-[11px] text-muted-foreground/70",
          minLines >= 3 && "flex min-h-14 items-center",
        )}
      >
        {children}
      </div>
    </div>
  );
}

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
  outputExpanded: boolean;
  inlineDiffExpanded: boolean;
  defaultOutputCollapsed: boolean;
  defaultInlineDiffCollapsed: boolean;
  onToggleOutputExpanded: (key: string, defaultExpanded: boolean) => void;
  onToggleInlineDiffExpanded: (key: string, defaultExpanded: boolean) => void;
}) {
  const {
    workEntry,
    workspaceRoot,
    outputExpanded,
    inlineDiffExpanded,
    defaultOutputCollapsed,
    defaultInlineDiffCollapsed,
    onToggleOutputExpanded,
    onToggleInlineDiffExpanded,
  } = props;

  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const isTerminal = isTerminalWorkEntry(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const rawPreview = workEntryPreview(workEntry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;
  const rawCommand = workEntryRawCommand(workEntry);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;
  const managedFailedEdit = isManagedFailedEdit(workEntry);
  const isFileChange =
    workEntry.itemType === "file_change" || workEntry.requestKind === "file-change";
  const hasFileChangePatchPreview = isFileChange && Boolean(workEntry.toolCallId);
  const hasInlineDiff = hasChangedFiles && !isTerminal && !isFileChange;
  const outputPreview =
    (workEntry.itemType === "command_execution" || workEntry.command) &&
    (workEntry.outputPreview?.lines.length ?? 0) > 0
      ? workEntry.outputPreview
      : null;
  const ctx = use(TimelineRowCtx);
  const liveKey: LiveCommandOutputKey | null =
    (isTerminal || isFileChange) && workEntry.toolCallId
      ? {
          environmentId: ctx.activeThreadEnvironmentId,
          threadId: ctx.activeThreadId,
          toolCallId: workEntry.toolCallId,
        }
      : null;
  const liveOutput = useLiveCommandOutput(liveKey);
  const hasLiveOutput =
    liveOutput.text.length > 0 ||
    ((isTerminal || isFileChange) &&
      workEntry.status === "running" &&
      Boolean(workEntry.toolCallId));
  const isExpandable =
    outputPreview !== null || hasLiveOutput || Boolean(workEntry.failure?.expectedContent);
  const toolKey = workEntryToolKey(workEntry);
  const defaultOutputExpanded = isTerminal && shouldAutoShowTerminalOutput(workEntry, liveOutput);
  const showOutputPreview =
    isExpandable && (outputExpanded || (defaultOutputExpanded && !defaultOutputCollapsed));
  const openFileChangeTurnDiff = useCallback(
    (filePath: string) => {
      if (!workEntry.turnId) {
        return;
      }
      ctx.onOpenTurnDiff?.(workEntry.turnId, filePath);
    },
    [ctx, workEntry.turnId],
  );

  if (isTerminal) {
    const commandLabel = terminalPrimaryLabel(workEntry);
    return (
      <div className="group rounded-lg px-1 py-0.5 transition-colors duration-150 hover:bg-muted/20 focus-within:bg-muted/20">
        <div className="flex min-h-7 items-center gap-2 transition-[opacity,translate] duration-200">
          <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/70">
            <TerminalIcon className="size-3" />
          </span>
          <Tooltip>
            <TooltipTrigger className="block min-w-0 flex-1 text-left" title={commandLabel}>
              <p className="truncate font-mono text-[11px] leading-5 text-foreground/80">
                {commandLabel}
              </p>
            </TooltipTrigger>
            <TooltipPopup className="max-w-[min(56rem,calc(100vw-2rem))] px-0 py-0">
              <div className="max-w-[min(56rem,calc(100vw-2rem))] overflow-x-auto px-1.5 py-1 font-mono text-[11px] leading-4 whitespace-nowrap">
                {terminalCopyCommand(workEntry)}
              </div>
            </TooltipPopup>
          </Tooltip>
          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
            <MessageCopyButton
              text={terminalCopyCommand(workEntry)}
              size="icon-xs"
              variant="ghost"
              className="size-5 text-muted-foreground/45 hover:text-muted-foreground/80"
            />
          </div>
          {workEntry.status && (
            <span
              className={cn(
                "shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] leading-3 font-medium",
                terminalStatusClass(workEntry),
              )}
            >
              {terminalStatusLabel(workEntry)}
            </span>
          )}
          {workEntry.exitCode !== undefined && (
            <span className="shrink-0 rounded-md border border-border/50 bg-muted/25 px-1.5 py-0.5 font-mono text-[10px] leading-3 text-muted-foreground/70">
              exit {workEntry.exitCode}
            </span>
          )}
          {isExpandable && (
            <button
              type="button"
              className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/45 transition-[transform,color] duration-150 hover:text-muted-foreground/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45"
              aria-label={showOutputPreview ? "Collapse tool output" : "Expand tool output"}
              aria-expanded={showOutputPreview}
              onClick={() => onToggleOutputExpanded(toolKey, defaultOutputExpanded)}
              data-testid="tool-output-toggle"
            >
              <ChevronRightIcon
                className={cn(
                  "size-3.5 transition-transform duration-150",
                  showOutputPreview && "rotate-90",
                )}
              />
            </button>
          )}
        </div>
        {showOutputPreview && <ToolOutputPreview workEntry={workEntry} liveOutput={liveOutput} />}
      </div>
    );
  }

  if (managedFailedEdit) {
    const showFailurePreview = outputExpanded;
    return (
      <div className="group rounded-lg border border-destructive/20 bg-destructive/5 px-1 py-0.5 transition-colors duration-150 hover:bg-destructive/8 focus-within:bg-destructive/8">
        <div className="flex min-h-7 items-center gap-2 transition-[opacity,translate] duration-200">
          <span className="flex size-5 shrink-0 items-center justify-center text-destructive/70">
            <SquarePenIcon className="size-3" />
          </span>
          <p
            className="min-w-0 flex-1 truncate text-[11px] leading-5 text-destructive/80"
            title={displayText}
          >
            <span className="text-foreground/80">{heading}</span>
            {preview && <span className="text-muted-foreground/55"> - {preview}</span>}
          </p>
          {workEntry.status && (
            <span
              className={cn(
                "shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] leading-3 font-medium",
                terminalStatusClass(workEntry),
              )}
            >
              {terminalStatusLabel(workEntry)}
            </span>
          )}
          {(workEntry.failure?.expectedContent ||
            workEntry.failure?.actualContentExcerpt ||
            workEntry.failure?.attemptedPatch) && (
            <button
              type="button"
              className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/45 transition-[transform,color] duration-150 hover:text-muted-foreground/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45"
              aria-label={
                showFailurePreview ? "Collapse expected content" : "Expand expected content"
              }
              aria-expanded={showFailurePreview}
              onClick={() => onToggleOutputExpanded(toolKey, false)}
              data-testid="managed-failed-edit-toggle"
            >
              <ChevronRightIcon
                className={cn(
                  "size-3.5 transition-transform duration-150",
                  showFailurePreview && "rotate-90",
                )}
              />
            </button>
          )}
        </div>
        {showFailurePreview && <ManagedFailedEditPreview workEntry={workEntry} />}
      </div>
    );
  }

  if (isFileChange && (hasFileChangePatchPreview || hasChangedFiles || hasLiveOutput)) {
    const inlineDiffKey = workEntryToolKey(workEntry);
    return (
      <LiveFileChangePreview
        liveOutput={liveOutput}
        running={workEntry.status === "running"}
        expanded={inlineDiffExpanded}
        changedFiles={workEntry.changedFiles ?? []}
        workspaceRoot={workspaceRoot}
        stablePatchCacheKey={
          workEntry.toolCallId
            ? `${ctx.activeThreadEnvironmentId}:${ctx.activeThreadId}:${workEntry.toolCallId}`
            : undefined
        }
        onToggleExpanded={() => onToggleInlineDiffExpanded(inlineDiffKey, false)}
        onOpenSelectedFileDiff={workEntry.turnId ? openFileChangeTurnDiff : undefined}
        standalone
      />
    );
  }

  if (hasInlineDiff || (isFileChange && hasLiveOutput)) {
    const isRunningLivePatch = isFileChange && workEntry.status === "running";
    const defaultInlineDiffExpanded =
      isFileChange && workEntry.status === "completed" && Boolean(workEntry.toolCallId);
    const showInlineDiffPreview =
      isRunningLivePatch ||
      inlineDiffExpanded ||
      (defaultInlineDiffExpanded && !defaultInlineDiffCollapsed);
    const toggleDefaultExpanded = isRunningLivePatch ? false : defaultInlineDiffExpanded;
    const inlineDiffPreviewExpanded =
      inlineDiffExpanded || (defaultInlineDiffExpanded && !defaultInlineDiffCollapsed);
    const inlineDiffControlExpanded = isRunningLivePatch ? false : inlineDiffPreviewExpanded;
    return (
      <div className="group rounded-lg border border-border/35 bg-card/20 px-1 py-0.5 transition-colors duration-150 hover:bg-muted/20 focus-within:bg-muted/20">
        <button
          type="button"
          className="flex min-h-7 w-full min-w-0 items-center gap-2 text-left transition-[opacity,translate] duration-200 focus-visible:outline-none"
          aria-expanded={inlineDiffControlExpanded}
          aria-label={inlineDiffControlExpanded ? "Collapse inline diff" : "Expand inline diff"}
          onClick={
            isRunningLivePatch
              ? undefined
              : () => onToggleInlineDiffExpanded(toolKey, toggleDefaultExpanded)
          }
          data-testid="inline-diff-toggle"
        >
          <span
            className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
          >
            <EntryIcon className="size-3" />
          </span>
          <p
            className={cn(
              "min-w-0 flex-1 truncate text-[11px] leading-5",
              workToneClass(workEntry.tone),
              preview ? "text-muted-foreground/70" : "",
            )}
            title={displayText}
          >
            <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
              {heading}
            </span>
            {preview && <span className="text-muted-foreground/55"> - {preview}</span>}
          </p>
          {workEntry.status && (
            <span
              className={cn(
                "shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] leading-3 font-medium",
                terminalStatusClass(workEntry),
              )}
            >
              {terminalStatusLabel(workEntry)}
            </span>
          )}
          {!isRunningLivePatch && (
            <ChevronRightIcon
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground/45 opacity-0 transition-[opacity,transform,color] duration-150 group-hover:opacity-100 group-hover:text-muted-foreground/80 group-focus-within:opacity-100",
                inlineDiffControlExpanded && "rotate-90 opacity-100",
              )}
            />
          )}
        </button>
        {showInlineDiffPreview &&
          (isFileChange ? (
            <InlineChangedFilesDiffPreview
              workEntry={workEntry}
              changedFiles={workEntry.changedFiles ?? []}
              workspaceRoot={workspaceRoot}
              liveOutput={liveOutput}
              expanded={inlineDiffPreviewExpanded}
              stablePatchCacheKey={
                workEntry.toolCallId
                  ? `${ctx.activeThreadEnvironmentId}:${ctx.activeThreadId}:${workEntry.toolCallId}`
                  : undefined
              }
            />
          ) : hasChangedFiles ? (
            <InlineDiffMessage minLines={3}>Patch details unavailable.</InlineDiffMessage>
          ) : (
            <LiveFileChangePreview
              liveOutput={liveOutput}
              running={workEntry.status === "running"}
              expanded={inlineDiffExpanded}
            />
          ))}
      </div>
    );
  }

  return (
    <div className="group rounded-lg px-1 py-0.5 transition-colors duration-150 hover:bg-muted/20 focus-within:bg-muted/20">
      <div className="flex min-h-7 items-center gap-2 transition-[opacity,translate] duration-200">
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          {rawCommand ? (
            <div className="max-w-full">
              <p
                className={cn(
                  "truncate text-xs leading-5",
                  workToneClass(workEntry.tone),
                  preview ? "text-muted-foreground/70" : "",
                )}
                title={displayText}
              >
                <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
                  {heading}
                </span>
                {preview && (
                  <Tooltip>
                    <TooltipTrigger
                      closeDelay={0}
                      delay={75}
                      render={
                        <span className="max-w-full cursor-default text-muted-foreground/55 transition-colors hover:text-muted-foreground/75 focus-visible:text-muted-foreground/75">
                          {" "}
                          - {preview}
                        </span>
                      }
                    />
                    <TooltipPopup
                      align="start"
                      className="max-w-[min(56rem,calc(100vw-2rem))] px-0 py-0"
                      side="top"
                    >
                      <div className="max-w-[min(56rem,calc(100vw-2rem))] overflow-x-auto px-1.5 py-1 font-mono text-[11px] leading-4 whitespace-nowrap">
                        {rawCommand}
                      </div>
                    </TooltipPopup>
                  </Tooltip>
                )}
              </p>
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger
                className="block min-w-0 w-full text-left"
                title={displayText}
                aria-label={displayText}
              >
                <p
                  className={cn(
                    "truncate text-[11px] leading-5",
                    workToneClass(workEntry.tone),
                    preview ? "text-muted-foreground/70" : "",
                  )}
                >
                  <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
                    {heading}
                  </span>
                  {preview && <span className="text-muted-foreground/55"> - {preview}</span>}
                </p>
              </TooltipTrigger>
              <TooltipPopup className="max-w-[min(720px,calc(100vw-2rem))]">
                <p className="whitespace-pre-wrap wrap-break-word text-xs leading-5">
                  {displayText}
                </p>
              </TooltipPopup>
            </Tooltip>
          )}
        </div>
        {workEntry.status && (
          <span
            className={cn(
              "shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] leading-3 font-medium",
              terminalStatusClass(workEntry),
            )}
          >
            {terminalStatusLabel(workEntry)}
          </span>
        )}
        {workEntry.exitCode !== undefined && (
          <span className="shrink-0 rounded-md border border-border/50 bg-muted/25 px-1.5 py-0.5 font-mono text-[10px] leading-3 text-muted-foreground/70">
            exit {workEntry.exitCode}
          </span>
        )}
        {isExpandable && (
          <button
            type="button"
            className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/45 opacity-0 transition-[opacity,transform,color] duration-150 hover:text-muted-foreground/80 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45 group-hover:opacity-100 group-focus-within:opacity-100"
            aria-label={outputExpanded ? "Collapse tool output" : "Expand tool output"}
            aria-expanded={outputExpanded}
            onClick={() => onToggleOutputExpanded(toolKey, false)}
            data-testid="tool-output-toggle"
          >
            <ChevronRightIcon
              className={cn(
                "size-3.5 transition-transform duration-150",
                outputExpanded && "rotate-90",
              )}
            />
          </button>
        )}
      </div>
      {isExpandable && outputExpanded && (
        <ToolOutputPreview workEntry={workEntry} liveOutput={liveOutput} />
      )}
      {hasChangedFiles && !previewIsChangedFiles && (
        <div className="mt-1 flex flex-wrap gap-1 pl-6">
          {workEntry.changedFiles?.slice(0, 4).map((filePath) => {
            const displayPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
            return (
              <span
                key={`${workEntry.id}:${filePath}`}
                className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
                title={displayPath}
              >
                {displayPath}
              </span>
            );
          })}
          {(workEntry.changedFiles?.length ?? 0) > 4 && (
            <span className="px-1 text-[10px] text-muted-foreground/55">
              +{(workEntry.changedFiles?.length ?? 0) - 4}
            </span>
          )}
        </div>
      )}
    </div>
  );
});
