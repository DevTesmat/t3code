import { describe, expect, it } from "vitest";
import {
  computeStableMessagesTimelineRows,
  computeMessageDurationStart,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
} from "./MessagesTimeline.logic";

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous assistant completedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("does not advance the boundary for a streaming message without completedAt", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:30Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      { id: "u2", role: "user", createdAt: "2026-01-01T00:01:00Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        completedAt: "2026-01-01T00:01:20Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["u2", "2026-01-01T00:01:00Z"],
        ["a2", "2026-01-01T00:01:00Z"],
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "s1", role: "system", createdAt: "2026-01-01T00:00:01Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["s1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });

  it("removes trailing started wording from lifecycle labels", () => {
    expect(normalizeCompactToolLabel("Ran command started")).toBe("Ran command");
  });
});

describe("resolveAssistantMessageCopyState", () => {
  it("returns enabled copy state for completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Ship it",
        streaming: false,
      }),
    ).toEqual({
      text: "Ship it",
      visible: true,
    });
  });

  it("hides copy while an assistant message is still streaming", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Still streaming",
        streaming: true,
      }),
    ).toEqual({
      text: "Still streaming",
      visible: false,
    });
  });

  it("hides copy for empty completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "   ",
        streaming: false,
      }),
    ).toEqual({
      text: null,
      visible: false,
    });
  });

  it("hides copy for non-terminal assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: false,
        text: "Interim thought",
        streaming: false,
      }),
    ).toEqual({
      text: "Interim thought",
      visible: false,
    });
  });
});

describe("deriveMessagesTimelineRows", () => {
  it("adds the derived active state to the working row", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [],
      completionDividerBeforeEntryId: null,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      activeTurnActivityState: {
        kind: "runningTool",
        label: "Running terminal",
        detail: "bun lint",
      },
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows).toEqual([
      {
        kind: "working",
        id: "working-indicator-row",
        createdAt: "2026-01-01T00:00:00Z",
        activityState: {
          kind: "runningTool",
          label: "Running terminal",
          detail: "bun lint",
        },
      },
    ]);
  });

  it("only enables assistant copy for the terminal assistant message in a turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Write a poem",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "I should ground this first.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            completedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Here is the poem.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            completedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: "assistant-final-entry",
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0]?.showAssistantCopyButton).toBe(false);
    expect(assistantRows[1]?.showAssistantCopyButton).toBe(true);
    expect(assistantRows[1]?.showCompletionDivider).toBe(true);
  });

  it("projects assistant diff summaries and user revert counts onto the affected rows", () => {
    const assistantTurnDiffSummary = {
      turnId: "turn-1" as never,
      completedAt: "2026-01-01T00:00:30Z",
      assistantMessageId: "assistant-1" as never,
      checkpointTurnCount: 2,
      files: [{ path: "src/index.ts", additions: 3, deletions: 1 }],
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Do the thing",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Done",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            completedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map([
        ["assistant-1" as never, assistantTurnDiffSummary],
      ]),
      revertTurnCountByUserMessageId: new Map([["user-1" as never, 1]]),
    });

    const userRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "user",
    );
    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(userRow?.revertTurnCount).toBe(1);
    expect(assistantRow?.assistantTurnDiffSummary).toBe(assistantTurnDiffSummary);
  });

  it("uses stable tool keys for work row ids across lifecycle activity id changes", () => {
    const buildRows = (entryId: string, outputLine: string) =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: entryId,
            kind: "work",
            createdAt: "2026-01-01T00:00:00Z",
            entry: {
              id: entryId,
              createdAt: "2026-01-01T00:00:00Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "bun run dev",
              status: "running",
              toolKey: "tool:call-1",
              outputPreview: {
                lines: [outputLine],
                stream: "stdout",
                truncated: false,
              },
            },
          },
        ],
        completionDividerBeforeEntryId: null,
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

    const startedRows = buildRows("activity-started", "starting");
    const updatedRows = buildRows("activity-updated", "ready");

    expect(startedRows[0]?.id).toBe("work-group:other:tool:call-1");
    expect(updatedRows[0]?.id).toBe(startedRows[0]?.id);
  });

  it("suffixes repeated work group ids so LegendList keys stay unique", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-rg-start",
          kind: "work",
          createdAt: "2026-01-01T00:00:00Z",
          entry: {
            id: "work-rg-start",
            createdAt: "2026-01-01T00:00:00Z",
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            command: "rg query src",
            toolKey: "tool:call-explore",
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:01Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Still checking.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:01Z",
            streaming: false,
          },
        },
        {
          id: "entry-rg-repeat",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "work-rg-repeat",
            createdAt: "2026-01-01T00:00:02Z",
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            command: "rg query src",
            toolKey: "tool:call-explore",
          },
        },
        {
          id: "entry-other-start",
          kind: "work",
          createdAt: "2026-01-01T00:00:03Z",
          entry: {
            id: "work-other-start",
            createdAt: "2026-01-01T00:00:03Z",
            label: "Tool call",
            tone: "tool",
            itemType: "dynamic_tool_call",
            toolKey: "tool:call-other",
          },
        },
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:04Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Continue.",
            turnId: null,
            createdAt: "2026-01-01T00:00:04Z",
            streaming: false,
          },
        },
        {
          id: "entry-other-repeat",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-other-repeat",
            createdAt: "2026-01-01T00:00:05Z",
            label: "Tool call",
            tone: "tool",
            itemType: "dynamic_tool_call",
            toolKey: "tool:call-other",
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const workRowIds = rows
      .filter((row): row is Extract<(typeof rows)[number], { kind: "work" }> => row.kind === "work")
      .map((row) => row.id);

    expect(workRowIds).toEqual([
      "work-group:exploration:tool:call-explore",
      "work-group:exploration:tool:call-explore:2",
      "work-group:other:tool:call-other",
      "work-group:other:tool:call-other:2",
    ]);
    expect(new Set(workRowIds).size).toBe(workRowIds.length);
  });

  it("groups exploration rows within the same visible-message interval", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-rg",
          kind: "work",
          createdAt: "2026-01-01T00:00:00Z",
          entry: {
            id: "work-rg",
            createdAt: "2026-01-01T00:00:00Z",
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            command: "rg query src",
            status: "completed",
          },
        },
        {
          id: "entry-sed",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "work-sed",
            createdAt: "2026-01-01T00:00:01Z",
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            command: "sed -n '1,80p' src/app.ts",
            status: "completed",
          },
        },
        {
          id: "entry-edit",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "work-edit",
            createdAt: "2026-01-01T00:00:02Z",
            label: "File change",
            tone: "tool",
            itemType: "file_change",
            changedFiles: ["src/app.ts"],
            status: "completed",
          },
        },
        {
          id: "entry-diff",
          kind: "work",
          createdAt: "2026-01-01T00:00:03Z",
          entry: {
            id: "work-diff",
            createdAt: "2026-01-01T00:00:03Z",
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            command: "git diff -- src/app.ts",
            status: "completed",
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const workRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "work" }> => row.kind === "work",
    );

    expect(workRows.map((row) => row.activityGroupKind)).toEqual(["exploration", "other"]);
    expect(workRows.map((row) => row.groupedEntries.map((entry) => entry.id))).toEqual([
      ["work-rg", "work-sed", "work-diff"],
      ["work-edit"],
    ]);
  });

  it("starts a new exploration group after visible assistant messages", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-rg",
          kind: "work",
          createdAt: "2026-01-01T00:00:00Z",
          entry: {
            id: "work-rg",
            createdAt: "2026-01-01T00:00:00Z",
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            command: "rg query src",
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:01Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "I found the relevant files.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:01Z",
            streaming: false,
          },
        },
        {
          id: "entry-sed",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "work-sed",
            createdAt: "2026-01-01T00:00:02Z",
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            command: "sed -n '1,80p' src/app.ts",
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const workRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "work" }> => row.kind === "work",
    );

    expect(workRows.map((row) => row.activityGroupKind)).toEqual(["exploration", "exploration"]);
    expect(workRows.map((row) => row.groupedEntries.map((entry) => entry.id))).toEqual([
      ["work-rg"],
      ["work-sed"],
    ]);
  });

  it("starts a new exploration group after proposed plans", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-rg",
          kind: "work",
          createdAt: "2026-01-01T00:00:00Z",
          entry: {
            id: "work-rg",
            createdAt: "2026-01-01T00:00:00Z",
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            command: "rg query src",
          },
        },
        {
          id: "plan-entry",
          kind: "proposed-plan",
          createdAt: "2026-01-01T00:00:01Z",
          proposedPlan: {
            id: "plan-1" as never,
            createdAt: "2026-01-01T00:00:01Z",
            updatedAt: "2026-01-01T00:00:01Z",
            turnId: "turn-1" as never,
            planMarkdown: "Plan",
            implementedAt: null,
            implementationThreadId: null,
          },
        },
        {
          id: "entry-sed",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "work-sed",
            createdAt: "2026-01-01T00:00:02Z",
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            command: "sed -n '1,80p' src/app.ts",
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const workRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "work" }> => row.kind === "work",
    );

    expect(workRows.map((row) => row.groupedEntries.map((entry) => entry.id))).toEqual([
      ["work-rg"],
      ["work-sed"],
    ]);
  });

  it("keeps validation commands in their own adjacent group", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-rg",
          kind: "work",
          createdAt: "2026-01-01T00:00:00Z",
          entry: {
            id: "work-rg",
            createdAt: "2026-01-01T00:00:00Z",
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            command: "rg query src",
          },
        },
        {
          id: "entry-test",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "work-test",
            createdAt: "2026-01-01T00:00:01Z",
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            command: "bun run test",
          },
        },
        {
          id: "entry-typecheck",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "work-typecheck",
            createdAt: "2026-01-01T00:00:02Z",
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            command: "bun typecheck",
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const workRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "work" }> => row.kind === "work",
    );

    expect(workRows.map((row) => row.activityGroupKind)).toEqual(["exploration", "validation"]);
    expect(workRows[1]?.groupedEntries.map((entry) => entry.id)).toEqual([
      "work-test",
      "work-typecheck",
    ]);
  });
});

describe("computeStableMessagesTimelineRows", () => {
  it("returns the previous result when row order and content are unchanged", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(rows, {
      byId: new Map(),
      result: [],
    });

    const repeated = computeStableMessagesTimelineRows(rows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result).toBe(initial.result);
  });

  it("returns a new result when row order changes without content changes", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const firstRows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });

    const reordered = computeStableMessagesTimelineRows([firstRows[1]!, firstRows[0]!], initial);

    expect(reordered).not.toBe(initial);
    expect(reordered.result).toEqual([initial.result[1], initial.result[0]]);
  });
});
