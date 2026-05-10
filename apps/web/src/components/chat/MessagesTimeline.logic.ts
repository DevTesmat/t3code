import { type TimelineEntry, type WorkLogEntry } from "../../session-logic";
import { type ActiveTurnActivityState } from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { type MessageId } from "@t3tools/contracts";
import {
  classifyToolActivityGroup,
  type ToolActivityGroupKind,
} from "@t3tools/shared/toolActivity";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
      activityGroupKind: ToolActivityGroupKind;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showCompletionDivider: boolean;
      showAssistantCopyButton: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "separator";
      id: string;
      createdAt: string;
      label: string;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
      activityState: ActiveTurnActivityState;
    };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:started|complete|completed)\s*$/i, "").trim();
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  completionDividerBeforeEntryId: string | null;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  activeTurnActivityState?: ActiveTurnActivityState | undefined;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);
  const workGroupIdOccurrences = new Map<string, number>();
  let pendingWorkEntries: Array<Extract<TimelineEntry, { kind: "work" }>> = [];

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      pendingWorkEntries.push(timelineEntry);
      continue;
    }

    appendWorkTimelineRows(pendingWorkEntries, nextRows, workGroupIdOccurrences);
    pendingWorkEntries = [];

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    if (timelineEntry.kind === "separator") {
      nextRows.push({
        kind: "separator",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        label: timelineEntry.label,
      });
      continue;
    }

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart:
        durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
      showCompletionDivider:
        timelineEntry.message.role === "assistant" &&
        input.completionDividerBeforeEntryId === timelineEntry.id,
      showAssistantCopyButton:
        timelineEntry.message.role === "assistant" &&
        terminalAssistantMessageIds.has(timelineEntry.message.id),
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  appendWorkTimelineRows(pendingWorkEntries, nextRows, workGroupIdOccurrences);

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
      activityState: input.activeTurnActivityState ?? {
        kind: "waitingForModel",
        label: "Working",
      },
    });
  }

  return nextRows;
}

function appendWorkTimelineRows(
  timelineEntries: ReadonlyArray<Extract<TimelineEntry, { kind: "work" }>>,
  nextRows: MessagesTimelineRow[],
  workGroupIdOccurrences: Map<string, number>,
) {
  let explorationRow: Extract<MessagesTimelineRow, { kind: "work" }> | null = null;

  for (let index = 0; index < timelineEntries.length; index += 1) {
    const timelineEntry = timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    const activityGroupKind = classifyWorkEntryActivityGroup(timelineEntry.entry);
    if (activityGroupKind === "exploration") {
      if (explorationRow) {
        explorationRow.groupedEntries.push(timelineEntry.entry);
        continue;
      }

      const groupedEntries = [timelineEntry.entry];
      const baseRowId = stableWorkGroupRowId(groupedEntries, activityGroupKind);
      explorationRow = {
        kind: "work",
        id: uniqueWorkGroupRowId(baseRowId, workGroupIdOccurrences),
        createdAt: timelineEntry.createdAt,
        groupedEntries,
        activityGroupKind,
      };
      nextRows.push(explorationRow);
      continue;
    }

    const groupedEntries = [timelineEntry.entry];
    let cursor = index + 1;
    while (cursor < timelineEntries.length) {
      const nextEntry = timelineEntries[cursor];
      if (!nextEntry) break;
      const nextActivityGroupKind = classifyWorkEntryActivityGroup(nextEntry.entry);
      if (nextActivityGroupKind !== activityGroupKind) break;
      groupedEntries.push(nextEntry.entry);
      cursor += 1;
    }
    const baseRowId = stableWorkGroupRowId(groupedEntries, activityGroupKind);
    nextRows.push({
      kind: "work",
      id: uniqueWorkGroupRowId(baseRowId, workGroupIdOccurrences),
      createdAt: timelineEntry.createdAt,
      groupedEntries,
      activityGroupKind,
    });
    index = cursor - 1;
  }
}

function stableWorkEntryKey(entry: WorkLogEntry): string {
  return entry.toolKey ?? entry.toolCallId ?? entry.id;
}

function stableWorkGroupRowId(
  entries: ReadonlyArray<WorkLogEntry>,
  activityGroupKind: ToolActivityGroupKind,
): string {
  const firstEntry = entries[0];
  return `work-group:${activityGroupKind}:${firstEntry ? stableWorkEntryKey(firstEntry) : "empty"}`;
}

function uniqueWorkGroupRowId(baseRowId: string, occurrences: Map<string, number>): string {
  const nextOccurrence = (occurrences.get(baseRowId) ?? 0) + 1;
  occurrences.set(baseRowId, nextOccurrence);
  return nextOccurrence === 1 ? baseRowId : `${baseRowId}:${nextOccurrence}`;
}

function classifyWorkEntryActivityGroup(entry: WorkLogEntry): ToolActivityGroupKind {
  return classifyToolActivityGroup({
    itemType: entry.itemType,
    title: entry.toolTitle,
    label: entry.label,
    command: entry.command,
    detail: entry.detail,
    changedFiles: entry.changedFiles,
    requestKind: entry.requestKind,
  });
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return (
        a.createdAt === (b as typeof a).createdAt &&
        a.activityState.kind === (b as typeof a).activityState.kind &&
        a.activityState.label === (b as typeof a).activityState.label &&
        a.activityState.detail === (b as typeof a).activityState.detail
      );

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "separator":
      return a.createdAt === (b as typeof a).createdAt && a.label === (b as typeof a).label;

    case "work":
      return (
        a.createdAt === (b as typeof a).createdAt &&
        a.activityGroupKind === (b as typeof a).activityGroupKind &&
        areWorkEntryGroupsUnchanged(a.groupedEntries, (b as typeof a).groupedEntries)
      );

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showCompletionDivider === bm.showCompletionDivider &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}

function areWorkEntryGroupsUnchanged(
  a: ReadonlyArray<WorkLogEntry>,
  b: ReadonlyArray<WorkLogEntry>,
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return other !== undefined && areWorkEntriesUnchanged(entry, other);
  });
}

function areOptionalStringArraysUnchanged(
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((entry, index) => entry === b[index]);
}

function areOutputPreviewsUnchanged(
  a: WorkLogEntry["outputPreview"],
  b: WorkLogEntry["outputPreview"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.stream === b.stream &&
    a.truncated === b.truncated &&
    areOptionalStringArraysUnchanged(a.lines, b.lines)
  );
}

function areWorkEntriesUnchanged(a: WorkLogEntry, b: WorkLogEntry): boolean {
  return (
    a.id === b.id &&
    a.createdAt === b.createdAt &&
    a.turnId === b.turnId &&
    a.label === b.label &&
    a.detail === b.detail &&
    a.command === b.command &&
    a.rawCommand === b.rawCommand &&
    a.status === b.status &&
    a.exitCode === b.exitCode &&
    a.tone === b.tone &&
    a.toolTitle === b.toolTitle &&
    a.itemType === b.itemType &&
    a.requestKind === b.requestKind &&
    a.toolCallId === b.toolCallId &&
    a.toolKey === b.toolKey &&
    a.failure?.kind === b.failure?.kind &&
    a.failure?.path === b.failure?.path &&
    a.failure?.reason === b.failure?.reason &&
    a.failure?.expectedContent === b.failure?.expectedContent &&
    areOptionalStringArraysUnchanged(a.changedFiles, b.changedFiles) &&
    areOutputPreviewsUnchanged(a.outputPreview, b.outputPreview)
  );
}
