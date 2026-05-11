import { describe, expect, it } from "vitest";
import type {
  MessageId,
  OrchestrationThreadActivity,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { EventId, ProviderInstanceId } from "@t3tools/contracts";
import type { Thread } from "./types";
import {
  deriveThreadStatusStats,
  deriveThreadTokensPerSecond,
  estimateLoadedThreadDataBytes,
  formatLoadedThreadDataBytes,
  formatThreadStatusStats,
} from "./threadStatusStats";

const THREAD_ID = "thread-stats" as ThreadId;
const PROJECT_ID = "project-stats" as ProjectId;

function contextWindowActivity(input: {
  id: string;
  createdAt: string;
  usedTokens: number;
  lastOutputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  totalProcessedTokens?: number;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    createdAt: input.createdAt,
    tone: "info",
    kind: "context-window.updated",
    summary: "Context window updated",
    payload: {
      usedTokens: input.usedTokens,
      ...(input.lastOutputTokens !== undefined ? { lastOutputTokens: input.lastOutputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.totalProcessedTokens !== undefined
        ? { totalProcessedTokens: input.totalProcessedTokens }
        : {}),
    },
    turnId: null,
  };
}

function threadWith(input: Partial<Thread>): Thread {
  return {
    id: THREAD_ID,
    environmentId: "environment-stats",
    codexThreadId: null,
    projectId: PROJECT_ID,
    title: "Stats thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-05-11T10:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...input,
  } as Thread;
}

describe("threadStatusStats", () => {
  it("derives tokens per second from provider-reported output tokens and duration", () => {
    const activities = [
      contextWindowActivity({
        id: "usage-1",
        createdAt: "2026-05-11T10:00:00.000Z",
        usedTokens: 4_000,
        lastOutputTokens: 120,
        durationMs: 4_000,
      }),
      contextWindowActivity({
        id: "usage-2",
        createdAt: "2026-05-11T10:00:04.000Z",
        usedTokens: 10_000,
        lastOutputTokens: 200,
        durationMs: 5_000,
      }),
    ];

    expect(deriveThreadTokensPerSecond({ activities, messages: [] })).toBe(40);
  });

  it("does not derive token rate from total processed context deltas", () => {
    const activities = [
      contextWindowActivity({
        id: "usage-1",
        createdAt: "2026-05-11T10:00:00.000Z",
        usedTokens: 1_000,
        totalProcessedTokens: 1_000,
      }),
      contextWindowActivity({
        id: "usage-2",
        createdAt: "2026-05-11T10:00:00.100Z",
        usedTokens: 50_000,
        totalProcessedTokens: 50_000,
      }),
    ];

    expect(deriveThreadTokensPerSecond({ activities, messages: [] })).toBeNull();
  });

  it("falls back to streaming assistant text over a guarded time window", () => {
    const thread = threadWith({
      messages: [
        {
          id: "msg-streaming" as MessageId,
          role: "assistant",
          text: "x".repeat(400),
          createdAt: "2026-05-11T10:00:00.000Z",
          streaming: true,
        },
      ],
    });

    expect(deriveThreadTokensPerSecond(thread, Date.parse("2026-05-11T10:00:05.000Z"))).toBe(20);
  });

  it("uses loaded thread state for the data estimate", () => {
    const small = threadWith({
      messages: [
        {
          id: "msg-small" as MessageId,
          role: "user",
          text: "short",
          createdAt: "2026-05-11T10:00:00.000Z",
          streaming: false,
        },
      ],
    });
    const large = threadWith({
      messages: [
        {
          id: "msg-large" as MessageId,
          role: "assistant",
          text: "x".repeat(2_000),
          createdAt: "2026-05-11T10:00:01.000Z",
          streaming: false,
        },
      ],
    });

    expect(estimateLoadedThreadDataBytes(large)).toBeGreaterThan(
      estimateLoadedThreadDataBytes(small),
    );
  });

  it("formats a compact status line with loaded data and throughput when available", () => {
    const thread = threadWith({
      activities: [
        contextWindowActivity({
          id: "usage-1",
          createdAt: "2026-05-11T10:00:00.000Z",
          usedTokens: 4_000,
          lastOutputTokens: 100,
          durationMs: 5_000,
        }),
        contextWindowActivity({
          id: "usage-2",
          createdAt: "2026-05-11T10:00:02.000Z",
          usedTokens: 4_500,
          lastOutputTokens: 84,
          durationMs: 4_000,
        }),
      ],
    });

    expect(formatLoadedThreadDataBytes(1_900_000)).toBe("1.8 MB");
    expect(formatThreadStatusStats(deriveThreadStatusStats(thread))).toMatch(
      /^Loaded .+ · 21 tok\/s$/,
    );
  });
});
