import {
  type EnvironmentId,
  isProviderDriverKind,
  ProjectId,
  type ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ProviderDriverKind,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { type ChatMessage, type SessionPhase, type Thread, type ThreadSession } from "../types";
import { type ComposerImageAttachment, type DraftThreadState } from "../composerDraftStore";
import { Schema } from "effect";
import { selectThreadByRef, useStore } from "../store";
import {
  appendTerminalContextsToPrompt,
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import type { DraftThreadEnvMode } from "../composerDraftStore";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";
export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;

export type ThreadDetailBackfillResource = "activities" | "proposedPlans" | "checkpoints";

export interface ThreadDetailBackfillRequest {
  resource: ThreadDetailBackfillResource;
  requestKey: string;
  nextResourceOffset: number;
}

export function shouldAutoloadOlderMessages(input: {
  scrollTop: number;
  isAtBottom: boolean;
  isThreadRunning: boolean;
  thresholdPx: number;
}): boolean {
  return !input.isThreadRunning && !input.isAtBottom && input.scrollTop <= input.thresholdPx;
}

const THREAD_DETAIL_BACKFILL_RESOURCES: readonly ThreadDetailBackfillResource[] = [
  "activities",
  "proposedPlans",
  "checkpoints",
];

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
  error: string | null,
): Thread {
  return {
    id: threadId,
    environmentId: draftThread.environmentId,
    codexThreadId: null,
    projectId: draftThread.projectId,
    title: "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    error,
    createdAt: draftThread.createdAt,
    archivedAt: null,
    latestTurn: null,
    totalWorkDurationMs: 0,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
  };
}

export function deriveThreadDetailBackfillRequest(input: {
  thread: Pick<
    Thread,
    | "id"
    | "messages"
    | "activities"
    | "proposedPlans"
    | "turnDiffSummaries"
    | "activityPageInfo"
    | "proposedPlanPageInfo"
    | "checkpointPageInfo"
  >;
  resourceOffset?: number;
}): ThreadDetailBackfillRequest | null {
  const oldestLoadedMessageAt = input.thread.messages[0]?.createdAt;
  if (!oldestLoadedMessageAt) {
    return null;
  }

  const resourceOffset =
    Math.max(0, Math.floor(input.resourceOffset ?? 0)) % THREAD_DETAIL_BACKFILL_RESOURCES.length;
  for (let index = 0; index < THREAD_DETAIL_BACKFILL_RESOURCES.length; index += 1) {
    const resourceIndex = (resourceOffset + index) % THREAD_DETAIL_BACKFILL_RESOURCES.length;
    const resource = THREAD_DETAIL_BACKFILL_RESOURCES[resourceIndex];
    if (!resource) {
      continue;
    }
    const firstLoadedAt = firstLoadedThreadDetailResourceTimestamp(input.thread, resource);
    if (!firstLoadedAt || firstLoadedAt <= oldestLoadedMessageAt) {
      continue;
    }
    if (!threadDetailResourceHasMoreBefore(input.thread, resource)) {
      continue;
    }

    const cursor = firstLoadedThreadDetailResourceCursor(input.thread, resource);
    if (cursor === null) {
      continue;
    }

    return {
      resource,
      requestKey: `${input.thread.id}:${resource}:${cursor}:${oldestLoadedMessageAt}`,
      nextResourceOffset: (resourceIndex + 1) % THREAD_DETAIL_BACKFILL_RESOURCES.length,
    };
  }

  return null;
}

function firstLoadedThreadDetailResourceTimestamp(
  thread: Pick<Thread, "activities" | "proposedPlans" | "turnDiffSummaries">,
  resource: ThreadDetailBackfillResource,
): string | null {
  if (resource === "activities") {
    return thread.activities[0]?.createdAt ?? null;
  }
  if (resource === "proposedPlans") {
    return thread.proposedPlans[0]?.createdAt ?? null;
  }
  return thread.turnDiffSummaries[0]?.completedAt ?? null;
}

function firstLoadedThreadDetailResourceCursor(
  thread: Pick<Thread, "activities" | "proposedPlans" | "turnDiffSummaries">,
  resource: ThreadDetailBackfillResource,
): string | number | null {
  if (resource === "activities") {
    return thread.activities[0]?.id ?? null;
  }
  if (resource === "proposedPlans") {
    return thread.proposedPlans[0]?.id ?? null;
  }
  return thread.turnDiffSummaries[0]?.checkpointTurnCount ?? null;
}

function threadDetailResourceHasMoreBefore(
  thread: Pick<Thread, "activityPageInfo" | "proposedPlanPageInfo" | "checkpointPageInfo">,
  resource: ThreadDetailBackfillResource,
): boolean {
  if (resource === "activities") {
    return thread.activityPageInfo?.hasMoreBefore === true;
  }
  if (resource === "proposedPlans") {
    return thread.proposedPlanPageInfo?.hasMoreBefore === true;
  }
  return thread.checkpointPageInfo?.hasMoreBefore === true;
}

export function shouldWriteThreadErrorToCurrentServerThread(input: {
  serverThread:
    | {
        environmentId: EnvironmentId;
        id: ThreadId;
      }
    | null
    | undefined;
  routeThreadRef: ScopedThreadRef;
  targetThreadId: ThreadId;
}): boolean {
  return Boolean(
    input.serverThread &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    input.serverThread.environmentId === input.routeThreadRef.environmentId &&
    input.serverThread.id === input.targetThreadId,
  );
}

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): string[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) => threadId !== input.activeThreadId && openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(
    0,
    input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  );
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadTerminalOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

export function resolveSendEnvMode(input: {
  requestedEnvMode: DraftThreadEnvMode;
  isGitRepo: boolean;
}): DraftThreadEnvMode {
  return input.isGitRepo ? input.requestedEnvMode : "local";
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 || options.imageCount > 0 || sendableTerminalContexts.length > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export interface QueuedComposerMessageLike<TAttachment = unknown> {
  readonly text: string;
  readonly attachments: ReadonlyArray<TAttachment>;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
}

export interface DeletableQueuedComposerMessageLike {
  readonly id: string;
  readonly attachments: ReadonlyArray<{ readonly previewUrl?: string }>;
}

export function deleteQueuedComposerMessage<TMessage extends DeletableQueuedComposerMessageLike>(
  messages: ReadonlyArray<TMessage>,
  messageId: string,
  revokePreviewUrl: (previewUrl: string | undefined) => void = revokeBlobPreviewUrl,
): TMessage[] {
  const next: TMessage[] = [];

  for (const message of messages) {
    if (message.id !== messageId) {
      next.push(message);
      continue;
    }

    for (const attachment of message.attachments) {
      revokePreviewUrl(attachment.previewUrl);
    }
  }

  return next;
}

export type BuildQueuedComposerFlushResult<TAttachment = unknown> =
  | {
      readonly ok: true;
      readonly text: string;
      readonly attachments: TAttachment[];
    }
  | {
      readonly ok: false;
      readonly reason: "too-many-attachments";
      readonly attachmentCount: number;
      readonly maxAttachmentCount: number;
    };

export function buildQueuedComposerFlush<TAttachment>(
  messages: ReadonlyArray<QueuedComposerMessageLike<TAttachment>>,
): BuildQueuedComposerFlushResult<TAttachment> {
  const attachmentCount = messages.reduce(
    (count, message) => count + message.attachments.length,
    0,
  );
  if (attachmentCount > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    return {
      ok: false,
      reason: "too-many-attachments",
      attachmentCount,
      maxAttachmentCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
    };
  }

  return {
    ok: true,
    text: messages
      .map((message, index) => {
        const text = appendTerminalContextsToPrompt(message.text, message.terminalContexts).trim();
        return `Queued message ${index + 1}:\n${text}`;
      })
      .join("\n\n"),
    attachments: messages.flatMap((message) => [...message.attachments]),
  };
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

// `threadProvider` is the open branded driver kind carried by the session.
// Unknown driver kinds degrade to `null` (i.e. "unlocked"), which is the safe
// rollback / fork behavior — the routing layer is the right place to surface
// "driver not installed" errors, not the lock state.
//
// `selectedProvider` takes the same open-string shape because the composer
// now tracks the picker selection as a `ProviderInstanceId` (e.g.
// `codex_personal`). Custom instance ids that don't directly match a
// registered driver resolve to `null` here, which matches the existing
// "unknown driver -> unlocked" semantics. Callers that want the lock to track
// a custom instance's underlying driver kind should resolve the instance id
// upstream and pass the correlated kind.
export function deriveLockedProvider(input: {
  thread: Thread | null | undefined;
  selectedProvider: string | null;
  threadProvider: string | null;
}): ProviderDriverKind | null {
  if (!threadHasStarted(input.thread)) {
    return null;
  }
  const sessionProvider = input.thread?.session?.provider ?? null;
  if (sessionProvider) {
    return sessionProvider;
  }
  const narrowedThreadProvider =
    input.threadProvider && isProviderDriverKind(input.threadProvider)
      ? input.threadProvider
      : null;
  const narrowedSelectedProvider =
    input.selectedProvider && isProviderDriverKind(input.selectedProvider)
      ? input.selectedProvider
      : null;
  return narrowedThreadProvider ?? narrowedSelectedProvider ?? null;
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const getThread = () => selectThreadByRef(useStore.getState(), threadRef);
  const thread = getThread();

  if (threadHasStarted(thread)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = useStore.subscribe((state) => {
      if (!threadHasStarted(selectThreadByRef(state, threadRef))) {
        return;
      }
      finish(true);
    });

    if (threadHasStarted(getThread())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionOrchestrationStatus: ThreadSession["orchestrationStatus"] | null;
  sessionUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: { preparingWorktree?: boolean },
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionOrchestrationStatus: session?.orchestrationStatus ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  session: Thread["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;
  const latestTurnChanged =
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null);

  if (input.phase === "running") {
    if (!latestTurnChanged) {
      return false;
    }
    if (latestTurn?.startedAt === null || latestTurn === null) {
      return false;
    }
    if (
      session?.activeTurnId !== undefined &&
      session.activeTurnId !== null &&
      latestTurn?.turnId !== session.activeTurnId
    ) {
      return false;
    }
    return true;
  }

  return (
    latestTurnChanged ||
    input.localDispatch.sessionOrchestrationStatus !== (session?.orchestrationStatus ?? null) ||
    input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}
