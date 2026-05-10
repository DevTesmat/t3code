import { EnvironmentId, MessageId, ProviderItemId, ThreadId, TurnId } from "@t3tools/contracts";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";
import {
  hydrateLiveCommandOutputSnapshot,
  resetLiveCommandOutputForTests,
} from "../../liveCommandOutput";

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");

  const LegendList = React.forwardRef(function MockLegendList(
    props: {
      data: Array<{ id: string }>;
      keyExtractor: (item: { id: string }) => string;
      renderItem: (args: { item: { id: string } }) => React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
    },
    _ref: React.ForwardedRef<LegendListRef>,
  ) {
    return (
      <div data-testid="legend-list">
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  });

  return { LegendList };
});

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
});

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnId: null,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    completionDividerBeforeEntryId: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    turnDiffSummaryByTurnId: new Map(),
    inferredCheckpointTurnCountByTurnId: {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadId: ThreadId.make("thread-1"),
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: () => {},
  };
}

describe("MessagesTimeline", () => {
  beforeEach(() => {
    resetLiveCommandOutputForTests();
  });

  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-2"),
              role: "user",
              text: [
                "yoo what's @terminal-1:1-5 mean",
                "",
                "<terminal_context>",
                "- Terminal 1 lines 1-5:",
                "  1 | julius@mac effect-http-ws-cli % bun i",
                "  2 | bun install v1.3.9 (cf6cdbbb)",
                "</terminal_context>",
              ].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s ");
  }, 20_000);

  it("renders context compaction entries in the normal work log", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Context compacted");
    expect(markup).toContain("Work log");
  });

  it("formats changed file paths from the workspace root", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Updated files",
              tone: "tool",
              changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/t3code"
      />,
    );

    expect(markup).toContain("t3code/apps/web/src/session-logic.ts");
    expect(markup).not.toContain("C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts");
  });

  it("renders successful terminal command rows as compact collapsed command boxes", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "bun run lint",
              status: "completed",
              exitCode: 0,
              outputPreview: {
                lines: ["line one", "line two", "line three", "line four"],
                stream: "stdout",
                truncated: true,
              },
            },
          },
        ]}
      />,
    );

    expect(markup).not.toContain("Ran command - bun run lint");
    expect(markup).toContain("Completed");
    expect(markup).toContain("exit 0");
    expect(markup).not.toContain("<details");
    expect(markup).toContain("tool-output-toggle");
    expect(markup).toContain("bun run lint");
    expect(markup).not.toContain("line one");
    expect(markup).not.toContain("Output preview truncated");
  });

  it("auto-renders completed terminal output from the hydrated live buffer", async () => {
    hydrateLiveCommandOutputSnapshot(ACTIVE_THREAD_ENVIRONMENT_ID, {
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      toolCallId: ProviderItemId.make("tool-1"),
      updatedAt: "2026-03-17T19:12:30.000Z",
      text: "line one\nline two\nline three\nline four\nline five",
      truncated: false,
    });

    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "bun run lint",
              status: "completed",
              toolCallId: "tool-1",
              outputPreview: {
                lines: ["line two", "line three", "line four", "line five"],
                stream: "stdout",
                truncated: true,
              },
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Completed");
    expect(markup).toContain("tool-output-preview");
    expect(markup).toContain("overflow-auto");
    expect(markup).toContain("whitespace-pre");
    expect(markup).toContain("line one");
    expect(markup).toContain("line five");
    expect(markup).not.toContain("[output truncated]");
  });

  it("auto-renders running file-change output from the hydrated live buffer", async () => {
    hydrateLiveCommandOutputSnapshot(ACTIVE_THREAD_ENVIRONMENT_ID, {
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      toolCallId: ProviderItemId.make("file-change-1"),
      updatedAt: "2026-03-17T19:12:30.000Z",
      text: [
        "diff --git a/src/app.ts b/src/app.ts",
        "@@ -1,2 +1,2 @@",
        "-const value = 'old';",
        "+const value = 'new';",
        "",
      ].join("\n"),
      truncated: false,
    });

    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Editing files",
              tone: "tool",
              itemType: "file_change",
              status: "running",
              toolCallId: "file-change-1",
              changedFiles: ["src/app.ts"],
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Editing files");
    expect(markup).toContain("src/app.ts");
    expect(markup).toContain("-const value = &#x27;old&#x27;;");
    expect(markup).toContain("+const value = &#x27;new&#x27;;");
    expect(countOccurrences(markup, ">1</span>")).toBeGreaterThanOrEqual(2);
    expect(markup).toContain("bg-success");
    expect(markup).toContain("bg-destructive");
  });

  it("numbers streamed Codex new-file patches without hunk headers", async () => {
    hydrateLiveCommandOutputSnapshot(ACTIVE_THREAD_ENVIRONMENT_ID, {
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      toolCallId: ProviderItemId.make("file-change-new-file"),
      updatedAt: "2026-03-17T19:12:30.000Z",
      text: [
        "diff --git a/file-change-ui-medium-new-patches-2026-05-09.md b/file-change-ui-medium-new-patches-2026-05-09.md",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/file-change-ui-medium-new-patches-2026-05-09.md",
        "# File Change UI Fixture",
        "",
        "First body line",
        "Second body line",
      ].join("\n"),
      truncated: false,
    });

    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Editing files",
              tone: "tool",
              itemType: "file_change",
              status: "running",
              toolCallId: "file-change-new-file",
              changedFiles: ["file-change-ui-medium-new-patches-2026-05-09.md"],
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("# File Change UI Fixture");
    expect(markup).toContain("First body line");
    expect(markup).toContain(">1</span>");
    expect(markup).toContain(">3</span>");
    expect(markup).toContain(">4</span>");
    expect(markup).toContain("bg-success");
  });

  it("renders partial file-change output before a newline arrives", async () => {
    hydrateLiveCommandOutputSnapshot(ACTIVE_THREAD_ENVIRONMENT_ID, {
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      toolCallId: ProviderItemId.make("file-change-partial"),
      updatedAt: "2026-03-17T19:12:30.000Z",
      text: "+const partial",
      truncated: false,
    });

    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Editing files",
              tone: "tool",
              itemType: "file_change",
              status: "running",
              toolCallId: "file-change-partial",
              changedFiles: ["src/app.ts"],
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("+const partial");
    expect(markup).toContain("inline-file-change-patch");
  });

  it("renders codebase exploration as one collapsed expandable row", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "rg query apps/web",
              status: "completed",
            },
          },
          {
            id: "entry-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-2",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "sed -n '1,80p' apps/web/src/session-logic.ts",
              status: "completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Exploring");
    expect(markup.match(/Exploring/g)).toHaveLength(1);
    expect(markup).not.toContain("Completed");
    expect(markup).not.toContain("animate-pulse");
    expect(markup).toContain("exploration-group-toggle");
    expect(markup).not.toContain("rg query apps/web");
    expect(markup).not.toContain("sed -n");
  });

  it("renders generated inspection pipelines as one collapsed exploration row", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-find-xargs",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-find-xargs",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command:
                "find Gitex.Module.* -maxdepth 1 -name '*.csproj' | sort | xargs -I{} sh -c 'printf \"%s\\n\" \"$1\"' sh {}",
              status: "completed",
            },
          },
          {
            id: "entry-node-package",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-node-package",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command:
                'for f in Gitex.Module.*.App/package.json; do printf "%s\\n" "$f"; node -e "const p=require(\'./package.json\'); console.log(p.name)"; done',
              status: "completed",
            },
          },
          {
            id: "entry-sed-find",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.000Z",
            entry: {
              id: "work-sed-find",
              createdAt: "2026-03-17T19:12:30.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command:
                "sed -n '1,180p' Gitex.Module.Core.App/package.json && find Gitex.Module.Core.App/src/app -maxdepth 2 -type f | sort | sed -n '1,80p'",
              status: "completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Exploring");
    expect(markup.match(/Exploring/g)).toHaveLength(1);
    expect(markup).not.toContain("Terminal");
    expect(markup).not.toContain("find Gitex.Module");
    expect(markup).not.toContain("node -e");
  });

  it("keeps non-adjacent exploration commands collapsed within a message interval", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-rg",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-rg",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "rg query apps/web",
              status: "completed",
            },
          },
          {
            id: "entry-test",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-test",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "bun run test",
              status: "completed",
            },
          },
          {
            id: "entry-sed",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.000Z",
            entry: {
              id: "work-sed",
              createdAt: "2026-03-17T19:12:30.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "sed -n '1,80p' apps/web/src/session-logic.ts",
              status: "completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Exploring");
    expect(markup.match(/Exploring/g)).toHaveLength(1);
    expect(markup).toContain("Validation");
    expect(markup).toContain("bun run test");
    expect(markup).not.toContain("rg query apps/web");
    expect(markup).not.toContain("sed -n");
  });

  it("shows exploration dots only while a grouped tool call is running", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "rg query apps/web",
              status: "running",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Exploring");
    expect(markup).toContain("animate-pulse");
  });

  it("renders validation commands as their own visible section", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "bun run test",
              status: "failed",
              outputPreview: {
                lines: ["expected true to be false"],
                stream: "stderr",
                truncated: false,
              },
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Validation");
    expect(markup).toContain("bun run test");
    expect(markup).toContain("Failed");
    expect(markup).toContain("expected true to be false");
  });

  it("renders terminal command input while output is pending", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "bun run typecheck",
              status: "running",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Running");
    expect(markup).toContain("bun run typecheck");
    expect(markup).not.toContain("tool-output-toggle");
    expect(markup).not.toContain("Waiting for output");
  });

  it("auto-renders failed stderr terminal previews with a subtle stream label", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "bun run build",
              status: "failed",
              exitCode: 1,
              outputPreview: {
                lines: ["TypeError: nope"],
                stream: "stderr",
                truncated: false,
              },
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Failed");
    expect(markup).toContain("exit 1");
    expect(markup).toContain("tool-output-toggle");
    expect(markup).toContain("stderr");
    expect(markup).toContain("TypeError: nope");
  });

  it("renders managed patch failures as compact failed edit rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File edit failed",
              detail: "Failed to find expected lines in apps/web/src/session-logic.ts:",
              tone: "tool",
              itemType: "file_change",
              changedFiles: ["apps/web/src/session-logic.ts"],
              status: "failed",
              failure: {
                kind: "apply_patch_verification_failed",
                path: "apps/web/src/session-logic.ts",
                reason: "Failed to find expected lines in apps/web/src/session-logic.ts:",
                expectedContent: "const oldValue = true;",
              },
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("File edit failed");
    expect(markup).toContain("apps/web/src/session-logic.ts");
    expect(markup).toContain("Failed");
    expect(markup).toContain("managed-failed-edit-toggle");
    expect(markup).not.toContain("inline-diff-toggle");
  });

  it("auto-renders running terminal output previews", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "bun run dev",
              status: "running",
              outputPreview: {
                lines: ["ready in 124ms"],
                stream: "stdout",
                truncated: false,
              },
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Running");
    expect(markup).toContain("bun run dev");
    expect(markup).toContain("last output");
    expect(markup).toContain("ready in 124ms");
    expect(markup).toContain("whitespace-pre");
    expect(countOccurrences(markup, 'aria-label="Copy link"')).toBe(1);
  });

  it("renders a running terminal output envelope before persisted preview lines exist", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "bun run dev",
              status: "running",
              toolCallId: "tool-1",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("tool-output-preview");
    expect(markup).toContain("overflow-auto");
    expect(markup).toContain("whitespace-pre");
  });

  it("keeps older terminal rows hidden behind show more in overflowing work groups", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const entries = Array.from({ length: 7 }, (_, index) => {
      const command = index === 0 ? "bun run hidden-failure" : `bun run visible-${index}`;
      return {
        id: `entry-${index}`,
        kind: "work" as const,
        createdAt: `2026-03-17T19:12:2${index}.000Z`,
        entry: {
          id: `work-${index}`,
          createdAt: `2026-03-17T19:12:2${index}.000Z`,
          label: "Ran command",
          tone: "tool" as const,
          itemType: "command_execution" as const,
          command,
          status: index === 0 ? ("failed" as const) : ("completed" as const),
          outputPreview: {
            lines: [index === 0 ? "hidden error" : `visible output ${index}`],
            stream: index === 0 ? ("stderr" as const) : ("stdout" as const),
            truncated: false,
          },
        },
      };
    });
    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={entries} />,
    );

    expect(markup).toContain("Show 1 more");
    expect(markup).not.toContain("bun run hidden-failure");
    expect(markup).not.toContain("hidden error");
    expect(markup).toContain("bun run visible-1");
    expect(markup).toContain("bun run visible-6");
  });

  it("falls back to a generic terminal label when the command is missing", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Terminal",
              tone: "tool",
              itemType: "command_execution",
              status: "completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Ran command");
    expect(markup).toContain("Completed");
  });

  it("does not render terminal output preview styling for non-command tools", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "dynamic_tool_call",
              outputPreview: {
                lines: ["should not render"],
                stream: "stdout",
                truncated: false,
              },
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Exploring");
    expect(markup).not.toContain("should not render");
  });

  it("does not render assistant changed files inside message content", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.make("message-assistant-1");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "Done.",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.make("turn-1"),
                completedAt: "2026-03-17T19:12:29.000Z",
                assistantMessageId,
                files: [{ path: "apps/web/src/ChatView.tsx", additions: 3, deletions: 1 }],
              },
            ],
          ])
        }
      />,
    );

    expect(markup).toContain("Done.");
    expect(markup).not.toContain("Changed files");
    expect(markup).not.toContain("ChatView.tsx");
  });

  it("renders the response divider without elapsed work text", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.make("message-assistant-1");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        completionDividerBeforeEntryId="entry-1"
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "Done.",
              createdAt: "2026-03-17T19:12:28.000Z",
              completedAt: "2026-03-17T19:12:40.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Response");
    expect(markup).not.toContain("Worked for");
  });

  it("renders working dots only for an active working row", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const activeMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        activeTurnActivityState={{ kind: "runningTool", label: "Running command" }}
        timelineEntries={[]}
      />,
    );
    const idleMarkup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[]} />,
    );

    expect(activeMarkup).toContain("Running command");
    expect(activeMarkup).toContain("animate-pulse");
    expect(activeMarkup).toContain('data-testid="working-activity-detail"');
    expect(activeMarkup).toContain("min-h-4");
    expect(activeMarkup).toContain("invisible");
    expect(activeMarkup).toContain('aria-hidden="true"');
    expect(idleMarkup).not.toContain("animate-pulse");
  });

  it("renders working activity detail in reserved second line", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        activeTurnActivityState={{
          kind: "runningTool",
          label: "Running command",
          detail: "bun lint",
        }}
        timelineEntries={[]}
      />,
    );

    expect(markup).toContain('data-testid="working-activity-detail"');
    expect(markup).toContain("bun lint");
    expect(markup).not.toContain("invisible");
  });
});
