import { type EnvironmentId, type MessageId, type ThreadId, type TurnId } from "@t3tools/contracts";
import { FileDiff } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
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
import { checkpointDiffQueryOptions } from "../../lib/providerReactQuery";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { isScrollViewportAtBottom } from "./scrollStickiness";
import {
  buildFileDiffRenderKey,
  DIFF_RENDER_UNSAFE_CSS,
  getRenderablePatch,
  resolveFileDiffMatchPaths,
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
          "h-24 max-w-full overflow-auto rounded-md border px-2 py-1 font-mono text-[11px] leading-4 whitespace-pre",
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
  const expectedContent = props.workEntry.failure?.expectedContent;
  if (!expectedContent) {
    return null;
  }
  return (
    <div className="pl-7 pr-1 pb-1">
      <div className="mb-1 font-mono text-[9px] leading-3 text-muted-foreground/55">
        expected content
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
  );
});

type LivePatchLineKind = "addition" | "deletion" | "header" | "context";

interface LivePatchLine {
  readonly id: string;
  readonly kind: LivePatchLineKind;
  readonly text: string;
}

const LIVE_FILE_CHANGE_REVEAL_CHARS_PER_SECOND = 9_000;
const LIVE_FILE_CHANGE_REVEAL_MIN_STEP = 24;

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) {
    index += 1;
  }
  return index;
}

function shouldAnimateLiveFileChangeSnapshot(previous: string, next: string): boolean {
  if (previous.length === 0 || next.length <= previous.length) {
    return false;
  }
  if (next.startsWith(previous)) {
    return true;
  }

  const prefixLength = commonPrefixLength(previous, next);
  return prefixLength >= Math.min(previous.length, 512);
}

function useRevealedLiveFileChangeText(text: string, animate: boolean): string {
  const [displayedText, setDisplayedText] = useState(text);
  const displayedTextRef = useRef(text);
  const targetTextRef = useRef(text);
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);

  useEffect(() => {
    targetTextRef.current = text;

    const cancelFrame = () => {
      if (
        frameRef.current !== null &&
        typeof window !== "undefined" &&
        typeof window.cancelAnimationFrame === "function"
      ) {
        window.cancelAnimationFrame(frameRef.current);
      }
      frameRef.current = null;
      lastFrameAtRef.current = null;
    };

    if (
      !animate ||
      typeof window === "undefined" ||
      typeof window.requestAnimationFrame !== "function" ||
      !shouldAnimateLiveFileChangeSnapshot(displayedTextRef.current, text)
    ) {
      cancelFrame();
      debugFileChangeStream("preview-reveal-jump", {
        previousDisplayedLength: displayedTextRef.current.length,
        targetLength: text.length,
        animate,
      });
      displayedTextRef.current = text;
      setDisplayedText(text);
      return cancelFrame;
    }

    if (!text.startsWith(displayedTextRef.current)) {
      const prefixLength = commonPrefixLength(displayedTextRef.current, text);
      const prefixText = text.slice(0, prefixLength);
      displayedTextRef.current = prefixText;
      setDisplayedText(prefixText);
    }

    const step = (timestamp: number) => {
      const targetText = targetTextRef.current;
      const currentText = displayedTextRef.current;
      if (currentText === targetText || !targetText.startsWith(currentText)) {
        frameRef.current = null;
        lastFrameAtRef.current = null;
        if (currentText !== targetText) {
          displayedTextRef.current = targetText;
          setDisplayedText(targetText);
        }
        return;
      }

      const elapsedMs = Math.max(16, timestamp - (lastFrameAtRef.current ?? timestamp - 16));
      lastFrameAtRef.current = timestamp;
      const stepChars = Math.max(
        LIVE_FILE_CHANGE_REVEAL_MIN_STEP,
        Math.ceil((LIVE_FILE_CHANGE_REVEAL_CHARS_PER_SECOND * elapsedMs) / 1000),
      );
      const nextLength = Math.min(targetText.length, currentText.length + stepChars);
      const nextText = targetText.slice(0, nextLength);
      displayedTextRef.current = nextText;
      setDisplayedText(nextText);

      if (nextText.length < targetText.length) {
        frameRef.current = window.requestAnimationFrame(step);
      } else {
        frameRef.current = null;
        lastFrameAtRef.current = null;
      }
    };

    if (frameRef.current === null) {
      debugFileChangeStream("preview-reveal-start", {
        displayedLength: displayedTextRef.current.length,
        targetLength: text.length,
      });
      frameRef.current = window.requestAnimationFrame(step);
    }

    return cancelFrame;
  }, [animate, text]);

  return displayedText;
}

function parseLivePatchLines(text: string): LivePatchLine[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalized.split("\n");
  const sourceLines = normalized.endsWith("\n") ? rawLines.slice(0, -1) : rawLines;
  const visibleLines = sourceLines.slice(-300);

  return visibleLines.map((line, index) => {
    const kind: LivePatchLineKind =
      line.startsWith("+") && !line.startsWith("+++")
        ? "addition"
        : line.startsWith("-") && !line.startsWith("---")
          ? "deletion"
          : line.startsWith("diff ") ||
              line.startsWith("@@") ||
              line.startsWith("+++") ||
              line.startsWith("---") ||
              line.startsWith("index ")
            ? "header"
            : "context";
    return {
      id: `${index}:${line}`,
      kind,
      text: line.length > 0 ? line : " ",
    };
  });
}

const LiveFileChangePreview = memo(function LiveFileChangePreview(props: {
  liveOutput: LiveCommandOutputSnapshot;
  running: boolean;
  expanded: boolean;
}) {
  const { liveOutput, running, expanded } = props;
  const displayedText = useRevealedLiveFileChangeText(liveOutput.text, running);
  const lines = useMemo(() => parseLivePatchLines(displayedText), [displayedText]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const userScrolledAwayRef = useRef(false);

  const handleScroll = useCallback(() => {
    const element = scrollerRef.current;
    if (!element) {
      return;
    }
    userScrolledAwayRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight > 24;
  }, []);

  useEffect(() => {
    if (!running || userScrolledAwayRef.current) {
      return;
    }
    const element = scrollerRef.current;
    if (!element) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [displayedText, running]);

  useEffect(() => {
    debugFileChangeStream("preview-render", {
      sourceLength: liveOutput.text.length,
      displayedLength: displayedText.length,
      version: liveOutput.version,
      updatedAt: liveOutput.updatedAt,
      running,
      expanded,
      lineCount: lines.length,
    });
  }, [displayedText.length, expanded, lines.length, liveOutput, running]);

  if (displayedText.length === 0) {
    return <InlineDiffMessage minLines={3}>Waiting for file-change stream...</InlineDiffMessage>;
  }

  return (
    <div className="pl-7 pr-1 pb-1">
      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        className={cn(
          "min-h-14 overflow-auto rounded-md border border-border/55 bg-background/80 p-2 font-mono text-[10.5px] leading-4 shadow-xs",
          expanded ? "max-h-36" : "max-h-[4.75rem]",
        )}
        data-testid="inline-file-change-patch"
      >
        {liveOutput.truncated && (
          <div className="mb-1 text-muted-foreground/55">Earlier streamed edits truncated.</div>
        )}
        <pre className="m-0 min-w-max font-inherit leading-inherit whitespace-pre">
          {lines.map((line) => (
            <div
              key={line.id}
              className={cn(
                line.kind === "addition" &&
                  "bg-success/8 text-success-foreground dark:text-success",
                line.kind === "deletion" && "bg-destructive/8 text-destructive",
                line.kind === "header" && "text-muted-foreground/65",
                line.kind === "context" && "text-muted-foreground/85",
              )}
            >
              {line.text}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
});

type InlineDiffThemeType = "light" | "dark";

const INLINE_DIFF_UNSAFE_CSS = `${DIFF_RENDER_UNSAFE_CSS}

:host {
  --diffs-font-size: 10.5px;
  --diffs-line-height: 15px;
  --diffs-gap-fallback: 4px;
  --diffs-gap-block: 3px;
  --diffs-gap-inline: 4px;
  --diffs-tab-size: 2;
}

[data-code] {
  padding-block: 3px !important;
}

[data-file-info] {
  padding: 4px 6px !important;
  font-size: 10px !important;
  font-weight: 600 !important;
}
`;

function normalizeDiffMatchPath(pathValue: string, workspaceRoot: string | undefined): string {
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
  liveOutput?: LiveCommandOutputSnapshot | undefined;
  expanded: boolean;
}) {
  const { workEntry, changedFiles, workspaceRoot, liveOutput, expanded } = props;
  const ctx = use(TimelineRowCtx);
  const turnId = workEntry.turnId ?? null;
  const turnSummary = turnId ? ctx.turnDiffSummaryByTurnId.get(turnId) : undefined;
  const isRunningFileChange = workEntry.status === "running";
  if (liveOutput && (liveOutput.text.length > 0 || isRunningFileChange)) {
    return (
      <LiveFileChangePreview
        liveOutput={liveOutput}
        running={isRunningFileChange}
        expanded={expanded}
      />
    );
  }

  return (
    <CompletedChangedFilesDiffPreview
      workEntry={workEntry}
      changedFiles={changedFiles}
      workspaceRoot={workspaceRoot}
      turnId={turnId}
      turnSummary={turnSummary}
      expanded={expanded}
    />
  );
});

const CompletedChangedFilesDiffPreview = memo(function CompletedChangedFilesDiffPreview(props: {
  workEntry: TimelineWorkEntry;
  changedFiles: ReadonlyArray<string>;
  workspaceRoot: string | undefined;
  turnId: TurnId | null;
  turnSummary: TurnDiffSummary | undefined;
  expanded: boolean;
}) {
  const { workEntry, changedFiles, workspaceRoot, turnId, turnSummary, expanded } = props;
  const ctx = use(TimelineRowCtx);
  const { resolvedTheme } = useTheme();
  const settings = useSettings();
  const checkpointTurnCount =
    turnId && turnSummary
      ? (turnSummary.checkpointTurnCount ?? ctx.inferredCheckpointTurnCountByTurnId[turnId])
      : undefined;
  const checkpointRange =
    typeof checkpointTurnCount === "number"
      ? {
          fromTurnCount: Math.max(0, checkpointTurnCount - 1),
          toTurnCount: checkpointTurnCount,
        }
      : null;
  const diffQuery = useQuery(
    checkpointDiffQueryOptions({
      environmentId: ctx.activeThreadEnvironmentId,
      threadId: ctx.activeThreadId,
      fromTurnCount: checkpointRange?.fromTurnCount ?? null,
      toTurnCount: checkpointRange?.toTurnCount ?? null,
      cacheScope: turnId ? `turn:${turnId}` : null,
      enabled: checkpointRange !== null,
    }),
  );
  const renderablePatch = useMemo(
    () => getRenderablePatch(diffQuery.data?.diff, `inline-diff:${resolvedTheme}`),
    [diffQuery.data?.diff, resolvedTheme],
  );
  const requestedPaths = useMemo(
    () => new Set(changedFiles.map((filePath) => normalizeDiffMatchPath(filePath, workspaceRoot))),
    [changedFiles, workspaceRoot],
  );
  const matchingFiles = useMemo(() => {
    if (renderablePatch?.kind !== "files") {
      return [];
    }
    return renderablePatch.files.filter((fileDiff) =>
      resolveFileDiffMatchPaths(fileDiff).some((filePath) =>
        requestedPaths.has(normalizeDiffMatchPath(filePath, workspaceRoot)),
      ),
    );
  }, [renderablePatch, requestedPaths, workspaceRoot]);
  const matchedPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const fileDiff of matchingFiles) {
      for (const filePath of resolveFileDiffMatchPaths(fileDiff)) {
        paths.add(normalizeDiffMatchPath(filePath, workspaceRoot));
      }
    }
    return paths;
  }, [matchingFiles, workspaceRoot]);
  const missingFiles = useMemo(
    () =>
      changedFiles.filter(
        (filePath) => !matchedPaths.has(normalizeDiffMatchPath(filePath, workspaceRoot)),
      ),
    [changedFiles, matchedPaths, workspaceRoot],
  );

  if (!turnId || !turnSummary || checkpointRange === null) {
    return (
      <InlineDiffMessage>
        Per-call patch details are no longer retained for this change.
      </InlineDiffMessage>
    );
  }

  if (diffQuery.isLoading) {
    return <InlineDiffMessage>Loading inline diff...</InlineDiffMessage>;
  }

  if (diffQuery.error) {
    const message =
      diffQuery.error instanceof Error ? diffQuery.error.message : "Failed to load inline diff.";
    return <InlineDiffMessage>{message}</InlineDiffMessage>;
  }

  if (!renderablePatch) {
    return <InlineDiffMessage>No net diff available for this change.</InlineDiffMessage>;
  }

  if (renderablePatch.kind === "raw") {
    return (
      <div className="pl-7 pr-1 pb-1">
        <div
          className={cn(
            "overflow-auto rounded-md border border-border/50 bg-muted/20 p-2",
            expanded ? "max-h-36" : "max-h-[4.75rem]",
          )}
        >
          <p className="mb-1 text-[10px] text-muted-foreground/65">{renderablePatch.reason}</p>
          <pre
            className={cn(
              "font-mono text-[9.5px] leading-3.5 text-muted-foreground/85",
              settings.diffWordWrap ? "whitespace-pre-wrap wrap-break-word" : "whitespace-pre",
            )}
          >
            {renderablePatch.text}
          </pre>
        </div>
      </div>
    );
  }

  if (matchingFiles.length === 0) {
    return (
      <InlineDiffMessage>
        Per-call patch details are no longer retained for{" "}
        {changedFiles.length === 1 ? "this file" : "these files"}.
      </InlineDiffMessage>
    );
  }

  return (
    <div className="pl-7 pr-1 pb-1">
      <div
        className={cn(
          "min-h-14 overflow-auto rounded-md border border-border/55 bg-card/25",
          expanded ? "max-h-36" : "max-h-[4.75rem]",
        )}
      >
        {matchingFiles.map((fileDiff) => {
          const fileKey = buildFileDiffRenderKey(fileDiff);
          return (
            <div key={`${fileKey}:${resolvedTheme}`}>
              <FileDiff
                fileDiff={fileDiff}
                options={{
                  disableFileHeader: true,
                  diffStyle: "unified",
                  lineDiffType: "none",
                  overflow: settings.diffWordWrap ? "wrap" : "scroll",
                  theme: resolveDiffThemeName(resolvedTheme),
                  themeType: resolvedTheme as InlineDiffThemeType,
                  unsafeCSS: INLINE_DIFF_UNSAFE_CSS,
                }}
              />
            </div>
          );
        })}
      </div>
      {missingFiles.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-muted-foreground/55">
          {missingFiles.map((filePath) => (
            <span key={`${workEntry.id}:missing-diff:${filePath}`}>
              Per-call patch not retained for {formatWorkspaceRelativePath(filePath, workspaceRoot)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});

function InlineDiffMessage({ children, minLines = 1 }: { children: ReactNode; minLines?: number }) {
  return (
    <div className="pl-7 pr-1 pb-1">
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
  const hasInlineDiff = hasChangedFiles && !isTerminal;
  const managedFailedEdit = isManagedFailedEdit(workEntry);
  const isFileChange =
    workEntry.itemType === "file_change" || workEntry.requestKind === "file-change";
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
          {workEntry.failure?.expectedContent && (
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

  if (hasInlineDiff || (isFileChange && hasLiveOutput)) {
    const isRunningLivePatch = isFileChange && workEntry.status === "running";
    const defaultInlineDiffExpanded = false;
    const hasCompletedLivePatch = isFileChange && workEntry.status === "completed" && hasLiveOutput;
    const showInlineDiffPreview =
      isRunningLivePatch ||
      hasCompletedLivePatch ||
      inlineDiffExpanded ||
      (defaultInlineDiffExpanded && !defaultInlineDiffCollapsed);
    const toggleDefaultExpanded = isRunningLivePatch ? false : defaultInlineDiffExpanded;
    const inlineDiffControlExpanded = isRunningLivePatch ? false : inlineDiffExpanded;
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
          (hasChangedFiles ? (
            <InlineChangedFilesDiffPreview
              workEntry={workEntry}
              changedFiles={workEntry.changedFiles ?? []}
              workspaceRoot={workspaceRoot}
              liveOutput={isFileChange ? liveOutput : undefined}
              expanded={inlineDiffExpanded}
            />
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
