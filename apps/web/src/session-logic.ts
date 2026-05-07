import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import {
  ApprovalRequestId,
  isToolLifecycleItemType,
  MessageId,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  ProviderDriverKind,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { classifyToolActivityGroup } from "@t3tools/shared/toolActivity";
import { deriveUserInputPauseDurationMs as deriveSharedUserInputPauseDurationMs } from "@t3tools/shared/workDuration";

import type {
  ChatMessage,
  ProposedPlan,
  SessionPhase,
  Thread,
  ThreadSession,
  TurnDiffSummary,
} from "./types";

export type ProviderPickerKind = ProviderDriverKind;

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
  /** Shown on the model picker sidebar when relevant */
  pickerSidebarBadge?: "new" | "soon";
}> = [
  { value: ProviderDriverKind.make("codex"), label: "Codex", available: true },
  { value: ProviderDriverKind.make("claudeAgent"), label: "Claude", available: true },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    available: true,
    pickerSidebarBadge: "new",
  },
];

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  turnId?: TurnId | undefined;
  label: string;
  detail?: string;
  command?: string;
  rawCommand?: string;
  outputPreview?: {
    lines: string[];
    stream: "stdout" | "stderr" | "mixed" | "unknown";
    truncated: boolean;
  };
  status?: "running" | "completed" | "failed";
  exitCode?: number;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  toolCallId?: string;
  toolKey?: string;
  collabTool?: string;
}

export type ThreadSubagentStatus = "running" | "completed" | "failed" | "closed" | "unknown";

export interface ThreadSubagent {
  threadId: string;
  createdAt: string;
  updatedAt: string;
  status: ThreadSubagentStatus;
  running: boolean;
  nickname?: string;
  role?: string;
  model?: string;
  reasoningEffort?: string;
  promptPreview?: string;
}

export interface ThreadSubagentTranscript {
  subagent: ThreadSubagent;
  messages: ChatMessage[];
  activities: OrchestrationThreadActivity[];
}

interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
}

type TerminalOutputPreview = NonNullable<WorkLogEntry["outputPreview"]>;

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: "command" | "file-read" | "file-change";
  createdAt: string;
  detail?: string;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export interface ActivePlanState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

export type ActiveTurnActivityKind =
  | "awaitingApproval"
  | "awaitingUserInput"
  | "dispatching"
  | "connecting"
  | "runningTool"
  | "streamingAssistant"
  | "thinking"
  | "waitingForModel"
  | "finalizing"
  | "idle";

export interface ActiveTurnActivityState {
  kind: ActiveTurnActivityKind;
  label: string;
  detail?: string | undefined;
}

export interface LatestProposedPlanState {
  id: OrchestrationProposedPlanId;
  createdAt: string;
  updatedAt: string;
  turnId: TurnId | null;
  planMarkdown: string;
  streaming?: boolean;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    };

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

export function formatThreadWorkDuration(durationMs: number): string {
  const elapsedSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

type LatestTurnTiming = Pick<OrchestrationLatestTurn, "turnId" | "startedAt" | "completedAt">;
type SessionActivityState = Pick<ThreadSession, "orchestrationStatus" | "activeTurnId">;
const TERMINAL_OUTPUT_PREVIEW_LINE_COUNT = 4;
const TERMINAL_OUTPUT_PREVIEW_LINE_MAX_LENGTH = 240;

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn) return session?.orchestrationStatus !== "running";
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  if (session.orchestrationStatus === "running") return false;
  return true;
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  const runningTurnId =
    session?.orchestrationStatus === "running" ? (session.activeTurnId ?? null) : null;
  if (runningTurnId !== null) {
    if (latestTurn?.turnId === runningTurnId) {
      return latestTurn.startedAt ?? sendStartedAt;
    }
    return sendStartedAt;
  }
  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.startedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}

export function deriveThreadWorkDurationMs(input: {
  totalWorkDurationMs: number;
  latestTurn: LatestTurnTiming | null;
  session: SessionActivityState | null;
  sendStartedAt: string | null;
  activities?: ReadonlyArray<OrchestrationThreadActivity>;
  nowMs: number;
}): { durationMs: number; ticking: boolean } {
  const persistedDurationMs = Math.max(0, Math.floor(input.totalWorkDurationMs));
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    input.latestTurn,
    input.session,
    input.sendStartedAt,
  );
  if (!activeWorkStartedAt) {
    return { durationMs: persistedDurationMs, ticking: false };
  }

  const activeWorkStartedAtMs = Date.parse(activeWorkStartedAt);
  if (!Number.isFinite(activeWorkStartedAtMs) || input.nowMs < activeWorkStartedAtMs) {
    return { durationMs: persistedDurationMs, ticking: false };
  }

  const pauseState = deriveUserInputPauseDurationMs(
    input.activities ?? [],
    activeWorkStartedAt,
    input.nowMs,
  );
  const liveDurationMs = Math.max(
    0,
    input.nowMs - activeWorkStartedAtMs - pauseState.pausedDurationMs,
  );

  return {
    durationMs: persistedDurationMs + liveDurationMs,
    ticking: !pauseState.hasOpenPause,
  };
}

export function deriveUserInputPauseDurationMs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  activeStartIso: string,
  activeEndMs: number,
): { pausedDurationMs: number; hasOpenPause: boolean } {
  return deriveSharedUserInputPauseDurationMs(activities, activeStartIso, activeEndMs);
}

function requestKindFromRequestType(requestType: unknown): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

function isStalePendingRequestFailureDetail(detail: string | undefined): boolean {
  const normalized = detail?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("unknown pending user-input request")
  );
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.make(payload.requestId)
        : null;
    const requestKind =
      payload &&
      (payload.requestKind === "command" ||
        payload.requestKind === "file-read" ||
        payload.requestKind === "file-change")
        ? payload.requestKind
        : payload
          ? requestKindFromRequestType(payload.requestType)
          : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "approval.requested" && requestId && requestKind) {
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
      continue;
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      if (options.length === 0) {
        return null;
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
        multiSelect: question.multiSelect === true,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.make(payload.requestId)
        : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "user-input.requested" && requestId) {
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        continue;
      }
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
      });
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function deriveActivePlanState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActivePlanState | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const allPlanActivities = ordered.filter((activity) => activity.kind === "turn.plan.updated");
  // Prefer plan from the current turn; fall back to the most recent plan from any turn
  // so that TodoWrite tasks persist across follow-up messages.
  const latest = Option.firstSomeOf([
    ...(latestTurnId
      ? Arr.findLast(allPlanActivities, (activity) => activity.turnId === latestTurnId)
      : Option.none()),
    Arr.last(allPlanActivities),
  ]).pipe(Option.getOrNull);
  if (!latest) {
    return null;
  }
  const payload =
    latest.payload && typeof latest.payload === "object"
      ? (latest.payload as Record<string, unknown>)
      : null;
  const rawPlan = payload?.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const steps = rawPlan
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.step !== "string") {
        return null;
      }
      const status =
        record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
      return {
        step: record.step,
        status,
      };
    })
    .filter(
      (
        step,
      ): step is {
        step: string;
        status: "pending" | "inProgress" | "completed";
      } => step !== null,
    );
  if (steps.length === 0) {
    return null;
  }
  return {
    createdAt: latest.createdAt,
    turnId: latest.turnId,
    ...(payload && "explanation" in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    steps,
  };
}

export function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  latestTurnId: TurnId | string | null | undefined,
): LatestProposedPlanState | null {
  if (latestTurnId) {
    const matchingTurnPlan = [...proposedPlans]
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return toLatestProposedPlanState(matchingTurnPlan);
    }
  }

  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!latestPlan) {
    return null;
  }

  return toLatestProposedPlanState(latestPlan);
}

export function findSidebarProposedPlan(input: {
  threads: ReadonlyArray<Pick<Thread, "id" | "proposedPlans">>;
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "sourceProposedPlan"> | null;
  latestTurnSettled: boolean;
  threadId: ThreadId | string | null | undefined;
}): LatestProposedPlanState | null {
  const activeThreadPlans =
    input.threads.find((thread) => thread.id === input.threadId)?.proposedPlans ?? [];

  if (!input.latestTurnSettled) {
    const sourceProposedPlan = input.latestTurn?.sourceProposedPlan;
    if (sourceProposedPlan) {
      const sourcePlan = input.threads
        .find((thread) => thread.id === sourceProposedPlan.threadId)
        ?.proposedPlans.find((plan) => plan.id === sourceProposedPlan.planId);
      if (sourcePlan) {
        return toLatestProposedPlanState(sourcePlan);
      }
    }
  }

  return findLatestProposedPlan(activeThreadPlans, input.latestTurn?.turnId ?? null);
}

export function hasActionableProposedPlan(
  proposedPlan: LatestProposedPlanState | Pick<ProposedPlan, "implementedAt"> | null,
): boolean {
  return proposedPlan !== null && proposedPlan.implementedAt === null;
}

export function shouldShowPlanFollowUpPrompt(input: {
  pendingApprovalCount: number;
  pendingUserInputCount: number;
  latestTurnSettled: boolean;
  proposedPlan: LatestProposedPlanState | Pick<ProposedPlan, "implementedAt"> | null;
}): boolean {
  return (
    input.pendingApprovalCount === 0 &&
    input.pendingUserInputCount === 0 &&
    input.latestTurnSettled &&
    hasActionableProposedPlan(input.proposedPlan)
  );
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): WorkLogEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const entries = ordered
    .filter((activity) => (latestTurnId ? activity.turnId === latestTurnId : true))
    .filter((activity) => activity.kind !== "task.started")
    .filter((activity) => activity.kind !== "context-window.updated")
    .filter((activity) => !activity.kind.startsWith("subagent."))
    .filter((activity) => activity.summary !== "Checkpoint captured")
    .filter((activity) => !isPlanBoundaryToolActivity(activity))
    .map(toDerivedWorkLogEntry);
  return collapseDerivedWorkLogEntries(entries).map(
    ({ activityKind: _activityKind, collapseKey: _collapseKey, ...entry }) => entry,
  );
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }

  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:");
}

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const commandPreview = extractToolCommand(payload);
  const changedFiles = extractChangedFiles(payload);
  const title = extractToolTitle(payload);
  const itemType = extractWorkLogItemType(payload);
  const outputPreview = extractCommandOutputPreview(payload, itemType);
  const commandStatus = extractCommandStatus(payload, activity.kind, itemType);
  const collabStatus = extractCollabWorkLogStatus(payload, activity.kind, itemType);
  const exitCode = extractCommandExitCode(payload);
  const collabTool = extractCollabTool(payload);
  const collabLabel =
    itemType === "collab_agent_tool_call" ? formatCollabWorkLogLabel(payload, collabTool) : null;
  const isTaskActivity = activity.kind === "task.progress" || activity.kind === "task.completed";
  const taskSummary =
    isTaskActivity && typeof payload?.summary === "string" && payload.summary.length > 0
      ? payload.summary
      : null;
  const taskDetailAsLabel =
    isTaskActivity &&
    !taskSummary &&
    typeof payload?.detail === "string" &&
    payload.detail.length > 0
      ? payload.detail
      : null;
  const taskLabel = taskSummary || taskDetailAsLabel;
  const detail = isTaskActivity
    ? !taskDetailAsLabel &&
      payload &&
      typeof payload.detail === "string" &&
      payload.detail.length > 0
      ? stripTrailingExitCode(payload.detail).output
      : null
    : extractToolDetail(payload, title ?? activity.summary);
  const toolCallId = isTaskActivity ? null : extractToolCallId(payload);
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    ...(activity.turnId ? { turnId: activity.turnId } : {}),
    label: collabLabel ?? taskLabel ?? activity.summary,
    tone:
      activity.kind === "task.progress"
        ? "thinking"
        : activity.tone === "approval"
          ? "info"
          : activity.tone,
    activityKind: activity.kind,
  };
  const requestKind = extractWorkLogRequestKind(payload);
  if (detail) {
    entry.detail = detail;
  }
  if (commandPreview.command) {
    entry.command = commandPreview.command;
  }
  if (commandPreview.rawCommand) {
    entry.rawCommand = commandPreview.rawCommand;
  }
  if (outputPreview) {
    entry.outputPreview = outputPreview;
  }
  if (commandStatus) {
    entry.status = commandStatus;
  } else if (collabStatus) {
    entry.status = collabStatus;
  }
  if (exitCode !== null) {
    entry.exitCode = exitCode;
  }
  if (changedFiles.length > 0) {
    entry.changedFiles = changedFiles;
  }
  if (title) {
    entry.toolTitle = title;
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  if (toolCallId) {
    entry.toolCallId = toolCallId;
  }
  if (collabTool) {
    entry.collabTool = collabTool;
  }
  if (collabLabel) {
    entry.toolTitle = collabLabel;
  }
  const collapseKey = deriveToolLifecycleCollapseKey(entry);
  if (collapseKey) {
    entry.collapseKey = collapseKey;
    entry.toolKey = collapseKey;
  }
  return entry;
}

export function deriveThreadSubagents(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ThreadSubagent[] {
  const subagentsByThreadId = new Map<string, ThreadSubagent>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload = asRecord(activity.payload);
    if (extractWorkLogItemType(payload) !== "collab_agent_tool_call") {
      continue;
    }
    const data = asRecord(payload?.data);
    const receiverThreadIds = extractStringArray(data?.receiverThreadIds);
    if (receiverThreadIds.length === 0) {
      continue;
    }

    const collabTool = asTrimmedString(data?.collabTool);
    const lifecycleStatus =
      extractCommandStatus(payload, activity.kind, "collab_agent_tool_call") ??
      (activity.kind === "tool.completed" ? "completed" : undefined);
    const agentsStates = asRecord(data?.agentsStates);
    const dataStatus = normalizeSubagentStatus(asTrimmedString(data?.status));

    for (const receiverThreadId of receiverThreadIds) {
      const previous = subagentsByThreadId.get(receiverThreadId);
      const agentState = asRecord(agentsStates?.[receiverThreadId]);
      const agentStatus = normalizeSubagentStatus(
        asTrimmedString(agentState?.status ?? agentState?.state),
      );
      const nextStatus = resolveSubagentStatus({
        collabTool,
        lifecycleStatus,
        agentStatus: agentStatus ?? dataStatus,
        previousStatus: previous?.status,
      });
      const nextSubagent: ThreadSubagent = {
        threadId: receiverThreadId,
        createdAt: previous?.createdAt ?? activity.createdAt,
        updatedAt: activity.createdAt,
        status: nextStatus,
        running: nextStatus === "running",
      };
      const nickname = firstString(
        asTrimmedString(agentState?.agent_nickname ?? agentState?.agentNickname),
        asTrimmedString(data?.agentNickname),
        previous?.nickname,
      );
      const role = firstString(
        asTrimmedString(agentState?.agent_role ?? agentState?.agentRole),
        asTrimmedString(data?.agentRole),
        previous?.role,
      );
      const model = firstString(asTrimmedString(data?.model), previous?.model);
      const reasoningEffort = firstString(
        asTrimmedString(data?.reasoningEffort),
        previous?.reasoningEffort,
      );
      const promptPreview = firstString(
        asTrimmedString(data?.promptPreview),
        previous?.promptPreview,
      );
      if (nickname) nextSubagent.nickname = nickname;
      if (role) nextSubagent.role = role;
      if (model) nextSubagent.model = model;
      if (reasoningEffort) nextSubagent.reasoningEffort = reasoningEffort;
      if (promptPreview) nextSubagent.promptPreview = promptPreview;
      subagentsByThreadId.set(receiverThreadId, nextSubagent);
    }
  }

  return [...subagentsByThreadId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function deriveThreadSubagentTranscripts(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ThreadSubagentTranscript[] {
  const subagents = deriveThreadSubagents(activities);
  const knownSubagentIds = new Set(subagents.map((subagent) => subagent.threadId));
  const messagesByThreadId = new Map<string, ChatMessage[]>();
  const activitiesByThreadId = new Map<string, OrchestrationThreadActivity[]>();

  for (const subagent of subagents) {
    messagesByThreadId.set(subagent.threadId, []);
    activitiesByThreadId.set(subagent.threadId, []);
    if (subagent.promptPreview) {
      messagesByThreadId.get(subagent.threadId)?.push({
        id: MessageId.make(`subagent:${subagent.threadId}:prompt`),
        role: "user",
        text: subagent.promptPreview,
        createdAt: subagent.createdAt,
        streaming: false,
      });
    }
  }

  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const fallbackMessageKeys = new Set<string>();

  for (const activity of ordered) {
    const payload = asRecord(activity.payload);
    const providerThreadId = asTrimmedString(payload?.providerThreadId);
    if (providerThreadId && knownSubagentIds.has(providerThreadId)) {
      activitiesByThreadId.get(providerThreadId)?.push(activity);
      const itemType = asTrimmedString(payload?.itemType);
      const text = asTrimmedString(payload?.text ?? payload?.detail);
      const phase = asTrimmedString(payload?.phase);
      const providerTurnId = asTrimmedString(payload?.providerTurnId);
      if (activity.kind === "subagent.item.completed" && itemType === "assistant_message" && text) {
        messagesByThreadId.get(providerThreadId)?.push({
          id: MessageId.make(
            `subagent:${providerThreadId}:${asTrimmedString(payload?.itemId) ?? activity.id}`,
          ),
          role: "assistant",
          text,
          ...(providerTurnId ? { turnId: TurnId.make(providerTurnId) } : {}),
          createdAt: activity.createdAt,
          completedAt: activity.createdAt,
          streaming: false,
        });
      }
      if (activity.kind === "subagent.item.completed" && itemType === "user_message" && text) {
        messagesByThreadId.get(providerThreadId)?.push({
          id: MessageId.make(
            `subagent:${providerThreadId}:${asTrimmedString(payload?.itemId) ?? activity.id}`,
          ),
          role: "user",
          text,
          ...(providerTurnId ? { turnId: TurnId.make(providerTurnId) } : {}),
          createdAt: activity.createdAt,
          completedAt: activity.createdAt,
          streaming: false,
        });
      }
      if (phase === "final_answer" && text) {
        fallbackMessageKeys.add(`${providerThreadId}:${text}`);
      }
      continue;
    }

    if (extractWorkLogItemType(payload) !== "collab_agent_tool_call") {
      continue;
    }
    const data = asRecord(payload?.data);
    const agentsStates = asRecord(data?.agentsStates);
    if (!agentsStates) {
      continue;
    }
    for (const subagent of subagents) {
      const state = asRecord(agentsStates[subagent.threadId]);
      const message = asTrimmedString(state?.message);
      if (!message) {
        continue;
      }
      const key = `${subagent.threadId}:${message}`;
      if (fallbackMessageKeys.has(key)) {
        continue;
      }
      fallbackMessageKeys.add(key);
      messagesByThreadId.get(subagent.threadId)?.push({
        id: MessageId.make(`subagent:${subagent.threadId}:state:${activity.id}`),
        role: "assistant",
        text: message,
        createdAt: activity.createdAt,
        completedAt: activity.createdAt,
        streaming: false,
      });
    }
  }

  return subagents.map((subagent) => ({
    subagent,
    messages: (messagesByThreadId.get(subagent.threadId) ?? []).toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ),
    activities: activitiesByThreadId.get(subagent.threadId) ?? [],
  }));
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  const explicitToolIndexByKey = new Map<string, number>();
  for (const entry of entries) {
    if (entry.toolCallId && entry.collapseKey) {
      const existingIndex = explicitToolIndexByKey.get(entry.collapseKey);
      if (existingIndex !== undefined) {
        collapsed[existingIndex] = mergeDerivedWorkLogEntries(collapsed[existingIndex]!, entry);
        continue;
      }
    }

    const previous = collapsed.at(-1);
    if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
      const merged = mergeDerivedWorkLogEntries(previous, entry);
      collapsed[collapsed.length - 1] = merged;
      if (merged.toolCallId && merged.collapseKey) {
        explicitToolIndexByKey.set(merged.collapseKey, collapsed.length - 1);
      }
      continue;
    }
    collapsed.push(entry);
    if (entry.toolCallId && entry.collapseKey) {
      explicitToolIndexByKey.set(entry.collapseKey, collapsed.length - 1);
    }
  }
  return collapsed;
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (!isToolLifecycleActivityKind(previous.activityKind)) {
    return false;
  }
  if (!isToolLifecycleActivityKind(next.activityKind)) {
    return false;
  }
  if (previous.activityKind === "tool.completed") {
    return false;
  }
  if (previous.collapseKey !== undefined && previous.collapseKey === next.collapseKey) {
    return true;
  }
  return (
    previous.toolCallId !== undefined &&
    next.toolCallId === undefined &&
    previous.itemType === next.itemType &&
    normalizeCompactToolLabel(previous.toolTitle ?? previous.label) ===
      normalizeCompactToolLabel(next.toolTitle ?? next.label)
  );
}

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const changedFiles = mergeChangedFiles(previous.changedFiles, next.changedFiles);
  const detail = next.detail ?? previous.detail;
  const command = next.command ?? previous.command;
  const rawCommand = next.rawCommand ?? previous.rawCommand;
  const outputPreview = next.outputPreview ?? previous.outputPreview;
  const status = mergeWorkLogStatus(previous.status, next.status);
  const exitCode = next.exitCode ?? previous.exitCode;
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const itemType = next.itemType ?? previous.itemType;
  const requestKind = next.requestKind ?? previous.requestKind;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  const toolCallId = next.toolCallId ?? previous.toolCallId;
  const toolKey = next.toolKey ?? previous.toolKey;
  const turnId = next.turnId ?? previous.turnId;
  return {
    ...previous,
    ...next,
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(rawCommand ? { rawCommand } : {}),
    ...(outputPreview ? { outputPreview } : {}),
    ...(status ? { status } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(collapseKey ? { collapseKey } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolKey ? { toolKey } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

function mergeWorkLogStatus(
  previous: WorkLogEntry["status"] | undefined,
  next: WorkLogEntry["status"] | undefined,
): WorkLogEntry["status"] | undefined {
  if (previous === "failed" || next === "failed") {
    return "failed";
  }
  if (previous === "completed" || next === "completed") {
    return "completed";
  }
  return next ?? previous;
}

function mergeChangedFiles(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): string[] {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return [];
  }
  return [...new Set(merged)];
}

function deriveToolLifecycleCollapseKey(entry: DerivedWorkLogEntry): string | undefined {
  if (!isToolLifecycleActivityKind(entry.activityKind)) {
    return undefined;
  }
  if (entry.itemType === "collab_agent_tool_call" && entry.collabTool === "wait") {
    return `collab:wait:${entry.turnId ?? "unknown"}`;
  }
  if (entry.toolCallId) {
    return `tool:${entry.toolCallId}`;
  }
  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const detail = entry.detail?.trim() ?? "";
  const itemType = entry.itemType ?? "";
  if (normalizedLabel.length === 0 && detail.length === 0 && itemType.length === 0) {
    return undefined;
  }
  return [itemType, normalizedLabel, detail].join("\u001f");
}

function isToolLifecycleActivityKind(kind: OrchestrationThreadActivity["kind"]): boolean {
  return kind === "tool.started" || kind === "tool.updated" || kind === "tool.completed";
}

function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:started|complete|completed)\s*$/i, "").trim();
}

function toLatestProposedPlanState(proposedPlan: ProposedPlan): LatestProposedPlanState {
  return {
    id: proposedPlan.id,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    streaming: proposedPlan.streaming === true,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstString(...values: Array<string | null | undefined>): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function extractStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function isTerminalOutputPreviewStream(value: unknown): value is TerminalOutputPreview["stream"] {
  return value === "stdout" || value === "stderr" || value === "mixed" || value === "unknown";
}

function normalizeTerminalOutputPreviewLine(value: string): {
  line: string | null;
  truncated: boolean;
} {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { line: null, truncated: false };
  }
  if (trimmed.length <= TERMINAL_OUTPUT_PREVIEW_LINE_MAX_LENGTH) {
    return { line: trimmed, truncated: false };
  }
  return {
    line: `${trimmed.slice(0, TERMINAL_OUTPUT_PREVIEW_LINE_MAX_LENGTH - 1)}…`,
    truncated: true,
  };
}

function outputPreviewFromText(
  text: string,
  stream: TerminalOutputPreview["stream"],
): TerminalOutputPreview | null {
  let truncated = false;
  const lines = text
    .split(/\r\n|\n|\r/u)
    .map((line) => {
      const normalized = normalizeTerminalOutputPreviewLine(line);
      truncated = truncated || normalized.truncated;
      return normalized.line;
    })
    .filter((line): line is string => line !== null);
  if (lines.length === 0) {
    return null;
  }
  const droppedLines = lines.length > TERMINAL_OUTPUT_PREVIEW_LINE_COUNT;
  return {
    lines: droppedLines ? lines.slice(-TERMINAL_OUTPUT_PREVIEW_LINE_COUNT) : lines,
    stream,
    truncated: truncated || droppedLines,
  };
}

function outputPreviewFromNormalizedData(
  data: Record<string, unknown> | null,
): TerminalOutputPreview | null {
  const preview = asRecord(data?.outputPreview);
  if (!preview || !Array.isArray(preview.lines)) {
    return null;
  }
  const lines: string[] = [];
  let truncated = preview.truncated === true;
  for (const entry of preview.lines) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = normalizeTerminalOutputPreviewLine(entry);
    truncated = truncated || normalized.truncated;
    if (normalized.line) {
      lines.push(normalized.line);
    }
  }
  if (lines.length === 0) {
    return null;
  }
  const droppedLines = lines.length > TERMINAL_OUTPUT_PREVIEW_LINE_COUNT;
  return {
    lines: droppedLines ? lines.slice(-TERMINAL_OUTPUT_PREVIEW_LINE_COUNT) : lines,
    stream: isTerminalOutputPreviewStream(preview.stream) ? preview.stream : "unknown",
    truncated: truncated || droppedLines,
  };
}

function rawOutputIndicatesFailure(
  payload: Record<string, unknown> | null,
  rawOutput: Record<string, unknown>,
): boolean {
  const rawStatus = asTrimmedString(rawOutput.status)?.toLowerCase();
  const payloadStatus = asTrimmedString(payload?.status)?.toLowerCase();
  const exitCode = asNumber(rawOutput.exitCode);
  const detailExitCode =
    typeof payload?.detail === "string"
      ? stripTrailingExitCode(payload.detail).exitCode
      : undefined;
  return (
    (exitCode !== null && exitCode !== 0) ||
    (detailExitCode !== undefined && detailExitCode !== 0) ||
    rawStatus === "failed" ||
    rawStatus === "error" ||
    payloadStatus === "failed" ||
    payloadStatus === "error"
  );
}

function extractCommandExitCode(payload: Record<string, unknown> | null): number | null {
  const data = asRecord(payload?.data);
  const rawOutput = asRecord(data?.rawOutput);
  const rawExitCode = asNumber(rawOutput?.exitCode);
  if (rawExitCode !== null) {
    return Math.trunc(rawExitCode);
  }
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const resultExitCode = asNumber(itemResult?.exitCode);
  if (resultExitCode !== null) {
    return Math.trunc(resultExitCode);
  }
  if (typeof payload?.detail === "string") {
    return stripTrailingExitCode(payload.detail).exitCode ?? null;
  }
  return null;
}

function extractCommandStatus(
  payload: Record<string, unknown> | null,
  activityKind: OrchestrationThreadActivity["kind"],
  itemType: WorkLogEntry["itemType"] | undefined,
): WorkLogEntry["status"] | undefined {
  if (itemType === "file_change") {
    const payloadStatus = normalizeRuntimeStatus(payload?.status);
    if (payloadStatus === "failed" || payloadStatus === "error") {
      return "failed";
    }
    if (activityKind === "tool.completed" || payloadStatus === "completed") {
      return "completed";
    }
    return "running";
  }

  if (itemType !== "command_execution") {
    return undefined;
  }
  const data = asRecord(payload?.data);
  const rawOutput = asRecord(data?.rawOutput);
  const rawStatus = normalizeRuntimeStatus(rawOutput?.status);
  const payloadStatus = normalizeRuntimeStatus(payload?.status);
  const exitCode = extractCommandExitCode(payload);
  if (
    (exitCode !== null && exitCode !== 0) ||
    rawStatus === "failed" ||
    rawStatus === "error" ||
    payloadStatus === "failed" ||
    payloadStatus === "error"
  ) {
    return "failed";
  }
  if (
    activityKind === "tool.completed" ||
    payloadStatus === "completed" ||
    rawStatus === "completed"
  ) {
    return "completed";
  }
  return "running";
}

function extractCollabWorkLogStatus(
  payload: Record<string, unknown> | null,
  activityKind: OrchestrationThreadActivity["kind"],
  itemType: WorkLogEntry["itemType"] | undefined,
): WorkLogEntry["status"] | undefined {
  if (itemType !== "collab_agent_tool_call") {
    return undefined;
  }
  const statuses = collabAgentStatuses(payload);
  if (statuses.some((status) => status === "failed")) {
    return "failed";
  }
  if (
    statuses.length > 0 &&
    statuses.every((status) => status === "completed" || status === "closed")
  ) {
    return "completed";
  }
  if (activityKind === "tool.completed") {
    return "completed";
  }
  return "running";
}

function normalizeRuntimeStatus(value: unknown): string | undefined {
  return asTrimmedString(value)
    ?.replace(/[_\s-]+/g, "")
    .toLowerCase();
}

function outputPreviewFromRawOutput(
  payload: Record<string, unknown> | null,
  data: Record<string, unknown> | null,
): TerminalOutputPreview | null {
  const rawOutput = asRecord(data?.rawOutput);
  if (!rawOutput) {
    return null;
  }

  const stdout = asTrimmedString(rawOutput.stdout);
  const stderr = asTrimmedString(rawOutput.stderr);
  if (stderr && (rawOutputIndicatesFailure(payload, rawOutput) || !stdout)) {
    return outputPreviewFromText(stderr, "stderr");
  }
  if (stdout && stderr) {
    return outputPreviewFromText(`${stdout}\n${stderr}`, "mixed");
  }
  if (stdout) {
    return outputPreviewFromText(stdout, "stdout");
  }
  return null;
}

function extractCommandOutputPreview(
  payload: Record<string, unknown> | null,
  itemType: WorkLogEntry["itemType"] | undefined,
): WorkLogEntry["outputPreview"] | undefined {
  if (itemType !== "command_execution") {
    return undefined;
  }
  const data = asRecord(payload?.data);
  return (
    outputPreviewFromNormalizedData(data) ?? outputPreviewFromRawOutput(payload, data) ?? undefined
  );
}

function trimMatchingOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    const unquoted = trimmed.slice(1, -1).trim();
    return unquoted.length > 0 ? unquoted : trimmed;
  }
  return trimmed;
}

function executableBasename(value: string): string | null {
  const trimmed = trimMatchingOuterQuotes(value);
  if (trimmed.length === 0) {
    return null;
  }
  const normalized = trimmed.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const last = segments.at(-1)?.trim() ?? "";
  return last.length > 0 ? last.toLowerCase() : null;
}

function splitExecutableAndRest(value: string): { executable: string; rest: string } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed.charAt(0);
    const closeIndex = trimmed.indexOf(quote, 1);
    if (closeIndex <= 0) {
      return null;
    }
    return {
      executable: trimmed.slice(0, closeIndex + 1),
      rest: trimmed.slice(closeIndex + 1).trim(),
    };
  }

  const firstWhitespace = trimmed.search(/\s/);
  if (firstWhitespace < 0) {
    return {
      executable: trimmed,
      rest: "",
    };
  }

  return {
    executable: trimmed.slice(0, firstWhitespace),
    rest: trimmed.slice(firstWhitespace).trim(),
  };
}

const SHELL_WRAPPER_SPECS = [
  {
    executables: ["pwsh", "pwsh.exe", "powershell", "powershell.exe"],
    wrapperFlagPattern: /(?:^|\s)-command\s+/i,
  },
  {
    executables: ["cmd", "cmd.exe"],
    wrapperFlagPattern: /(?:^|\s)\/c\s+/i,
  },
  {
    executables: ["bash", "sh", "zsh"],
    wrapperFlagPattern: /(?:^|\s)-(?:l)?c\s+/i,
  },
] as const;

function findShellWrapperSpec(shell: string) {
  return SHELL_WRAPPER_SPECS.find((spec) =>
    (spec.executables as ReadonlyArray<string>).includes(shell),
  );
}

function unwrapCommandRemainder(value: string, wrapperFlagPattern: RegExp): string | null {
  const match = wrapperFlagPattern.exec(value);
  if (!match) {
    return null;
  }

  const command = value.slice(match.index + match[0].length).trim();
  if (command.length === 0) {
    return null;
  }

  const unwrapped = trimMatchingOuterQuotes(command);
  return unwrapped.length > 0 ? unwrapped : null;
}

function unwrapKnownShellCommandWrapper(value: string): string {
  const split = splitExecutableAndRest(value);
  if (!split || split.rest.length === 0) {
    return value;
  }

  const shell = executableBasename(split.executable);
  if (!shell) {
    return value;
  }

  const spec = findShellWrapperSpec(shell);
  if (!spec) {
    return value;
  }

  return unwrapCommandRemainder(split.rest, spec.wrapperFlagPattern) ?? value;
}

function formatCommandArrayPart(value: string): string {
  return /[\s"'`]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function formatCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== null);
  if (parts.length === 0) {
    return null;
  }
  return parts.map((part) => formatCommandArrayPart(part)).join(" ");
}

function normalizeCommandValue(value: unknown): string | null {
  const formatted = formatCommandValue(value);
  return formatted ? unwrapKnownShellCommandWrapper(formatted) : null;
}

function toRawToolCommand(value: unknown, normalizedCommand: string | null): string | null {
  const formatted = formatCommandValue(value);
  if (!formatted || normalizedCommand === null) {
    return null;
  }
  return formatted === normalizedCommand ? null : formatted;
}

function extractToolCommand(payload: Record<string, unknown> | null): {
  command: string | null;
  rawCommand: string | null;
} {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const itemType = asTrimmedString(payload?.itemType);
  const detail = asTrimmedString(payload?.detail);
  const candidates: unknown[] = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
    itemType === "command_execution" && detail ? stripTrailingExitCode(detail).output : null,
  ];

  for (const candidate of candidates) {
    const command = normalizeCommandValue(candidate);
    if (!command) {
      continue;
    }
    return {
      command,
      rawCommand: toRawToolCommand(candidate, command),
    };
  }

  return {
    command: null,
    rawCommand: null,
  };
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
}

function extractToolCallId(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  return asTrimmedString(data?.toolCallId);
}

function extractCollabTool(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  return asTrimmedString(data?.collabTool);
}

function extractCollabReceiverThreadIds(payload: Record<string, unknown> | null): string[] {
  const data = asRecord(payload?.data);
  return extractStringArray(data?.receiverThreadIds);
}

function collabAgentStatuses(payload: Record<string, unknown> | null): ThreadSubagentStatus[] {
  const data = asRecord(payload?.data);
  const agentsStates = asRecord(data?.agentsStates);
  const receiverThreadIds = extractCollabReceiverThreadIds(payload);
  const statuses: ThreadSubagentStatus[] = [];
  for (const receiverThreadId of receiverThreadIds) {
    const agentState = asRecord(agentsStates?.[receiverThreadId]);
    const status = normalizeSubagentStatus(
      asTrimmedString(agentState?.status ?? agentState?.state),
    );
    if (status) {
      statuses.push(status);
    }
  }
  const dataStatus = normalizeSubagentStatus(asTrimmedString(data?.status));
  if (statuses.length === 0 && dataStatus) {
    statuses.push(dataStatus);
  }
  return statuses;
}

function isTerminalSubagentStatus(status: ThreadSubagentStatus): boolean {
  return status === "completed" || status === "failed" || status === "closed";
}

function formatCollabWorkLogLabel(
  payload: Record<string, unknown> | null,
  collabTool: string | null,
): string | null {
  if (collabTool !== "wait") {
    return null;
  }
  const receiverThreadIds = extractCollabReceiverThreadIds(payload);
  const total = receiverThreadIds.length;
  if (total <= 1) {
    return "Waiting on subagent";
  }
  const statuses = collabAgentStatuses(payload);
  const completeCount = statuses.filter(isTerminalSubagentStatus).length;
  return `Waiting on subagents (${completeCount}/${total} complete)`;
}

function normalizeSubagentStatus(value: string | null): ThreadSubagentStatus | null {
  switch (value?.toLowerCase()) {
    case "running":
    case "active":
    case "inprogress":
    case "in_progress":
    case "pending":
      return "running";
    case "completed":
    case "complete":
    case "idle":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "closed":
    case "cancelled":
    case "canceled":
    case "stopped":
      return "closed";
    default:
      return null;
  }
}

function resolveSubagentStatus({
  collabTool,
  lifecycleStatus,
  agentStatus,
  previousStatus,
}: {
  collabTool: string | null;
  lifecycleStatus: WorkLogEntry["status"] | undefined;
  agentStatus: ThreadSubagentStatus | null;
  previousStatus: ThreadSubagentStatus | undefined;
}): ThreadSubagentStatus {
  if (collabTool === "closeAgent" && lifecycleStatus === "completed") {
    return "closed";
  }
  if (agentStatus) {
    return agentStatus;
  }
  if (lifecycleStatus === "failed") {
    return "failed";
  }
  if (collabTool === "spawnAgent" && lifecycleStatus === "completed") {
    return previousStatus ?? "running";
  }
  return previousStatus ?? (lifecycleStatus === "completed" ? "completed" : "running");
}

function normalizeInlinePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateInlinePreview(value: string, maxLength = 84): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizePreviewForComparison(value: string | null | undefined): string | null {
  const normalized = asTrimmedString(value);
  if (!normalized) {
    return null;
  }
  return normalizeCompactToolLabel(normalizeInlinePreview(normalized)).toLowerCase();
}

function summarizeToolTextOutput(value: string): string | null {
  const lines = value
    .split(/\r?\n/u)
    .map((line) => normalizeInlinePreview(line))
    .filter((line) => line.length > 0);
  const firstLine = lines.find((line) => line !== "```");
  if (firstLine) {
    return truncateInlinePreview(firstLine);
  }
  if (lines.length > 1) {
    return `${lines.length.toLocaleString()} lines`;
  }
  return null;
}

function summarizeToolRawOutput(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const rawOutput = asRecord(data?.rawOutput);
  if (!rawOutput) {
    return null;
  }

  const totalFiles = asNumber(rawOutput.totalFiles);
  if (totalFiles !== null) {
    const suffix = rawOutput.truncated === true ? "+" : "";
    return `${totalFiles.toLocaleString()} file${totalFiles === 1 ? "" : "s"}${suffix}`;
  }

  const content = asTrimmedString(rawOutput.content);
  if (content) {
    return summarizeToolTextOutput(content);
  }

  const stdout = asTrimmedString(rawOutput.stdout);
  if (stdout) {
    return summarizeToolTextOutput(stdout);
  }

  return null;
}

function isCommandToolDetail(payload: Record<string, unknown> | null, heading: string): boolean {
  const data = asRecord(payload?.data);
  const kind = asTrimmedString(data?.kind)?.toLowerCase();
  const title = asTrimmedString(payload?.title ?? heading)?.toLowerCase();
  return (
    extractWorkLogItemType(payload) === "command_execution" ||
    kind === "execute" ||
    title === "terminal" ||
    title === "ran command"
  );
}

function extractToolDetail(
  payload: Record<string, unknown> | null,
  heading: string,
): string | null {
  const rawDetail = asTrimmedString(payload?.detail);
  const detail = rawDetail ? stripTrailingExitCode(rawDetail).output : null;
  const normalizedHeading = normalizePreviewForComparison(heading);
  const normalizedDetail = normalizePreviewForComparison(detail);

  if (detail && normalizedHeading !== normalizedDetail) {
    return detail;
  }

  if (isCommandToolDetail(payload, heading)) {
    return null;
  }

  const rawOutputSummary = summarizeToolRawOutput(payload);
  if (rawOutputSummary) {
    const normalizedRawOutputSummary = normalizePreviewForComparison(rawOutputSummary);
    if (normalizedRawOutputSummary !== normalizedHeading) {
      return rawOutputSummary;
    }
  }

  return null;
}

function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(
    trimmed,
  );
  if (!match?.groups) {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const normalizedOutput = match.groups.output?.trim() ?? "";
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): WorkLogEntry["itemType"] | undefined {
  if (typeof payload?.itemType === "string" && isToolLifecycleItemType(payload.itemType)) {
    return payload.itemType;
  }
  return undefined;
}

function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
): WorkLogEntry["requestKind"] | undefined {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  collectChangedFiles(asRecord(payload?.data), changedFiles, seen, 0);
  return changedFiles;
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  const lifecycleRankComparison =
    compareActivityLifecycleRank(left.kind) - compareActivityLifecycleRank(right.kind);
  if (lifecycleRankComparison !== 0) {
    return lifecycleRankComparison;
  }

  return left.id.localeCompare(right.id);
}

function compareActivityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
}

export function hasToolActivityForTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null | undefined,
): boolean {
  if (!turnId) return false;
  return activities.some((activity) => activity.turnId === turnId && activity.tone === "tool");
}

function formatApprovalActivityLabel(requestKind: PendingApproval["requestKind"] | undefined) {
  switch (requestKind) {
    case "command":
      return "Waiting for command approval";
    case "file-read":
      return "Waiting for file-read approval";
    case "file-change":
      return "Waiting for file-change approval";
    default:
      return "Waiting for approval";
  }
}

function labelForToolActivity(entry: WorkLogEntry): string {
  const activityGroupKind = classifyToolActivityGroup({
    itemType: entry.itemType,
    title: entry.toolTitle,
    label: entry.label,
    command: entry.command,
    detail: entry.detail,
    changedFiles: entry.changedFiles,
    requestKind: entry.requestKind,
  });
  if (activityGroupKind === "exploration") {
    return "Exploring...";
  }
  if (activityGroupKind === "validation") {
    return "Running checks";
  }

  switch (entry.itemType) {
    case "command_execution":
      return "Running terminal";
    case "file_change":
      return "Applying patch";
    case "mcp_tool_call":
      return "Calling MCP tool";
    case "dynamic_tool_call":
      return "Running tool";
    case "collab_agent_tool_call":
      switch (entry.collabTool) {
        case "spawnAgent":
          return "Spawned subagent";
        case "sendInput":
          return "Sent input to subagent";
        case "resumeAgent":
          return "Resumed subagent";
        case "wait":
          return entry.label;
        case "closeAgent":
          return "Closed subagent";
        default:
          return "Running subagent";
      }
    case "web_search":
      return "Searching web";
    case "image_view":
      return "Viewing image";
    default:
      return entry.toolTitle ? `Running ${entry.toolTitle}` : "Running tool";
  }
}

function detailForToolActivity(entry: WorkLogEntry): string | undefined {
  return entry.command ?? entry.detail;
}

function activeToolLifecycleKey(activity: OrchestrationThreadActivity): string | null {
  const entry = toDerivedWorkLogEntry(activity);
  return entry.toolCallId ?? entry.collapseKey ?? null;
}

function deriveActiveToolActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null | undefined,
): WorkLogEntry | null {
  if (!turnId) {
    return null;
  }

  const activeByKey = new Map<string, OrchestrationThreadActivity>();
  const terminalKeys = new Set<string>();
  const ordered = [...activities]
    .filter((activity) => activity.turnId === turnId && activity.tone === "tool")
    .filter(
      (activity) =>
        activity.kind === "tool.started" ||
        activity.kind === "tool.updated" ||
        activity.kind === "tool.completed",
    )
    .toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const key = activeToolLifecycleKey(activity) ?? activity.id;
    if (activity.kind === "tool.completed") {
      activeByKey.delete(key);
      terminalKeys.add(key);
      continue;
    }
    if (terminalKeys.has(key)) {
      continue;
    }
    activeByKey.set(key, activity);
  }

  const latest = [...activeByKey.values()].at(-1);
  if (!latest) {
    return null;
  }
  const {
    activityKind: _activityKind,
    collapseKey: _collapseKey,
    ...entry
  } = toDerivedWorkLogEntry(latest);
  return entry;
}

function hasStreamingAssistantMessageForTurn(
  messages: ReadonlyArray<ChatMessage>,
  turnId: TurnId | null | undefined,
): boolean {
  if (!turnId) return false;
  return messages.some(
    (message) => message.role === "assistant" && message.turnId === turnId && message.streaming,
  );
}

function hasThinkingActivityForTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null | undefined,
): boolean {
  if (!turnId) return false;
  return activities.some(
    (activity) =>
      activity.turnId === turnId &&
      (activity.kind === "task.progress" || activity.kind === "turn.plan.updated"),
  );
}

export function deriveActiveTurnActivityState(input: {
  session: ThreadSession | null;
  latestTurn: OrchestrationLatestTurn | null;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  messages: ReadonlyArray<ChatMessage>;
  pendingApprovals: ReadonlyArray<PendingApproval>;
  pendingUserInputs: ReadonlyArray<PendingUserInput>;
  isSendBusy: boolean;
  isConnecting: boolean;
  isRevertingCheckpoint: boolean;
}): ActiveTurnActivityState {
  const activeTurnId =
    input.session?.orchestrationStatus === "running"
      ? (input.session.activeTurnId ?? input.latestTurn?.turnId ?? null)
      : input.latestTurn?.completedAt === null
        ? input.latestTurn.turnId
        : null;
  const isRunning = input.session?.orchestrationStatus === "running" || activeTurnId !== null;

  const activeApproval = input.pendingApprovals[0];
  if (activeApproval) {
    return {
      kind: "awaitingApproval",
      label: formatApprovalActivityLabel(activeApproval.requestKind),
      ...(activeApproval.detail ? { detail: activeApproval.detail } : {}),
    };
  }

  const activeUserInput = input.pendingUserInputs[0];
  if (activeUserInput) {
    return {
      kind: "awaitingUserInput",
      label: "Waiting for your answer",
      detail: activeUserInput.questions[0]?.question,
    };
  }

  if (input.isSendBusy) {
    return { kind: "dispatching", label: "Sending request" };
  }

  if (input.isConnecting) {
    return { kind: "connecting", label: "Connecting provider" };
  }

  const activeTool = deriveActiveToolActivity(input.activities, activeTurnId);
  if (activeTool) {
    return {
      kind: "runningTool",
      label: labelForToolActivity(activeTool),
      detail: detailForToolActivity(activeTool),
    };
  }

  if (hasStreamingAssistantMessageForTurn(input.messages, activeTurnId)) {
    return { kind: "streamingAssistant", label: "Streaming response" };
  }

  if (hasThinkingActivityForTurn(input.activities, activeTurnId)) {
    return { kind: "thinking", label: "Thinking" };
  }

  if (isRunning) {
    return { kind: "waitingForModel", label: "Waiting for model stream" };
  }

  if (input.isRevertingCheckpoint) {
    return { kind: "finalizing", label: "Finalizing" };
  }

  return { kind: "idle", label: "" };
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  proposedPlans: ProposedPlan[],
  workEntries: WorkLogEntry[],
): TimelineEntry[] {
  const messageRows: TimelineEntry[] = messages
    .filter(
      (message) =>
        message.source !== "harness" &&
        !message.text.trimStart().startsWith("PLEASE IMPLEMENT THIS PLAN:"),
    )
    .map((message) => ({
      id: message.id,
      kind: "message",
      createdAt: message.createdAt,
      message,
    }));
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }));
  const workRows: TimelineEntry[] = workEntries.map((entry) => ({
    id: entry.id,
    kind: "work",
    createdAt: entry.createdAt,
    entry,
  }));
  return [...messageRows, ...proposedPlanRows, ...workRows].toSorted((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

export function deriveCompletionDividerBeforeEntryId(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  latestTurn: Pick<
    OrchestrationLatestTurn,
    "assistantMessageId" | "startedAt" | "completedAt"
  > | null,
): string | null {
  if (!latestTurn?.startedAt || !latestTurn.completedAt) {
    return null;
  }

  if (latestTurn.assistantMessageId) {
    const exactMatch = timelineEntries.find(
      (timelineEntry) =>
        timelineEntry.kind === "message" &&
        timelineEntry.message.role === "assistant" &&
        timelineEntry.message.id === latestTurn.assistantMessageId,
    );
    if (exactMatch) {
      return exactMatch.id;
    }
  }

  const turnStartedAt = Date.parse(latestTurn.startedAt);
  const turnCompletedAt = Date.parse(latestTurn.completedAt);
  if (Number.isNaN(turnStartedAt) || Number.isNaN(turnCompletedAt)) {
    return null;
  }

  let inRangeMatch: string | null = null;
  let fallbackMatch: string | null = null;
  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message" || timelineEntry.message.role !== "assistant") {
      continue;
    }
    const messageAt = Date.parse(timelineEntry.message.createdAt);
    if (Number.isNaN(messageAt) || messageAt < turnStartedAt) {
      continue;
    }
    fallbackMatch = timelineEntry.id;
    if (messageAt <= turnCompletedAt) {
      inRangeMatch = timelineEntry.id;
    }
  }
  return inRangeMatch ?? fallbackMatch;
}

export function inferCheckpointTurnCountByTurnId(
  summaries: TurnDiffSummary[],
): Record<TurnId, number> {
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<TurnId, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}
