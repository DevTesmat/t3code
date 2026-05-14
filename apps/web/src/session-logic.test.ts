import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveCompletionDividerBeforeEntryId,
  deriveActiveTurnActivityState,
  deriveActiveWorkStartedAt,
  deriveThreadWorkDurationMs,
  deriveThreadSubagents,
  deriveThreadSubagentTranscripts,
  deriveThreadActivityProjection,
  deriveActivePlanState,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveReasoningSegments,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  findLatestProposedPlan,
  findSidebarProposedPlan,
  hasActiveContextCompaction,
  hasActionableProposedPlan,
  hasToolActivityForTurn,
  isLatestTurnSettled,
  shouldShowPlanFollowUpPrompt,
} from "./session-logic";
import type { ChatMessage, ThreadSession } from "./types";

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  const payload = overrides.payload ?? {};
  return {
    id: EventId.make(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload,
    turnId: overrides.turnId ? TurnId.make(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

describe("deriveReasoningSegments", () => {
  it("coalesces reasoning deltas by turn item and keeps them out of the work log", () => {
    const activities = [
      makeActivity({
        id: "reasoning-1",
        kind: "reasoning.delta",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-1",
        payload: { itemId: "reasoning-item", streamKind: "reasoning_text", text: "Inspecting " },
      }),
      makeActivity({
        id: "reasoning-2",
        kind: "reasoning.delta",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-1",
        payload: { itemId: "reasoning-item", streamKind: "reasoning_text", text: "the repo" },
      }),
    ];

    expect(deriveReasoningSegments(activities)).toMatchObject([
      {
        id: "turn-1:reasoning-item:reasoning_text",
        turnId: "turn-1",
        text: "Inspecting the repo",
        status: "running",
      },
    ]);
    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
  });

  it("creates a private reasoning segment from lifecycle events without text deltas", () => {
    const activities = [
      makeActivity({
        id: "reasoning-started",
        kind: "reasoning.status",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-1",
        payload: { itemId: "reasoning-item", status: "running" },
      }),
      makeActivity({
        id: "reasoning-completed",
        kind: "reasoning.status",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-1",
        payload: { itemId: "reasoning-item", status: "completed" },
      }),
    ];

    expect(deriveReasoningSegments(activities)).toMatchObject([
      {
        id: "turn-1:reasoning-item:reasoning",
        turnId: "turn-1",
        text: "",
        status: "completed",
      },
    ]);
    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
  });

  it("merges lifecycle-only status into summary text reasoning segments", () => {
    const activities = [
      makeActivity({
        id: "reasoning-started",
        kind: "reasoning.status",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-1",
        payload: { itemId: "reasoning-item", status: "running" },
        sequence: 1,
      }),
      makeActivity({
        id: "reasoning-delta",
        kind: "reasoning.delta",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-1",
        payload: {
          itemId: "reasoning-item",
          streamKind: "reasoning_summary_text",
          text: "Inspecting the repo.",
        },
        sequence: 2,
      }),
      makeActivity({
        id: "reasoning-completed",
        kind: "reasoning.status",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-1",
        payload: { itemId: "reasoning-item", status: "completed" },
        sequence: 3,
      }),
    ];

    expect(deriveReasoningSegments(activities)).toMatchObject([
      {
        id: "turn-1:reasoning-item:reasoning_summary_text",
        turnId: "turn-1",
        text: "Inspecting the repo.",
        status: "completed",
      },
    ]);
  });

  it("replaces cumulative reasoning snapshots instead of appending duplicates", () => {
    const activities = [
      makeActivity({
        id: "reasoning-1",
        kind: "reasoning.delta",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-1",
        payload: {
          itemId: "reasoning-item",
          streamKind: "reasoning_summary_text",
          text: "Inspecting ",
        },
        sequence: 1,
      }),
      makeActivity({
        id: "reasoning-2",
        kind: "reasoning.delta",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-1",
        payload: {
          itemId: "reasoning-item",
          streamKind: "reasoning_summary_text",
          text: "Inspecting the repo.",
        },
        sequence: 2,
      }),
    ];

    expect(deriveReasoningSegments(activities)).toMatchObject([
      {
        text: "Inspecting the repo.",
        status: "running",
      },
    ]);
  });
});

function makeRunningSession(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    provider: "codex" as never,
    status: "running",
    activeTurnId: TurnId.make("turn-1"),
    createdAt: "2026-02-23T00:00:00.000Z",
    updatedAt: "2026-02-23T00:00:01.000Z",
    orchestrationStatus: "running",
    ...overrides,
  };
}

function makeAssistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: MessageId.make("assistant-1"),
    role: "assistant",
    text: "partial",
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-02-23T00:00:02.000Z",
    streaming: true,
    ...overrides,
  };
}

function makeUserMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: MessageId.make("user-1"),
    role: "user",
    text: "Run the next step",
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-02-23T00:00:01.000Z",
    streaming: false,
    ...overrides,
  };
}

describe("deriveThreadSubagents", () => {
  it("folds collab agent lifecycle activities into stable subagent rows", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "spawn-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Subagent task started",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            toolCallId: "collab-1",
            collabTool: "spawnAgent",
            receiverThreadIds: ["child-1", "child-2"],
            model: "gpt-5.5",
            reasoningEffort: "high",
            promptPreview: "Inspect the server projection.",
            agentsStates: {
              "child-1": { status: "running", agent_nickname: "Explorer", agent_role: "explorer" },
              "child-2": { status: "completed", agent_role: "worker" },
            },
          },
        },
      }),
      makeActivity({
        id: "close-child-1",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            toolCallId: "collab-2",
            collabTool: "closeAgent",
            receiverThreadIds: ["child-1"],
          },
        },
      }),
      makeActivity({
        id: "spawn-failed",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            toolCallId: "collab-3",
            collabTool: "spawnAgent",
            receiverThreadIds: ["child-3"],
            status: "failed",
          },
        },
      }),
    ];

    expect(deriveThreadSubagents(activities)).toEqual([
      {
        threadId: "child-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        updatedAt: "2026-02-23T00:00:02.000Z",
        status: "closed",
        running: false,
        nickname: "Explorer",
        role: "explorer",
        model: "gpt-5.5",
        reasoningEffort: "high",
        promptPreview: "Inspect the server projection.",
      },
      {
        threadId: "child-2",
        createdAt: "2026-02-23T00:00:01.000Z",
        updatedAt: "2026-02-23T00:00:01.000Z",
        status: "completed",
        running: false,
        role: "worker",
        model: "gpt-5.5",
        reasoningEffort: "high",
        promptPreview: "Inspect the server projection.",
      },
      {
        threadId: "child-3",
        createdAt: "2026-02-23T00:00:03.000Z",
        updatedAt: "2026-02-23T00:00:03.000Z",
        status: "failed",
        running: false,
      },
    ]);
  });

  it("uses remembered wait receivers and agent state keys when wait completion omits receiver ids", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "spawn-child-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            collabTool: "spawnAgent",
            receiverThreadIds: ["child-1"],
            agentsStates: { "child-1": { status: "pendingInit" } },
          },
        },
      }),
      makeActivity({
        id: "spawn-child-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            collabTool: "spawnAgent",
            receiverThreadIds: ["child-2"],
            agentsStates: { "child-2": { status: "pendingInit" } },
          },
        },
      }),
      makeActivity({
        id: "wait-started",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.started",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            toolCallId: "wait-1",
            collabTool: "wait",
            receiverThreadIds: ["child-1", "child-2"],
          },
        },
      }),
      makeActivity({
        id: "wait-completed-missing-receivers",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            toolCallId: "wait-1",
            collabTool: "wait",
            receiverThreadIds: [],
            agentsStates: {},
          },
        },
      }),
      makeActivity({
        id: "wait-child-2-completed",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "tool.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            toolCallId: "wait-2",
            collabTool: "wait",
            receiverThreadIds: [],
            agentsStates: {
              "child-2": { status: "completed", message: "done" },
            },
          },
        },
      }),
    ];

    expect(deriveThreadSubagents(activities).map((subagent) => subagent.status)).toEqual([
      "completed",
      "completed",
    ]);
  });
});

describe("deriveThreadSubagentTranscripts", () => {
  it("builds read-only subagent messages from spawn metadata and child transcript activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "spawn-child",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            collabTool: "spawnAgent",
            receiverThreadIds: ["child-1"],
            promptPreview: "Inspect the server projection.",
            agentsStates: {
              "child-1": { status: "running", agent_nickname: "Explorer" },
            },
          },
        },
      }),
      makeActivity({
        id: "child-answer",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "subagent.item.completed",
        summary: "Assistant message",
        tone: "info",
        payload: {
          providerThreadId: "child-1",
          providerTurnId: "child-turn-1",
          itemId: "child-message-1",
          itemType: "assistant_message",
          text: "Projection stores activity rows.",
          phase: "final_answer",
        },
      }),
    ];

    const transcripts = deriveThreadSubagentTranscripts(activities);

    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]?.subagent.threadId).toBe("child-1");
    expect(transcripts[0]?.messages).toMatchObject([
      {
        role: "user",
        text: "Inspect the server projection.",
        streaming: false,
      },
      {
        role: "assistant",
        text: "Projection stores activity rows.",
        streaming: false,
      },
    ]);
    expect(transcripts[0]?.activities.map((activity) => activity.id)).toEqual(["child-answer"]);
  });

  it("normalizes subagent tool activities so the transcript timeline renders tool calls", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "spawn-child",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            collabTool: "spawnAgent",
            receiverThreadIds: ["child-1"],
            agentsStates: {
              "child-1": { status: "running" },
            },
          },
        },
      }),
      makeActivity({
        id: "child-command-started",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "subagent.item.started",
        summary: "Ran command",
        tone: "tool",
        payload: {
          providerThreadId: "child-1",
          providerTurnId: "child-turn-1",
          itemId: "child-command-1",
          itemType: "command_execution",
          status: "inProgress",
          detail: "rg -n subagent apps",
        },
      }),
      makeActivity({
        id: "child-command-output",
        createdAt: "2026-02-23T00:00:02.500Z",
        kind: "subagent.content.delta",
        summary: "Command output",
        tone: "tool",
        payload: {
          providerThreadId: "child-1",
          providerTurnId: "child-turn-1",
          itemId: "child-command-1",
          itemType: "command_execution",
          status: "inProgress",
          text: "apps/web/src/session-logic.ts:866\n",
        },
      }),
      makeActivity({
        id: "child-command-completed",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "subagent.item.completed",
        summary: "Ran command",
        tone: "tool",
        payload: {
          providerThreadId: "child-1",
          providerTurnId: "child-turn-1",
          itemId: "child-command-1",
          itemType: "command_execution",
          status: "completed",
          detail: "rg -n subagent apps",
        },
      }),
    ];

    const [transcript] = deriveThreadSubagentTranscripts(activities);
    const entries = deriveWorkLogEntries(transcript?.activities ?? [], undefined);

    expect(transcript?.activities.map((activity) => activity.kind)).toEqual([
      "tool.started",
      "tool.updated",
      "tool.completed",
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      itemType: "command_execution",
      status: "completed",
      detail: "rg -n subagent apps",
      outputPreview: {
        lines: ["apps/web/src/session-logic.ts:866"],
        stream: "unknown",
        truncated: false,
      },
    });
  });

  it("upserts streaming subagent assistant rows and suppresses duplicate wait fallback messages", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "spawn-child",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            collabTool: "spawnAgent",
            receiverThreadIds: ["child-1"],
            agentsStates: {
              "child-1": { status: "running" },
            },
          },
        },
      }),
      makeActivity({
        id: "child-answer-delta-1",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "subagent.content.delta",
        summary: "Assistant message",
        tone: "info",
        payload: {
          providerThreadId: "child-1",
          providerTurnId: "child-turn-1",
          itemId: "child-message-1",
          itemType: "assistant_message",
          text: "Inspected only.",
        },
      }),
      makeActivity({
        id: "child-answer-delta-2",
        createdAt: "2026-02-23T00:00:02.500Z",
        kind: "subagent.content.delta",
        summary: "Assistant message",
        tone: "info",
        payload: {
          providerThreadId: "child-1",
          providerTurnId: "child-turn-1",
          itemId: "child-message-1",
          itemType: "assistant_message",
          text: " No files edited. ",
        },
      }),
      makeActivity({
        id: "child-answer-delta-3",
        createdAt: "2026-02-23T00:00:02.750Z",
        kind: "subagent.content.delta",
        summary: "Assistant message",
        tone: "info",
        payload: {
          providerThreadId: "child-1",
          providerTurnId: "child-turn-1",
          itemId: "child-message-1",
          itemType: "assistant_message",
          text: " ",
        },
      }),
      makeActivity({
        id: "child-answer-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "subagent.item.completed",
        summary: "Assistant message",
        tone: "info",
        payload: {
          providerThreadId: "child-1",
          providerTurnId: "child-turn-1",
          itemId: "child-message-1",
          itemType: "assistant_message",
          text: "Inspected only. No files edited.",
          phase: "final_answer",
        },
      }),
      makeActivity({
        id: "wait-child",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            collabTool: "wait",
            receiverThreadIds: ["child-1"],
            agentsStates: {
              "child-1": {
                status: "completed",
                message: "Inspected only. No files edited.",
              },
            },
          },
        },
      }),
    ];

    const [transcript] = deriveThreadSubagentTranscripts(activities);

    expect(transcript?.messages).toMatchObject([
      {
        role: "assistant",
        text: "Inspected only. No files edited.",
        streaming: false,
      },
    ]);
  });

  it("preserves whitespace while subagent assistant deltas stream", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "spawn-child",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            collabTool: "spawnAgent",
            receiverThreadIds: ["child-1"],
            agentsStates: {
              "child-1": { status: "running" },
            },
          },
        },
      }),
      makeActivity({
        id: "delta-1",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "subagent.content.delta",
        payload: {
          providerThreadId: "child-1",
          itemId: "message-1",
          itemType: "assistant_message",
          text: "No",
        },
      }),
      makeActivity({
        id: "delta-2",
        createdAt: "2026-02-23T00:00:02.100Z",
        kind: "subagent.content.delta",
        payload: {
          providerThreadId: "child-1",
          itemId: "message-1",
          itemType: "assistant_message",
          text: " ",
        },
      }),
      makeActivity({
        id: "delta-3",
        createdAt: "2026-02-23T00:00:02.200Z",
        kind: "subagent.content.delta",
        payload: {
          providerThreadId: "child-1",
          itemId: "message-1",
          itemType: "assistant_message",
          text: "files",
        },
      }),
    ];

    const [transcript] = deriveThreadSubagentTranscripts(activities);

    expect(transcript?.messages).toMatchObject([
      {
        role: "assistant",
        text: "No files",
        streaming: true,
      },
    ]);
  });
});

describe("deriveThreadActivityProjection", () => {
  it("matches individual active-thread activity derivations from one shared projection", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-resolved",
        createdAt: "2026-02-23T00:00:06.000Z",
        kind: "approval.resolved",
        payload: { requestId: "approval-1" },
      }),
      makeActivity({
        id: "approval-requested",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "approval.requested",
        payload: { requestId: "approval-1", requestKind: "command", detail: "Run test" },
      }),
      makeActivity({
        id: "user-input-requested",
        createdAt: "2026-02-23T00:00:07.000Z",
        kind: "user-input.requested",
        payload: {
          requestId: "input-1",
          questions: [
            {
              id: "choice",
              header: "Choice",
              question: "Pick one",
              options: [{ label: "A", description: "Use A" }],
            },
          ],
        },
      }),
      makeActivity({
        id: "reasoning-delta",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "reasoning.delta",
        tone: "info",
        turnId: "turn-1",
        payload: { itemId: "reasoning-item", text: "Thinking" },
      }),
      makeActivity({
        id: "tool-started",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.started",
        tone: "tool",
        turnId: "turn-1",
        payload: { itemType: "command_execution", data: { command: "bun test" } },
      }),
      makeActivity({
        id: "plan-updated",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "turn.plan.updated",
        turnId: "turn-1",
        payload: { plan: [{ step: "Run checks", status: "inProgress" }] },
      }),
      makeActivity({
        id: "spawn-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Subagent task started",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            toolCallId: "collab-1",
            collabTool: "spawnAgent",
            receiverThreadIds: ["child-1"],
            promptPreview: "Inspect this area.",
          },
        },
      }),
    ];
    const latestTurnId = TurnId.make("turn-1");

    const projection = deriveThreadActivityProjection(activities, latestTurnId);

    expect(projection.workLogEntries).toEqual(deriveWorkLogEntries(activities, undefined));
    expect(projection.reasoningSegments).toEqual(deriveReasoningSegments(activities));
    expect(projection.threadSubagents).toEqual(deriveThreadSubagents(activities));
    expect(projection.threadSubagentTranscripts).toEqual(
      deriveThreadSubagentTranscripts(activities),
    );
    expect(projection.pendingApprovals).toEqual(derivePendingApprovals(activities));
    expect(projection.pendingUserInputs).toEqual(derivePendingUserInputs(activities));
    expect(projection.activePlan).toEqual(deriveActivePlanState(activities, latestTurnId));
    expect(projection.latestTurnHasToolActivity).toBe(
      hasToolActivityForTurn(activities, latestTurnId),
    );
  });
});

describe("deriveWorkLogEntries subagent coordination", () => {
  it("filters subagent transcript rows out of the parent work log", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "child-answer",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "subagent.item.completed",
        summary: "Assistant message",
        tone: "info",
        payload: {
          providerThreadId: "child-1",
          itemType: "assistant_message",
          text: "Subagent finding.",
        },
        turnId: "turn-1",
      }),
    ];

    expect(deriveWorkLogEntries(activities, TurnId.make("turn-1"))).toEqual([]);
  });

  it("collapses repeated wait calls in one parent turn into a progress row", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "wait-all",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            toolCallId: "wait-1",
            collabTool: "wait",
            receiverThreadIds: ["child-1", "child-2", "child-3"],
            agentsStates: {
              "child-1": { status: "completed" },
              "child-2": { status: "running" },
              "child-3": { status: "running" },
            },
          },
        },
        turnId: "turn-1",
      }),
      makeActivity({
        id: "wait-remaining",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            toolCallId: "wait-2",
            collabTool: "wait",
            receiverThreadIds: ["child-1", "child-2", "child-3"],
            agentsStates: {
              "child-1": { status: "completed" },
              "child-2": { status: "completed" },
              "child-3": { status: "completed" },
            },
          },
        },
        turnId: "turn-1",
      }),
    ];

    expect(deriveWorkLogEntries(activities, TurnId.make("turn-1"))).toMatchObject([
      {
        id: "wait-remaining",
        label: "Waiting on subagents (3/3 complete)",
        status: "completed",
        itemType: "collab_agent_tool_call",
        collabTool: "wait",
      },
    ]);
  });
});

describe("derivePendingApprovals", () => {
  it("tracks open approvals and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-1",
          requestKind: "command",
          detail: "bun run lint",
        },
      }),
      makeActivity({
        id: "approval-close",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "approval.resolved",
        summary: "Approval resolved",
        tone: "info",
        payload: { requestId: "req-2" },
      }),
      makeActivity({
        id: "approval-closed-request",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "approval.requested",
        summary: "File-change approval requested",
        tone: "approval",
        payload: { requestId: "req-2", requestKind: "file-change" },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-1",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "bun run lint",
      },
    ]);
  });

  it("maps canonical requestType payloads into pending approvals", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-request-type",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-request-type",
          requestType: "command_execution_approval",
          detail: "pwd",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-request-type",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "pwd",
      },
    ]);
  });

  it("clears stale pending approvals when provider reports unknown pending request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-1",
          detail: "Unknown pending permission request: req-stale-1",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });

  it("clears stale pending approvals when the backend marks them stale after restart", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale-restart",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-restart-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale-restart",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-restart-1",
          detail:
            "Stale pending approval request: req-stale-restart-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });
});

describe("derivePendingUserInputs", () => {
  it("tracks open structured prompts and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
              multiSelect: true,
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-resolved",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.resolved",
        summary: "User input submitted",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          answers: {
            sandbox_mode: "workspace-write",
          },
        },
      }),
      makeActivity({
        id: "user-input-open-2",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          questions: [
            {
              id: "approval",
              header: "Approval",
              question: "Continue?",
              options: [
                {
                  label: "yes",
                  description: "Continue execution",
                },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([
      {
        requestId: "req-user-input-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
            multiSelect: true,
          },
        ],
      },
    ]);
  });

  it("clears stale pending user-input prompts when the provider reports an orphaned request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-stale-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        tone: "error",
        payload: {
          requestId: "req-user-input-stale-1",
          detail:
            "Stale pending user-input request: req-user-input-stale-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([]);
  });
});

describe("deriveActivePlanState", () => {
  it("returns the latest plan update for the active turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-old",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Initial plan",
          plan: [{ step: "Inspect code", status: "pending" }],
        },
      }),
      makeActivity({
        id: "plan-latest",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Refined plan",
          plan: [{ step: "Implement Codex user input", status: "inProgress" }],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.make("turn-1"))).toEqual({
      createdAt: "2026-02-23T00:00:02.000Z",
      turnId: "turn-1",
      explanation: "Refined plan",
      steps: [{ step: "Implement Codex user input", status: "inProgress" }],
    });
  });

  it("falls back to the most recent plan from a previous turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-from-turn-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          plan: [{ step: "Write tests", status: "completed" }],
        },
      }),
    ];

    // Current turn is turn-2, which has no plan activity — should fall back to turn-1's plan
    const result = deriveActivePlanState(activities, TurnId.make("turn-2"));
    expect(result).toEqual({
      createdAt: "2026-02-23T00:00:01.000Z",
      turnId: "turn-1",
      steps: [{ step: "Write tests", status: "completed" }],
    });
  });
});

describe("findLatestProposedPlan", () => {
  it("prefers the latest proposed plan for the active turn", () => {
    expect(
      findLatestProposedPlan(
        [
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "# Older",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:01.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "# Latest",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:02.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-2",
            turnId: TurnId.make("turn-2"),
            planMarkdown: "# Different turn",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:03.000Z",
            updatedAt: "2026-02-23T00:00:03.000Z",
          },
        ],
        TurnId.make("turn-1"),
      ),
    ).toEqual({
      id: "plan:thread-1:turn:turn-1",
      turnId: "turn-1",
      planMarkdown: "# Latest",
      implementedAt: null,
      implementationThreadId: null,
      streaming: false,
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the most recently updated proposed plan", () => {
    const latestPlan = findLatestProposedPlan(
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.make("turn-1"),
          planMarkdown: "# First",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:01.000Z",
          updatedAt: "2026-02-23T00:00:01.000Z",
        },
        {
          id: "plan:thread-1:turn:turn-2",
          turnId: TurnId.make("turn-2"),
          planMarkdown: "# Latest",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:03.000Z",
        },
      ],
      null,
    );

    expect(latestPlan?.planMarkdown).toBe("# Latest");
  });

  it("makes no-turn imported proposed plans actionable when no session is running", () => {
    const latestTurnSettled = isLatestTurnSettled(null, null);
    const activeProposedPlan = latestTurnSettled
      ? findLatestProposedPlan(
          [
            {
              id: "plan-imported",
              turnId: null,
              planMarkdown: "# Imported plan",
              implementedAt: null,
              implementationThreadId: null,
              createdAt: "2026-02-23T00:00:01.000Z",
              updatedAt: "2026-02-23T00:00:01.000Z",
            },
          ],
          null,
        )
      : null;

    expect(latestTurnSettled).toBe(true);
    expect(hasActionableProposedPlan(activeProposedPlan)).toBe(true);
  });
});

describe("hasActionableProposedPlan", () => {
  it("returns true for an unimplemented proposed plan", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.make("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:01.000Z",
      }),
    ).toBe(true);
  });

  it("returns false for a proposed plan already implemented elsewhere", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.make("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: "2026-02-23T00:00:02.000Z",
        implementationThreadId: ThreadId.make("thread-implement"),
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe(false);
  });
});

describe("shouldShowPlanFollowUpPrompt", () => {
  const proposedPlan = {
    id: "plan-imported",
    turnId: null,
    planMarkdown: "# Imported plan",
    implementedAt: null,
    implementationThreadId: null,
    createdAt: "2026-02-23T00:00:01.000Z",
    updatedAt: "2026-02-23T00:00:01.000Z",
  };

  it("shows for settled no-turn imported plans without requiring plan interaction mode", () => {
    expect(
      shouldShowPlanFollowUpPrompt({
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        latestTurnSettled: true,
        proposedPlan,
      }),
    ).toBe(true);
  });

  it("stays hidden while the thread is blocked or running", () => {
    expect(
      shouldShowPlanFollowUpPrompt({
        pendingApprovalCount: 1,
        pendingUserInputCount: 0,
        latestTurnSettled: true,
        proposedPlan,
      }),
    ).toBe(false);
    expect(
      shouldShowPlanFollowUpPrompt({
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        latestTurnSettled: false,
        proposedPlan,
      }),
    ).toBe(false);
  });
});

describe("findSidebarProposedPlan", () => {
  it("prefers the running turn source proposed plan when available on the same thread", () => {
    expect(
      findSidebarProposedPlan({
        threads: [
          {
            id: ThreadId.make("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.make("turn-plan"),
                planMarkdown: "# Source plan",
                implementedAt: "2026-02-23T00:00:03.000Z",
                implementationThreadId: ThreadId.make("thread-2"),
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
            ],
          },
          {
            id: ThreadId.make("thread-2"),
            proposedPlans: [
              {
                id: "plan-2",
                turnId: TurnId.make("turn-other"),
                planMarkdown: "# Latest elsewhere",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:04.000Z",
                updatedAt: "2026-02-23T00:00:05.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.make("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.make("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: false,
        threadId: ThreadId.make("thread-1"),
      }),
    ).toEqual({
      id: "plan-1",
      turnId: "turn-plan",
      planMarkdown: "# Source plan",
      implementedAt: "2026-02-23T00:00:03.000Z",
      implementationThreadId: "thread-2",
      streaming: false,
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the latest proposed plan once the turn is settled", () => {
    expect(
      findSidebarProposedPlan({
        threads: [
          {
            id: ThreadId.make("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.make("turn-plan"),
                planMarkdown: "# Older",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
              {
                id: "plan-2",
                turnId: TurnId.make("turn-latest"),
                planMarkdown: "# Latest",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:03.000Z",
                updatedAt: "2026-02-23T00:00:04.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.make("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.make("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: true,
        threadId: ThreadId.make("thread-1"),
      })?.planMarkdown,
    ).toBe("# Latest");
  });
});

describe("deriveWorkLogEntries", () => {
  it("collapses tool started entries with matching completed entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Tool call",
        kind: "tool.started",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("collapses old command started and completed entries without tool ids", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command started",
        kind: "tool.started",
        payload: {
          itemType: "command_execution",
          detail: "git status --short",
          data: { command: "git status --short" },
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        summary: "Ran command",
        kind: "tool.completed",
        payload: {
          itemType: "command_execution",
          detail: "git status --short",
          data: { command: "git status --short", exitCode: 0 },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("tool-complete");
    expect(entries[0]?.label).toBe("Ran command");
    expect(entries[0]?.status).toBe("completed");
  });

  it("derives verified read-only safety from structured command actions", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-start",
        kind: "tool.started",
        summary: "Ran command started",
        payload: {
          itemType: "command_execution",
          detail: "node -e 'inspect()'",
          data: {
            toolCallId: "tool-command-readonly",
            command: "node -e 'inspect()'",
            item: {
              commandActions: [
                { type: "read", command: "cat package.json", path: "/repo/package.json" },
                { type: "search", command: "rg query", query: "query" },
              ],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.activitySafety).toEqual({
      kind: "verified-read-only",
      source: "command-actions",
    });
  });

  it("lets observed changed files override read-only command action hints", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Ran command started",
        payload: {
          itemType: "command_execution",
          data: {
            toolCallId: "tool-command-mutating",
            command: "cat package.json",
            commandActions: [{ type: "read", command: "cat package.json" }],
          },
        },
      }),
      makeActivity({
        id: "command-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            toolCallId: "tool-command-mutating",
            command: "cat package.json",
            commandActions: [{ type: "read", command: "cat package.json" }],
            changes: [{ path: "package.json" }],
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual(["package.json"]);
    expect(entry?.activitySafety).toEqual({ kind: "mutating", source: "changed-files" });
  });

  it("reconciles command lifecycle by tool call id across intervening assistant text", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Ran command started",
        kind: "tool.started",
        turnId: "turn-1",
        payload: {
          itemType: "command_execution",
          status: "in_progress",
          detail: "bun run lint",
          data: {
            toolCallId: "tool-command-interleaved",
            command: "bun run lint",
          },
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        summary: "Ran command",
        kind: "tool.completed",
        turnId: "turn-1",
        payload: {
          itemType: "command_execution",
          status: "completed",
          detail: "bun run lint",
          data: {
            toolCallId: "tool-command-interleaved",
            command: "bun run lint",
            exitCode: 0,
          },
        },
      }),
    ];
    const assistant = makeAssistantMessage({
      id: MessageId.make("assistant-between-tool-events"),
      createdAt: "2026-02-23T00:00:02.000Z",
      streaming: false,
      text: "Still working.",
    });

    const entries = deriveWorkLogEntries(activities, TurnId.make("turn-1"));
    const timelineEntries = deriveTimelineEntries([assistant], [], entries);
    const workTimelineEntries = timelineEntries.filter((entry) => entry.kind === "work");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tool-complete",
      command: "bun run lint",
      status: "completed",
      toolCallId: "tool-command-interleaved",
      toolKey: "tool:tool-command-interleaved",
    });
    expect(workTimelineEntries).toHaveLength(1);
    expect(timelineEntries.map((entry) => entry.kind)).toEqual(["message", "work"]);
  });

  it("keeps previous turn tool rows when a new turn has no tool activity yet", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "turn-1-tool-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Ran command started",
        kind: "tool.started",
        turnId: "turn-1",
        payload: {
          itemType: "command_execution",
          status: "in_progress",
          detail: "bun run lint",
          data: {
            toolCallId: "turn-1-command",
            command: "bun run lint",
          },
        },
      }),
      makeActivity({
        id: "turn-1-tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        kind: "tool.completed",
        turnId: "turn-1",
        payload: {
          itemType: "command_execution",
          status: "completed",
          detail: "bun run lint",
          data: {
            toolCallId: "turn-1-command",
            command: "bun run lint",
            exitCode: 0,
          },
        },
      }),
    ];
    const turn2UserMessage = makeUserMessage({
      id: MessageId.make("turn-2-user"),
      turnId: TurnId.make("turn-2"),
      createdAt: "2026-02-23T00:00:03.000Z",
    });

    const entries = deriveWorkLogEntries(activities, undefined);
    const timelineEntries = deriveTimelineEntries([turn2UserMessage], [], entries);

    expect(entries.map((entry) => entry.id)).toEqual(["turn-1-tool-complete"]);
    expect(timelineEntries.map((entry) => entry.id)).toEqual([
      "turn-1-tool-complete",
      "turn-2-user",
    ]);
  });

  it("keeps previous turn tool rows when new turn tool activity arrives", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "turn-1-tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran lint",
        kind: "tool.completed",
        turnId: "turn-1",
        payload: {
          itemType: "command_execution",
          status: "completed",
          detail: "bun run lint",
          data: {
            toolCallId: "turn-1-command",
            command: "bun run lint",
            exitCode: 0,
          },
        },
      }),
      makeActivity({
        id: "turn-2-tool-start",
        createdAt: "2026-02-23T00:00:04.000Z",
        summary: "Ran typecheck started",
        kind: "tool.started",
        turnId: "turn-2",
        payload: {
          itemType: "command_execution",
          status: "in_progress",
          detail: "bun typecheck",
          data: {
            toolCallId: "turn-2-command",
            command: "bun typecheck",
          },
        },
      }),
    ];
    const turn2UserMessage = makeUserMessage({
      id: MessageId.make("turn-2-user"),
      turnId: TurnId.make("turn-2"),
      createdAt: "2026-02-23T00:00:03.000Z",
    });

    const entries = deriveWorkLogEntries(activities, undefined);
    const timelineEntries = deriveTimelineEntries([turn2UserMessage], [], entries);

    expect(entries.map((entry) => entry.id)).toEqual(["turn-1-tool-complete", "turn-2-tool-start"]);
    expect(timelineEntries.map((entry) => entry.id)).toEqual([
      "turn-1-tool-complete",
      "turn-2-user",
      "turn-2-tool-start",
    ]);
  });

  it("does not downgrade a completed command when a later update arrives for the same tool", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        kind: "tool.completed",
        payload: {
          itemType: "command_execution",
          status: "completed",
          detail: "bun run lint",
          data: {
            toolCallId: "tool-command-late-update",
            command: "bun run lint",
            outputPreview: {
              lines: ["done"],
              stream: "stdout",
              truncated: false,
            },
          },
        },
      }),
      makeActivity({
        id: "tool-late-update",
        createdAt: "2026-02-23T00:00:03.000Z",
        summary: "Terminal output",
        kind: "tool.updated",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          data: {
            toolCallId: "tool-command-late-update",
            outputPreview: {
              lines: ["done", "summary"],
              stream: "stdout",
              truncated: false,
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tool-late-update",
      command: "bun run lint",
      status: "completed",
      outputPreview: {
        lines: ["done", "summary"],
        stream: "stdout",
        truncated: false,
      },
    });
  });

  it("omits task.started but shows task.progress and task.completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        summary: "default task started",
        tone: "info",
      }),
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Updating files",
        tone: "info",
      }),
      makeActivity({
        id: "task-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["task-progress", "task-complete"]);
  });

  it("uses payload summary as label for task entries when available", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-progress-with-summary",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Reasoning update",
        tone: "info",
        payload: { summary: "Searching for API endpoints" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries[0]?.label).toBe("Searching for API endpoints");
  });

  it("uses payload detail as label for task.completed and preserves error tone", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-completed-failed",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task failed",
        tone: "error",
        payload: { detail: "Failed to deploy changes" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries[0]?.label).toBe("Failed to deploy changes");
    expect(entries[0]?.tone).toBe("error");
  });

  it("filters by turn id when provided", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "turn-1", turnId: "turn-1", summary: "Tool call", kind: "tool.started" }),
      makeActivity({
        id: "turn-2",
        turnId: "turn-2",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({ id: "no-turn", summary: "Checkpoint captured", tone: "info" }),
    ];

    const entries = deriveWorkLogEntries(activities, TurnId.make("turn-2"));
    expect(entries.map((entry) => entry.id)).toEqual(["turn-2"]);
  });

  it("preserves turn ids on derived work log entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-change-start",
        turnId: "turn-file-change",
        summary: "File change started",
        kind: "tool.started",
        payload: {
          itemType: "file_change",
          data: { files: [{ path: "src/app.ts" }] },
        },
      }),
      makeActivity({
        id: "file-change-complete",
        turnId: "turn-file-change",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "File change complete",
        kind: "tool.completed",
        payload: {
          itemType: "file_change",
          data: { files: [{ path: "src/app.ts" }] },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, TurnId.make("turn-file-change"));
    expect(entry?.id).toBe("file-change-complete");
    expect(entry?.turnId).toBe(TurnId.make("turn-file-change"));
    expect(entry?.changedFiles).toEqual(["src/app.ts"]);
  });

  it("omits checkpoint captured info entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "checkpoint",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Checkpoint captured",
        tone: "info",
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        tone: "tool",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits ExitPlanMode lifecycle entries once the plan card is shown", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "exit-plan-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          detail: 'ExitPlanMode: {"allowedPrompts":[{"tool":"Bash","prompt":"run tests"}]}',
        },
      }),
      makeActivity({
        id: "exit-plan-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          detail: "ExitPlanMode: {}",
        },
      }),
      makeActivity({
        id: "real-work-log",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail: "Bash: bun test",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["real-work-log"]);
  });

  it("orders work log by activity sequence when present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "second",
        createdAt: "2026-02-23T00:00:03.000Z",
        sequence: 2,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "first",
        createdAt: "2026-02-23T00:00:04.000Z",
        sequence: 1,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("extracts command text for command tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: ["bun", "run", "lint"],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("bun run lint");
  });

  it("unwraps PowerShell command wrappers for displayed command text", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-wrapper",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'bun run lint'",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("bun run lint");
    expect(entry?.rawCommand).toBe(
      "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'bun run lint'",
    );
  });

  it("unwraps PowerShell command wrappers from argv-style command payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-wrapper-argv",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command", "rg -n foo ."],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("rg -n foo .");
    expect(entry?.rawCommand).toBe(
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg -n foo ."',
    );
  });

  it("extracts command text from command detail when structured command metadata is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-detail-fallback",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail:
            '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -Command \'rg -n -F "new Date()" .\' <exited with exit code 0>',
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe('rg -n -F "new Date()" .');
    expect(entry?.rawCommand).toBe(
      `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -Command 'rg -n -F "new Date()" .'`,
    );
  });

  it("does not unwrap shell commands when no wrapper flag is present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-shell-script",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: "bash script.sh",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("bash script.sh");
    expect(entry?.rawCommand).toBeUndefined();
  });

  it("keeps compact Codex tool metadata used for icons and labels", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-with-metadata",
        kind: "tool.completed",
        summary: "bash",
        payload: {
          itemType: "command_execution",
          title: "bash",
          status: "completed",
          detail: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
          data: {
            item: {
              command: ["bun", "run", "dev"],
              result: {
                content: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
                exitCode: 0,
              },
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      command: "bun run dev",
      detail: '{ "dev": "vite dev --port 3000" }',
      itemType: "command_execution",
      toolTitle: "bash",
    });
  });

  it("extracts changed file paths for file-change tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          data: {
            item: {
              changes: [
                { path: "apps/web/src/components/ChatView.tsx" },
                { filename: "apps/web/src/session-logic.ts" },
              ],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual([
      "apps/web/src/components/ChatView.tsx",
      "apps/web/src/session-logic.ts",
    ]);
  });

  it("preserves managed file-change failure details", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "failed-file-tool",
        kind: "tool.completed",
        summary: "File edit failed",
        payload: {
          itemType: "file_change",
          status: "failed",
          detail: "Failed to find expected lines in apps/web/src/session-logic.ts:",
          data: {
            path: "apps/web/src/session-logic.ts",
            toolCallId: "managed-failure:evt-1",
            failure: {
              kind: "apply_patch_verification_failed",
              path: "apps/web/src/session-logic.ts",
              reason: "Failed to find expected lines in apps/web/src/session-logic.ts:",
              expectedContent: "const oldValue = true;",
              expectedContentFound: false,
              attemptedPatch:
                "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
              attemptedPatchEventId: "evt-patch",
              actualFileExists: true,
              actualContentExcerpt: "const oldValue = false;",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      status: "failed",
      itemType: "file_change",
      toolCallId: "managed-failure:evt-1",
      changedFiles: ["apps/web/src/session-logic.ts"],
      failure: {
        kind: "apply_patch_verification_failed",
        path: "apps/web/src/session-logic.ts",
        expectedContent: "const oldValue = true;",
        expectedContentFound: false,
        attemptedPatch:
          "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
        attemptedPatchEventId: "evt-patch",
        actualFileExists: true,
        actualContentExcerpt: "const oldValue = false;",
      },
    });
  });

  it("drops duplicated tool detail when it only repeats the title", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "read-file-generic",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.toolTitle).toBe("Read File");
    expect(entry?.detail).toBeUndefined();
  });

  it("uses grep raw output summaries instead of repeating the generic tool label", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "grep-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "grep",
        payload: {
          itemType: "web_search",
          title: "grep",
          detail: "grep",
          data: {
            toolCallId: "tool-grep-1",
            kind: "search",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "grep-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "grep",
        payload: {
          itemType: "web_search",
          title: "grep",
          detail: "grep",
          data: {
            toolCallId: "tool-grep-1",
            kind: "search",
            rawOutput: {
              totalFiles: 19,
              truncated: false,
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "grep-complete",
      toolTitle: "grep",
      detail: "19 files",
      itemType: "web_search",
    });
  });

  it("uses Codex web-search item queries as timeline detail", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "web-search-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Web search started",
        payload: {
          itemType: "web_search",
          title: "Web search",
          data: {
            item: {
              id: "web-search-1",
              type: "webSearch",
              query: "latest Codex app-server docs",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      id: "web-search-started",
      toolTitle: "Web search",
      detail: "latest Codex app-server docs",
      itemType: "web_search",
    });
  });

  it("uses completed web-search action queries as timeline detail", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "web-search-completed",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Web search",
        payload: {
          itemType: "web_search",
          status: "completed",
          title: "Web search",
          data: {
            item: {
              id: "web-search-1",
              type: "webSearch",
              action: {
                type: "search",
                query: "T3 Code release preflight",
              },
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      id: "web-search-completed",
      toolTitle: "Web search",
      detail: "T3 Code release preflight",
      itemType: "web_search",
    });
  });

  it("uses direct web-search query fields and normalizes whitespace", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "web-search-direct-query",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Web search",
        payload: {
          itemType: "web_search",
          title: "Web search",
          data: {
            query: "  OpenAI\nCodex   SDK  ",
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      id: "web-search-direct-query",
      detail: "OpenAI Codex SDK",
      itemType: "web_search",
    });
  });

  it("keeps web-search entries label-only when no query is available", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "web-search-no-query",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Web search",
        payload: {
          itemType: "web_search",
          title: "Web search",
          data: {
            item: {
              id: "web-search-1",
              type: "webSearch",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      id: "web-search-no-query",
      toolTitle: "Web search",
      itemType: "web_search",
    });
    expect(entry?.detail).toBeUndefined();
  });

  it("uses completed read-file output previews and still collapses the same tool call", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "read-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-1",
            kind: "read",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "read-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-1",
            kind: "read",
            rawOutput: {
              content:
                'import * as Effect from "effect/Effect"\nimport * as Layer from "effect/Layer"\n',
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "read-complete",
      toolTitle: "Read File",
      detail: 'import * as Effect from "effect/Effect"',
      itemType: "dynamic_tool_call",
    });
  });

  it("does not use command stdout as the detail when Cursor omits the command input", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "cursor-command-complete",
        createdAt: "2026-04-16T22:40:42.221Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: {
            toolCallId: "toolu_vrtx_01WypXgRM8PPygBtrVAZwzy5",
            kind: "execute",
            rawInput: {},
            rawOutput: {
              exitCode: 0,
              stdout: "total 960\napps\npackages\n",
              stderr: "",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      id: "cursor-command-complete",
      label: "Ran command",
      itemType: "command_execution",
      toolTitle: "Ran command",
    });
    expect(entry?.detail).toBeUndefined();
    expect(entry?.command).toBeUndefined();
  });

  it("derives terminal output preview from normalized command payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-preview-normalized",
        kind: "tool.updated",
        summary: "Terminal output",
        payload: {
          itemType: "command_execution",
          data: {
            toolCallId: "tool-command-preview",
            outputPreview: {
              lines: ["one", "two", "three", "four"],
              stream: "stdout",
              truncated: false,
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.outputPreview).toEqual({
      lines: ["one", "two", "three", "four"],
      stream: "stdout",
      truncated: false,
    });
  });

  it("derives fallback terminal output preview from raw stdout", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-preview-stdout",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            rawOutput: {
              stdout: "\nline1\nline2\nline3\nline4\nline5\n",
              stderr: "",
              exitCode: 0,
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.outputPreview).toEqual({
      lines: ["line2", "line3", "line4", "line5"],
      stream: "stdout",
      truncated: true,
    });
  });

  it("prefers stderr preview for failed command raw output", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-preview-stderr",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          status: "failed",
          data: {
            rawOutput: {
              stdout: "success-looking output\n",
              stderr: "actual failure\n",
              exitCode: 1,
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.status).toBe("failed");
    expect(entry?.exitCode).toBe(1);
    expect(entry?.outputPreview).toEqual({
      lines: ["actual failure"],
      stream: "stderr",
      truncated: false,
    });
  });

  it("collapses command lifecycle rows while keeping the latest output preview", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-preview-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Terminal output",
        payload: {
          itemType: "command_execution",
          data: {
            toolCallId: "tool-command-collapse-preview",
            outputPreview: {
              lines: ["first"],
              stream: "unknown",
              truncated: false,
            },
          },
        },
      }),
      makeActivity({
        id: "command-preview-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            toolCallId: "tool-command-collapse-preview",
            command: "bun run lint",
            outputPreview: {
              lines: ["latest"],
              stream: "stdout",
              truncated: false,
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "command-preview-complete",
      command: "bun run lint",
      status: "completed",
      outputPreview: {
        lines: ["latest"],
        stream: "stdout",
        truncated: false,
      },
    });
  });

  it("collapses command lifecycle rows by tool call id while preserving earlier preview data", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-preview-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Terminal output",
        payload: {
          itemType: "command_execution",
          data: {
            toolCallId: "tool-command-preserve-preview",
            outputPreview: {
              lines: ["still running"],
              stream: "stdout",
              truncated: false,
            },
          },
        },
      }),
      makeActivity({
        id: "command-preview-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          status: "completed",
          data: {
            toolCallId: "tool-command-preserve-preview",
            command: "bun run lint",
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "command-preview-complete",
      command: "bun run lint",
      status: "completed",
      outputPreview: {
        lines: ["still running"],
        stream: "stdout",
        truncated: false,
      },
    });
  });

  it("derives failed terminal status from detail exit code", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-detail-failed",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail: "bun run lint <exited with exit code 2>",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      command: "bun run lint",
      status: "failed",
      exitCode: 2,
    });
  });

  it("collapses legacy completed tool rows that are missing tool metadata", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "legacy-read-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-legacy",
            kind: "read",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "legacy-read-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "legacy-read-complete",
      toolTitle: "Read File",
      itemType: "dynamic_tool_call",
    });
    expect(entries[0]?.detail).toBeUndefined();
  });

  it("collapses repeated lifecycle updates for the same tool call into one entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-update-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-update-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
          data: {
            item: {
              command: ["sed", "-n", "1,40p", "/tmp/app.ts"],
            },
          },
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tool-complete",
      createdAt: "2026-02-23T00:00:03.000Z",
      label: "Tool call completed",
      detail: 'Read: {"file_path":"/tmp/app.ts"}',
      command: "sed -n 1,40p /tmp/app.ts",
      itemType: "dynamic_tool_call",
      toolTitle: "Tool call",
    });
  });

  it("keeps separate tool entries when an identical call starts after the prior one completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-1-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-1-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-update",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-complete",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries.map((entry) => entry.id)).toEqual(["tool-1-complete", "tool-2-complete"]);
  });

  it("collapses same-timestamp lifecycle rows even when completed sorts before updated by id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "z-update-earlier",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "a-complete-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "z-update-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("a-complete-same-timestamp");
  });
});

describe("deriveTimelineEntries", () => {
  it("includes proposed plans alongside messages and work entries in chronological order", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.make("turn-1"),
          planMarkdown: "# Ship it",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:02.000Z",
        },
      ],
      [
        {
          id: "work-1",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Ran tests",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "proposed-plan", "work"]);
    expect(entries[1]).toMatchObject({
      kind: "proposed-plan",
      proposedPlan: {
        planMarkdown: "# Ship it",
        implementedAt: null,
        implementationThreadId: null,
      },
    });
  });

  it("hides harness implementation prompts while keeping proposed plan cards", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.make("message-harness"),
          role: "user",
          source: "harness",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Ship it",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
        {
          id: MessageId.make("message-legacy-plan"),
          role: "user",
          text: "  PLEASE IMPLEMENT THIS PLAN:\n# Ship it",
          createdAt: "2026-02-23T00:00:01.500Z",
          streaming: false,
        },
        {
          id: MessageId.make("message-user"),
          role: "user",
          source: "user",
          text: "visible follow-up",
          createdAt: "2026-02-23T00:00:03.000Z",
          streaming: false,
        },
      ],
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.make("turn-1"),
          planMarkdown: "# Ship it",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:02.000Z",
        },
      ],
      [],
    );

    expect(entries.map((entry) => entry.id)).toEqual([
      "plan:thread-1:turn:turn-1",
      MessageId.make("message-user"),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(["proposed-plan", "message"]);
  });

  it("hides recovery prompts and inserts a resume separator", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.make("message-recovery"),
          role: "user",
          source: "recovery",
          text: "The previous runtime session was interrupted or became unresponsive.",
          createdAt: "2026-02-23T00:00:02.000Z",
          streaming: false,
        },
        {
          id: MessageId.make("message-user"),
          role: "user",
          source: "user",
          text: "visible follow-up",
          createdAt: "2026-02-23T00:00:03.000Z",
          streaming: false,
        },
      ],
      [],
      [],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["separator", "message"]);
    expect(entries[0]).toMatchObject({
      id: "separator:message-recovery",
      label: "Thread resumed",
    });
    expect(entries.map((entry) => entry.id)).not.toContain(MessageId.make("message-recovery"));
  });

  it("anchors the completion divider to latestTurn.assistantMessageId before timestamp fallback", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.make("assistant-earlier"),
          role: "assistant",
          text: "progress update",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
        {
          id: MessageId.make("assistant-final"),
          role: "assistant",
          text: "final answer",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [],
      [],
    );

    expect(
      deriveCompletionDividerBeforeEntryId(entries, {
        assistantMessageId: MessageId.make("assistant-final"),
        startedAt: "2026-02-23T00:00:00.000Z",
        completedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe("assistant-final");
  });
});

describe("deriveWorkLogEntries context window handling", () => {
  it("excludes context window updates from the work log", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "context-1",
          turnId: "turn-1",
          kind: "context-window.updated",
          summary: "Context window updated",
          tone: "info",
        }),
        makeActivity({
          id: "tool-1",
          turnId: "turn-1",
          kind: "tool.completed",
          summary: "Ran command",
          tone: "tool",
        }),
      ],
      TurnId.make("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Ran command");
  });

  it("keeps context compaction activities as normal work log entries", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "compaction-1",
          turnId: "turn-1",
          kind: "context-compaction",
          summary: "Context compacted",
          tone: "info",
        }),
      ],
      TurnId.make("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Context compacted");
  });
});

describe("hasToolActivityForTurn", () => {
  it("returns false when turn id is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
    ];

    expect(hasToolActivityForTurn(activities, undefined)).toBe(false);
    expect(hasToolActivityForTurn(activities, null)).toBe(false);
  });

  it("returns true only for matching tool activity in the target turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
      makeActivity({ id: "info-1", turnId: "turn-2", kind: "turn.completed", tone: "info" }),
    ];

    expect(hasToolActivityForTurn(activities, TurnId.make("turn-1"))).toBe(true);
    expect(hasToolActivityForTurn(activities, TurnId.make("turn-2"))).toBe(false);
  });
});

describe("deriveActiveTurnActivityState", () => {
  const baseInput = {
    session: makeRunningSession(),
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "running" as const,
      requestedAt: "2026-02-23T00:00:00.000Z",
      startedAt: "2026-02-23T00:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
    },
    activities: [] as OrchestrationThreadActivity[],
    messages: [] as ChatMessage[],
    pendingApprovals: [],
    pendingUserInputs: [],
    isSendBusy: false,
    isConnecting: false,
    isRevertingCheckpoint: false,
  };

  it("shows waiting for model stream after turn start before content or tool events", () => {
    expect(deriveActiveTurnActivityState(baseInput)).toMatchObject({
      kind: "waitingForModel",
      label: "Waiting for model stream",
    });
  });

  it("shows streaming response when the current assistant message is streaming", () => {
    expect(
      deriveActiveTurnActivityState({
        ...baseInput,
        messages: [makeAssistantMessage()],
      }),
    ).toMatchObject({
      kind: "streamingAssistant",
      label: "Streaming response",
    });
  });

  it("shows the active tool and falls back after the tool completes", () => {
    const toolStarted = makeActivity({
      id: "tool-started",
      turnId: "turn-1",
      kind: "tool.started",
      summary: "Terminal started",
      payload: {
        itemType: "command_execution",
        title: "Terminal",
        data: { toolCallId: "tool-1", command: "bun lint" },
      },
    });
    const running = deriveActiveTurnActivityState({
      ...baseInput,
      activities: [toolStarted],
    });

    expect(running).toMatchObject({
      kind: "runningTool",
      label: "Running checks",
      detail: "bun lint",
    });

    expect(
      deriveActiveTurnActivityState({
        ...baseInput,
        activities: [
          toolStarted,
          makeActivity({
            id: "tool-completed",
            turnId: "turn-1",
            kind: "tool.completed",
            summary: "Terminal completed",
            payload: {
              itemType: "command_execution",
              title: "Terminal",
              data: { toolCallId: "tool-1", command: "bun lint" },
            },
          }),
        ],
      }),
    ).toMatchObject({
      kind: "waitingForModel",
      label: "Waiting for model stream",
    });
  });

  it("shows active context compaction above generic running state", () => {
    expect(
      deriveActiveTurnActivityState({
        ...baseInput,
        activities: [
          makeActivity({
            id: "compaction-started",
            turnId: "turn-1",
            kind: "context-compaction.started",
            summary: "Compacting context",
            payload: { itemId: "compaction-1", status: "running" },
          }),
        ],
      }),
    ).toMatchObject({
      kind: "compactingContext",
      label: "Compacting context",
    });
  });

  it("clears active context compaction after completion", () => {
    const activities = [
      makeActivity({
        id: "compaction-started",
        turnId: "turn-1",
        kind: "context-compaction.started",
        summary: "Compacting context",
        payload: { itemId: "compaction-1", status: "running" },
      }),
      makeActivity({
        id: "compaction-completed",
        turnId: "turn-1",
        kind: "context-compaction",
        summary: "Context compacted",
        payload: { itemId: "compaction-1", status: "completed" },
      }),
    ];

    expect(hasActiveContextCompaction(activities)).toBe(false);
    expect(
      deriveActiveTurnActivityState({
        ...baseInput,
        activities,
      }),
    ).toMatchObject({
      kind: "waitingForModel",
      label: "Waiting for model stream",
    });
  });

  it("lets approval and user-input blockers override running states", () => {
    expect(
      deriveActiveTurnActivityState({
        ...baseInput,
        messages: [makeAssistantMessage()],
        pendingApprovals: [
          {
            requestId: "approval-1" as never,
            requestKind: "command",
            createdAt: "2026-02-23T00:00:03.000Z",
          },
        ],
      }),
    ).toMatchObject({
      kind: "awaitingApproval",
      label: "Waiting for command approval",
    });

    expect(
      deriveActiveTurnActivityState({
        ...baseInput,
        pendingUserInputs: [
          {
            requestId: "input-1" as never,
            createdAt: "2026-02-23T00:00:03.000Z",
            questions: [
              {
                id: "q1",
                header: "Choice",
                question: "Pick an option",
                options: [{ label: "A", description: "Use A" }],
                multiSelect: false,
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      kind: "awaitingUserInput",
      label: "Waiting for your answer",
      detail: "Pick an option",
    });
  });
});

describe("isLatestTurnSettled", () => {
  const latestTurn = {
    turnId: TurnId.make("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("returns true for idle threads that have no turns yet", () => {
    expect(isLatestTurnSettled(null, null)).toBe(true);
    expect(
      isLatestTurnSettled(null, {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      }),
    ).toBe(true);
  });

  it("returns false for no-turn threads while a session is running", () => {
    expect(
      isLatestTurnSettled(null, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.make("turn-1"),
      }),
    ).toBe(false);
  });

  it("returns false while the same turn is still active in a running session", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.make("turn-1"),
      }),
    ).toBe(false);
  });

  it("returns false while any turn is running to avoid stale latest-turn banners", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.make("turn-2"),
      }),
    ).toBe(false);
  });

  it("returns true once the session is no longer running that turn", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      }),
    ).toBe(true);
  });

  it("returns false when turn timestamps are incomplete", () => {
    expect(
      isLatestTurnSettled(
        {
          turnId: TurnId.make("turn-1"),
          startedAt: null,
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
      ),
    ).toBe(false);
  });
});

describe("deriveActiveWorkStartedAt", () => {
  const latestTurn = {
    turnId: TurnId.make("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("prefers the in-flight turn start when the latest turn is not settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("turn-1"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:10:00.000Z");
  });

  it("uses the new send start while the session is running a different turn", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("turn-2"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("falls back to sendStartedAt once the latest turn is settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "ready",
          activeTurnId: undefined,
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("uses sendStartedAt for a fresh send after the prior turn completed", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: TurnId.make("turn-1"),
          startedAt: "2026-02-27T21:10:00.000Z",
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });
});

describe("deriveThreadWorkDurationMs", () => {
  const userInputQuestions = [
    {
      id: "next_step",
      header: "Next",
      question: "What should happen next?",
      options: [
        {
          label: "Continue",
          description: "Continue the turn",
        },
      ],
    },
  ];

  it("adds live running duration to persisted work time", () => {
    const result = deriveThreadWorkDurationMs({
      totalWorkDurationMs: 4_000,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        startedAt: "2026-02-27T21:10:00.000Z",
        completedAt: null,
      },
      session: {
        orchestrationStatus: "running",
        activeTurnId: TurnId.make("turn-1"),
      },
      sendStartedAt: null,
      nowMs: Date.parse("2026-02-27T21:10:03.000Z"),
    });

    expect(result).toEqual({ durationMs: 7_000, ticking: true });
  });

  it("continues ticking while post-model tool work is active", () => {
    const result = deriveThreadWorkDurationMs({
      totalWorkDurationMs: 4_000,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        startedAt: "2026-02-27T21:10:00.000Z",
        completedAt: "2026-02-27T21:10:03.000Z",
      },
      session: {
        orchestrationStatus: "running",
        activeTurnId: TurnId.make("turn-1"),
      },
      sendStartedAt: null,
      activities: [
        makeActivity({
          id: "tool-active",
          createdAt: "2026-02-27T21:10:04.000Z",
          kind: "tool.started",
        }),
      ],
      nowMs: Date.parse("2026-02-27T21:10:06.000Z"),
    });

    expect(result).toEqual({ durationMs: 10_000, ticking: true });
  });

  it("pauses while a user-input request is open", () => {
    const result = deriveThreadWorkDurationMs({
      totalWorkDurationMs: 4_000,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        startedAt: "2026-02-27T21:10:00.000Z",
        completedAt: null,
      },
      session: {
        orchestrationStatus: "running",
        activeTurnId: TurnId.make("turn-1"),
      },
      sendStartedAt: null,
      activities: [
        makeActivity({
          id: "user-input-open",
          createdAt: "2026-02-27T21:10:03.000Z",
          kind: "user-input.requested",
          payload: {
            requestId: "req-user-input-1",
            questions: userInputQuestions,
          },
        }),
      ],
      nowMs: Date.parse("2026-02-27T21:10:08.000Z"),
    });

    expect(result).toEqual({ durationMs: 7_000, ticking: false });
  });

  it("subtracts completed user-input pause intervals after resolution", () => {
    const result = deriveThreadWorkDurationMs({
      totalWorkDurationMs: 4_000,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        startedAt: "2026-02-27T21:10:00.000Z",
        completedAt: null,
      },
      session: {
        orchestrationStatus: "running",
        activeTurnId: TurnId.make("turn-1"),
      },
      sendStartedAt: null,
      activities: [
        makeActivity({
          id: "user-input-open",
          createdAt: "2026-02-27T21:10:03.000Z",
          kind: "user-input.requested",
          payload: {
            requestId: "req-user-input-1",
            questions: userInputQuestions,
          },
        }),
        makeActivity({
          id: "user-input-resolved",
          createdAt: "2026-02-27T21:10:07.000Z",
          kind: "user-input.resolved",
          payload: {
            requestId: "req-user-input-1",
          },
        }),
      ],
      nowMs: Date.parse("2026-02-27T21:10:10.000Z"),
    });

    expect(result).toEqual({ durationMs: 10_000, ticking: true });
  });

  it("does not pause for approval requests", () => {
    const result = deriveThreadWorkDurationMs({
      totalWorkDurationMs: 4_000,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        startedAt: "2026-02-27T21:10:00.000Z",
        completedAt: null,
      },
      session: {
        orchestrationStatus: "running",
        activeTurnId: TurnId.make("turn-1"),
      },
      sendStartedAt: null,
      activities: [
        makeActivity({
          id: "approval-open",
          createdAt: "2026-02-27T21:10:03.000Z",
          kind: "approval.requested",
          payload: {
            requestId: "req-approval-1",
            requestKind: "command",
          },
        }),
      ],
      nowMs: Date.parse("2026-02-27T21:10:08.000Z"),
    });

    expect(result).toEqual({ durationMs: 12_000, ticking: true });
  });

  it("does not double-count settled latest turns", () => {
    const result = deriveThreadWorkDurationMs({
      totalWorkDurationMs: 4_000,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        startedAt: "2026-02-27T21:10:00.000Z",
        completedAt: "2026-02-27T21:10:03.000Z",
      },
      session: {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      },
      sendStartedAt: null,
      nowMs: Date.parse("2026-02-27T21:10:10.000Z"),
    });

    expect(result).toEqual({ durationMs: 4_000, ticking: false });
  });

  it("uses sendStartedAt while a fresh turn is dispatching", () => {
    const result = deriveThreadWorkDurationMs({
      totalWorkDurationMs: 4_000,
      latestTurn: null,
      session: null,
      sendStartedAt: "2026-02-27T21:10:00.000Z",
      nowMs: Date.parse("2026-02-27T21:10:02.000Z"),
    });

    expect(result).toEqual({ durationMs: 6_000, ticking: true });
  });

  it("resumes when a done task is continued via a new send", () => {
    const result = deriveThreadWorkDurationMs({
      totalWorkDurationMs: 4_000,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        startedAt: "2026-02-27T21:10:00.000Z",
        completedAt: "2026-02-27T21:10:03.000Z",
      },
      session: {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      },
      sendStartedAt: "2026-02-27T21:11:00.000Z",
      nowMs: Date.parse("2026-02-27T21:11:05.000Z"),
    });

    expect(result).toEqual({ durationMs: 9_000, ticking: true });
  });

  it("does not produce negative duration for invalid pause timestamps", () => {
    const result = deriveThreadWorkDurationMs({
      totalWorkDurationMs: 4_000,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        startedAt: "2026-02-27T21:10:00.000Z",
        completedAt: null,
      },
      session: {
        orchestrationStatus: "running",
        activeTurnId: TurnId.make("turn-1"),
      },
      sendStartedAt: null,
      activities: [
        makeActivity({
          id: "user-input-open",
          createdAt: "not-a-date",
          kind: "user-input.requested",
          payload: {
            requestId: "req-user-input-1",
            questions: userInputQuestions,
          },
        }),
      ],
      nowMs: Date.parse("2026-02-27T21:10:08.000Z"),
    });

    expect(result).toEqual({ durationMs: 12_000, ticking: false });
  });
});
