import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import type { Thread } from "./types";

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;
const textEncoder = new TextEncoder();
const ESTIMATED_CHARS_PER_TOKEN = 4;
const MIN_TOKEN_RATE_WINDOW_MS = 2_000;
const MAX_REASONABLE_TOKENS_PER_SECOND = 500;

export interface ThreadStatusStats {
  loadedDataBytes: number;
  tokensPerSecond: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function reasonableTokenRate(tokensPerSecond: number): number | null {
  if (
    !Number.isFinite(tokensPerSecond) ||
    tokensPerSecond <= 0 ||
    tokensPerSecond > MAX_REASONABLE_TOKENS_PER_SECOND
  ) {
    return null;
  }
  return tokensPerSecond;
}

function outputTokenCount(payload: Record<string, unknown>): number | null {
  const lastOutputTokens = finiteNumber(payload.lastOutputTokens);
  if (lastOutputTokens !== null && lastOutputTokens >= 0) {
    const lastReasoningOutputTokens = finiteNumber(payload.lastReasoningOutputTokens);
    return lastOutputTokens + Math.max(0, lastReasoningOutputTokens ?? 0);
  }

  const outputTokens = finiteNumber(payload.outputTokens);
  if (outputTokens !== null && outputTokens >= 0) {
    const reasoningOutputTokens = finiteNumber(payload.reasoningOutputTokens);
    return outputTokens + Math.max(0, reasoningOutputTokens ?? 0);
  }

  return null;
}

function deriveProviderReportedTokensPerSecond(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): number | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    if (!payload) {
      continue;
    }

    const outputTokens = outputTokenCount(payload);
    const durationMs = finiteNumber(payload.durationMs);
    if (outputTokens === null || durationMs === null || durationMs < MIN_TOKEN_RATE_WINDOW_MS) {
      continue;
    }

    const rate = reasonableTokenRate(outputTokens / (durationMs / 1000));
    if (rate !== null) {
      return rate;
    }
  }

  return null;
}

function estimateTokensFromText(text: string): number {
  return Math.max(0, text.trim().length / ESTIMATED_CHARS_PER_TOKEN);
}

function deriveStreamingTextTokensPerSecond(
  thread: Pick<Thread, "messages">,
  nowMs: number,
): number | null {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (
      !message ||
      message.role !== "assistant" ||
      !message.streaming ||
      message.text.length === 0
    ) {
      continue;
    }

    const startedAtMs = positiveTimestamp(message.createdAt);
    if (startedAtMs === null) {
      continue;
    }

    const elapsedMs = nowMs - startedAtMs;
    if (elapsedMs < MIN_TOKEN_RATE_WINDOW_MS) {
      continue;
    }

    const rate = reasonableTokenRate(estimateTokensFromText(message.text) / (elapsedMs / 1000));
    if (rate !== null) {
      return rate;
    }
  }

  return null;
}

function deriveContextWindowDeltaTokensPerSecond(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): number | null {
  let latest: { tokens: number; atMs: number } | null = null;

  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    if (!payload) {
      continue;
    }

    const tokens = outputTokenCount(payload);
    const atMs = positiveTimestamp(activity.createdAt);
    if (tokens === null || atMs === null) {
      continue;
    }

    if (!latest) {
      latest = { tokens, atMs };
      continue;
    }

    const deltaTokens = latest.tokens - tokens;
    const deltaMs = latest.atMs - atMs;
    if (deltaTokens <= 0 || deltaMs < MIN_TOKEN_RATE_WINDOW_MS) {
      continue;
    }

    const rate = reasonableTokenRate(deltaTokens / (deltaMs / 1000));
    if (rate !== null) {
      return rate;
    }
  }

  return null;
}

export function estimateLoadedThreadDataBytes(thread: Thread): number {
  const loadedState = {
    messages: thread.messages,
    activities: thread.activities,
    proposedPlans: thread.proposedPlans,
    turnDiffSummaries: thread.turnDiffSummaries,
    latestTurn: thread.latestTurn,
    totalWorkDurationMs: thread.totalWorkDurationMs ?? 0,
    messagePageInfo: thread.messagePageInfo,
    activityPageInfo: thread.activityPageInfo,
    proposedPlanPageInfo: thread.proposedPlanPageInfo,
    checkpointPageInfo: thread.checkpointPageInfo,
  };

  try {
    return textEncoder.encode(JSON.stringify(loadedState)).byteLength;
  } catch {
    return 0;
  }
}

export function deriveThreadTokensPerSecond(
  thread: Pick<Thread, "activities" | "messages">,
  nowMs = Date.now(),
): number | null {
  return (
    deriveProviderReportedTokensPerSecond(thread.activities) ??
    deriveStreamingTextTokensPerSecond(thread, nowMs) ??
    deriveContextWindowDeltaTokensPerSecond(thread.activities)
  );
}

export function deriveThreadStatusStats(thread: Thread): ThreadStatusStats {
  return {
    loadedDataBytes: estimateLoadedThreadDataBytes(thread),
    tokensPerSecond: deriveThreadTokensPerSecond(thread),
  };
}

export function withTokensPerSecond(
  stats: ThreadStatusStats,
  tokensPerSecond: number | null,
): ThreadStatusStats {
  return {
    ...stats,
    tokensPerSecond,
  };
}

export function formatLoadedThreadDataBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${BYTE_UNITS[unitIndex]}`;
}

export function formatTokensPerSecond(tokensPerSecond: number | null): string | null {
  if (tokensPerSecond === null || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) {
    return null;
  }

  if (tokensPerSecond < 10) {
    return `${tokensPerSecond.toFixed(1).replace(/\.0$/, "")} tok/s`;
  }

  return `${Math.round(tokensPerSecond)} tok/s`;
}

export function formatThreadStatusStats(stats: ThreadStatusStats): string | null {
  const parts = [`Loaded ${formatLoadedThreadDataBytes(stats.loadedDataBytes)}`];
  const tokenRate = formatTokensPerSecond(stats.tokensPerSecond);
  if (tokenRate) {
    parts.push(tokenRate);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
