import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  EnvironmentId,
  MessageId,
  ProviderItemId,
  ThreadId,
  TurnId,
  type EnvironmentApi,
} from "@t3tools/contracts";
import { createRef, useState } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const scrollToEndSpy = vi.fn();
const getStateSpy = vi.fn(() => ({ isAtEnd: true }));
const legendListPropsSpy = vi.fn();

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");

  interface MockLegendListProps {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => React.ReactNode;
    ListHeaderComponent?: React.ReactNode;
    ListFooterComponent?: React.ReactNode;
    className?: string;
    maintainScrollAtEnd?: boolean;
    onScroll?: () => void;
    onWheel?: React.WheelEventHandler<HTMLDivElement>;
    onTouchStart?: React.TouchEventHandler<HTMLDivElement>;
    onTouchMove?: React.TouchEventHandler<HTMLDivElement>;
    onPointerDown?: React.PointerEventHandler<HTMLDivElement>;
    onPointerUp?: React.PointerEventHandler<HTMLDivElement>;
    "data-chat-messages-scroll"?: string;
  }

  const LegendList = React.forwardRef<LegendListRef, MockLegendListProps>(
    function MockLegendList(props, ref) {
      React.useImperativeHandle(
        ref,
        () =>
          ({
            scrollToEnd: scrollToEndSpy,
            getState: getStateSpy,
          }) as unknown as LegendListRef,
      );
      legendListPropsSpy(props);

      const {
        data,
        keyExtractor,
        renderItem,
        ListHeaderComponent,
        ListFooterComponent,
        className,
        onScroll,
        "data-chat-messages-scroll": dataChatMessagesScroll,
      } = props;

      return (
        <div
          data-testid="legend-list"
          className={className}
          data-chat-messages-scroll={dataChatMessagesScroll}
          onScroll={onScroll}
          onWheel={props.onWheel}
          onTouchStart={props.onTouchStart}
          onTouchMove={props.onTouchMove}
          onPointerDown={props.onPointerDown}
          onPointerUp={props.onPointerUp}
        >
          {ListHeaderComponent}
          {data.map((item) => (
            <div key={keyExtractor(item)}>{renderItem({ item })}</div>
          ))}
          {ListFooterComponent}
        </div>
      );
    },
  );

  return { LegendList };
});

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: (props: {
    fileDiff: {
      name?: string;
      prevName?: string;
      additionLines?: string[];
      deletionLines?: string[];
    };
  }) => (
    <div data-testid="inline-file-diff">
      <div data-diffs-header>
        <button type="button" data-title>
          {props.fileDiff.name ?? props.fileDiff.prevName}
        </button>
        <span data-testid="inline-file-diff-counter">1 change</span>
      </div>
      {(props.fileDiff.deletionLines ?? []).map((line) => (
        <span key={`deletion:${line}`}>-{line}</span>
      ))}
      {(props.fileDiff.additionLines ?? []).map((line) => (
        <span key={`addition:${line}`}>+{line}</span>
      ))}
    </div>
  ),
}));

const mockSettings = { diffWordWrap: false };

vi.mock("../../hooks/useSettings", () => ({
  getClientSettings: () => mockSettings,
  useSettings: <T,>(selector?: (settings: typeof mockSettings) => T) =>
    selector ? selector(mockSettings) : mockSettings,
  useUpdateSettings: () => ({
    updateSettings: vi.fn(),
    resetSettings: vi.fn(),
  }),
  __resetClientSettingsPersistenceForTests: vi.fn(),
}));

import { MessagesTimeline } from "./MessagesTimeline";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import {
  hydrateLiveCommandOutputSnapshot,
  resetLiveCommandOutputForTests,
} from "../../liveCommandOutput";

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnId: null,
    listRef: createRef<LegendListRef | null>(),
    completionDividerBeforeEntryId: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    turnDiffSummaryByTurnId: new Map(),
    inferredCheckpointTurnCountByTurnId: {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: vi.fn(),
    isRevertingCheckpoint: false,
    onImageExpand: vi.fn(),
    activeThreadId: ThreadId.make("thread-1"),
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    markdownCwd: undefined,
    timestampFormat: "24-hour" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: vi.fn(),
  };
}

function expectBrowserDurationUnder(startedAt: number, budgetMs: number, scenario: string) {
  const durationMs = performance.now() - startedAt;
  expect(
    durationMs,
    `${scenario} exceeded browser perf budget: ${durationMs.toFixed(1)}ms > ${budgetMs}ms`,
  ).toBeLessThan(budgetMs);
}

describe("MessagesTimeline", () => {
  afterEach(() => {
    scrollToEndSpy.mockReset();
    getStateSpy.mockClear();
    legendListPropsSpy.mockClear();
    __resetEnvironmentApiOverridesForTests();
    resetLiveCommandOutputForTests();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renders activity rows instead of the empty placeholder when a thread has non-message timeline data", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "work-1",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "thinking",
              detail: "Inspecting repository state",
              tone: "thinking",
            },
          },
        ]}
      />,
    );

    try {
      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .not.toBeInTheDocument();
      await expect.element(page.getByText("Thinking - Inspecting repository state")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("snaps to the bottom when timeline rows appear after an initially empty render", async () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const props = buildProps();
    const screen = await render(<MessagesTimeline {...props} timelineEntries={[]} />);

    try {
      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .toBeVisible();

      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[
            {
              id: "work-1",
              kind: "work",
              createdAt: "2026-04-13T12:00:00.000Z",
              entry: {
                id: "work-1",
                createdAt: "2026-04-13T12:00:00.000Z",
                label: "thinking",
                detail: "Inspecting repository state",
                tone: "thinking",
              },
            },
          ]}
        />,
      );

      await expect.element(page.getByText("Thinking - Inspecting repository state")).toBeVisible();
      expect(props.onIsAtEndChange).toHaveBeenCalledWith(true);
      expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
      expect(requestAnimationFrameSpy).toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("routes proposed plan expansion through viewport preservation", async () => {
    const onPreserveViewportRequest = vi.fn((_anchor: HTMLElement, mutate: () => void) => {
      mutate();
    });
    const props = buildProps();
    const longPlanMarkdown = [
      "# Long plan",
      "",
      ...Array.from({ length: 24 }, (_, index) => `${index + 1}. Step ${index + 1}`),
    ].join("\n");

    const screen = await render(
      <MessagesTimeline
        {...props}
        onPreserveViewportRequest={onPreserveViewportRequest}
        timelineEntries={[
          {
            id: "plan-entry-1",
            kind: "proposed-plan",
            createdAt: "2026-04-13T12:00:00.000Z",
            proposedPlan: {
              id: "plan-1",
              turnId: null,
              planMarkdown: longPlanMarkdown,
              implementedAt: null,
              implementationThreadId: null,
              createdAt: "2026-04-13T12:00:00.000Z",
              updatedAt: "2026-04-13T12:00:00.000Z",
            },
          },
        ]}
      />,
    );

    try {
      await page.getByRole("button", { name: "Expand plan" }).click();
      expect(onPreserveViewportRequest).toHaveBeenCalledTimes(1);
      expect(onPreserveViewportRequest.mock.calls[0]?.[0]).toBeInstanceOf(HTMLElement);
      expect(scrollToEndSpy).not.toHaveBeenCalled();

      await expect.element(page.getByRole("button", { name: "Collapse plan" })).toBeVisible();
      await page.getByRole("button", { name: "Collapse plan" }).click();
      expect(onPreserveViewportRequest).toHaveBeenCalledTimes(2);
      expect(scrollToEndSpy).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps full streaming plan content mounted while collapsed", async () => {
    const props = buildProps();
    const hiddenStreamingLine = "Hidden streaming step remains mounted";
    const longPlanMarkdown = [
      "# Streaming plan",
      "",
      ...Array.from({ length: 24 }, (_, index) =>
        index === 23 ? `- ${hiddenStreamingLine}` : `- Step ${index + 1}`,
      ),
    ].join("\n");

    const baseProposedPlan = {
      id: "plan-1",
      turnId: null,
      planMarkdown: longPlanMarkdown,
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-04-13T12:00:00.000Z",
      updatedAt: "2026-04-13T12:00:00.000Z",
    };

    const screen = await render(
      <MessagesTimeline
        {...props}
        timelineEntries={[
          {
            id: "plan-entry-1",
            kind: "proposed-plan",
            createdAt: "2026-04-13T12:00:00.000Z",
            proposedPlan: {
              ...baseProposedPlan,
              streaming: true,
            },
          },
        ]}
      />,
    );

    try {
      await expect.element(page.getByRole("button", { name: "Expand plan" })).toBeVisible();
      expect(document.body.textContent).toContain(hiddenStreamingLine);

      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[
            {
              id: "plan-entry-1",
              kind: "proposed-plan",
              createdAt: "2026-04-13T12:00:00.000Z",
              proposedPlan: baseProposedPlan,
            },
          ]}
        />,
      );

      expect(document.body.textContent).toContain("...");
      expect(document.body.textContent).not.toContain(hiddenStreamingLine);
    } finally {
      await screen.unmount();
    }
  });

  it("passes maintain-scroll suppression through to LegendList", async () => {
    const props = buildProps();
    const timelineEntries = [
      {
        id: "work-1",
        kind: "work" as const,
        createdAt: "2026-04-13T12:00:00.000Z",
        entry: {
          id: "work-1",
          createdAt: "2026-04-13T12:00:00.000Z",
          label: "thinking",
          detail: "Inspecting repository state",
          tone: "thinking" as const,
        },
      },
    ];

    const screen = await render(<MessagesTimeline {...props} timelineEntries={timelineEntries} />);

    try {
      expect(legendListPropsSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ maintainScrollAtEnd: true }),
      );

      await screen.rerender(
        <MessagesTimeline
          {...props}
          suppressMaintainScrollAtEnd
          timelineEntries={timelineEntries}
        />,
      );

      expect(legendListPropsSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ maintainScrollAtEnd: false }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("pins to the bottom when assistant text streams while stickiness is enabled", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const baseEntry = {
      id: "assistant-1",
      kind: "message" as const,
      createdAt: "2026-04-13T12:00:00.000Z",
      message: {
        id: MessageId.make("assistant-1"),
        role: "assistant" as const,
        text: "Initial streaming text",
        turnId: null,
        streaming: true,
        createdAt: "2026-04-13T12:00:00.000Z",
        updatedAt: "2026-04-13T12:00:00.000Z",
      },
    };

    const props = buildProps();
    const screen = await render(<MessagesTimeline {...props} timelineEntries={[baseEntry]} />);

    try {
      scrollToEndSpy.mockClear();

      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[
            {
              ...baseEntry,
              message: {
                ...baseEntry.message,
                text: "Initial streaming text plus a streamed token",
              },
            },
          ]}
        />,
      );

      expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
      expect(legendListPropsSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ maintainScrollAtEnd: true }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("pins to the bottom when a proposed plan grows while stickiness is enabled", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const baseEntry = {
      id: "plan-entry-1",
      kind: "proposed-plan" as const,
      createdAt: "2026-04-13T12:00:00.000Z",
      proposedPlan: {
        id: "plan-1",
        turnId: null,
        planMarkdown: "# Plan\n\n- First step",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-04-13T12:00:00.000Z",
        updatedAt: "2026-04-13T12:00:00.000Z",
      },
    };

    const props = buildProps();
    const screen = await render(<MessagesTimeline {...props} timelineEntries={[baseEntry]} />);

    try {
      scrollToEndSpy.mockClear();

      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[
            {
              ...baseEntry,
              proposedPlan: {
                ...baseEntry.proposedPlan,
                planMarkdown: "# Plan\n\n- First step\n- Second streamed step",
                updatedAt: "2026-04-13T12:00:01.000Z",
              },
            },
          ]}
        />,
      );

      expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
      expect(legendListPropsSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ maintainScrollAtEnd: true }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("suppresses bottom pinning when a streaming update arrives after the viewport is scrolled upward", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const baseEntry = {
      id: "assistant-1",
      kind: "message" as const,
      createdAt: "2026-04-13T12:00:00.000Z",
      message: {
        id: MessageId.make("assistant-1"),
        role: "assistant" as const,
        text: "Initial streaming text",
        turnId: null,
        streaming: true,
        createdAt: "2026-04-13T12:00:00.000Z",
        updatedAt: "2026-04-13T12:00:00.000Z",
      },
    };

    function Harness({ text }: { text: string }) {
      const [suppressMaintainScrollAtEnd, setSuppressMaintainScrollAtEnd] = useState(false);
      return (
        <MessagesTimeline
          {...buildProps()}
          onScrollViewportChange={(viewport) => {
            if (viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 8) {
              setSuppressMaintainScrollAtEnd(false);
            }
          }}
          onUserScrollAwayFromEnd={() => setSuppressMaintainScrollAtEnd(true)}
          suppressMaintainScrollAtEnd={suppressMaintainScrollAtEnd}
          timelineEntries={[
            {
              ...baseEntry,
              message: {
                ...baseEntry.message,
                text,
              },
            },
          ]}
        />
      );
    }

    const screen = await render(<Harness text="Initial streaming text" />);

    try {
      const scrollViewport = document.querySelector<HTMLElement>(
        '[data-chat-messages-scroll="true"]',
      );
      expect(scrollViewport).not.toBeNull();
      Object.defineProperties(scrollViewport!, {
        scrollHeight: { configurable: true, value: 1_000 },
        clientHeight: { configurable: true, value: 200 },
        scrollTop: { configurable: true, writable: true, value: 600 },
      });

      scrollViewport!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
      scrollViewport!.dispatchEvent(new Event("scroll", { bubbles: true }));

      await vi.waitFor(() => {
        expect(legendListPropsSpy).toHaveBeenLastCalledWith(
          expect.objectContaining({ maintainScrollAtEnd: false }),
        );
      });

      await screen.rerender(<Harness text="Initial streaming text plus a streamed token" />);

      expect(legendListPropsSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ maintainScrollAtEnd: false }),
      );
      expect(scrollToEndSpy).not.toHaveBeenCalled();

      scrollViewport!.scrollTop = 792;
      scrollViewport!.dispatchEvent(new Event("scroll", { bubbles: true }));

      await vi.waitFor(() => {
        expect(legendListPropsSpy).toHaveBeenLastCalledWith(
          expect.objectContaining({ maintainScrollAtEnd: true }),
        );
      });
      expect(scrollToEndSpy).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps large timeline mount and streaming rerender within browser budgets", async () => {
    const timelineEntries = Array.from({ length: 800 }, (_, index) => ({
      id: `message-${index}`,
      kind: "message" as const,
      createdAt: `2026-04-13T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
      message: {
        id: MessageId.make(`message-${index}`),
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `Message ${index} ${"content ".repeat(6)}`,
        turnId: null,
        streaming: index === 799,
        createdAt: `2026-04-13T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
        updatedAt: `2026-04-13T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
      },
    }));
    const props = buildProps();

    const mountStartedAt = performance.now();
    const screen = await render(<MessagesTimeline {...props} timelineEntries={timelineEntries} />);
    expectBrowserDurationUnder(mountStartedAt, 4_000, "large timeline mount");

    try {
      const initialLegendListProps = legendListPropsSpy.mock.calls.at(-1)?.[0];
      expect(initialLegendListProps?.data).toHaveLength(800);
      const initialRenderItem = initialLegendListProps?.renderItem;
      const streamingEntries = [...timelineEntries];
      const streamingEntry = streamingEntries[799]!;
      streamingEntries[799] = {
        ...streamingEntry,
        message: {
          ...streamingEntry.message,
          text: `${streamingEntry.message.text} streamed token`,
        },
      };

      const rerenderStartedAt = performance.now();
      await screen.rerender(<MessagesTimeline {...props} timelineEntries={streamingEntries} />);
      expectBrowserDurationUnder(rerenderStartedAt, 2_000, "large timeline streaming rerender");

      const rerenderLegendListProps = legendListPropsSpy.mock.calls.at(-1)?.[0];
      expect(rerenderLegendListProps?.data).toHaveLength(800);
      expect(rerenderLegendListProps?.renderItem).toBe(initialRenderItem);
      expect(rerenderLegendListProps?.maintainScrollAtEnd).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("does not fall back to a whole-turn checkpoint diff when per-call patches are unavailable", async () => {
    const environmentId = EnvironmentId.make("environment-local");
    const threadId = ThreadId.make("thread-1");
    const turnId = TurnId.make("turn-1");
    const getTurnDiff = vi.fn();
    __setEnvironmentApiOverrideForTests(environmentId, {
      orchestration: {
        getTurnDiff,
        getFullThreadDiff: vi.fn(),
      },
    } as unknown as EnvironmentApi);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MessagesTimeline
          {...buildProps()}
          activeThreadId={threadId}
          activeThreadEnvironmentId={environmentId}
          turnDiffSummaryByTurnId={
            new Map([
              [
                turnId,
                {
                  turnId,
                  checkpointTurnCount: 2,
                  completedAt: "2026-04-13T12:00:02.000Z",
                  files: [{ path: "src/app.ts", additions: 1, deletions: 1 }],
                },
              ],
            ])
          }
          timelineEntries={[
            {
              id: "work-1",
              kind: "work",
              createdAt: "2026-04-13T12:00:00.000Z",
              entry: {
                id: "work-1",
                turnId,
                createdAt: "2026-04-13T12:00:00.000Z",
                label: "File change",
                tone: "tool",
                itemType: "file_change",
                status: "completed",
                changedFiles: ["src/app.ts"],
              },
            },
          ]}
        />
      </QueryClientProvider>,
    );

    try {
      await expect.element(page.getByTestId("inline-file-diff")).not.toBeInTheDocument();
      await expect.element(page.getByTestId("inline-diff-toggle")).not.toBeInTheDocument();
      await expect
        .element(page.getByTestId("inline-file-change-header"))
        .toHaveTextContent("src/app.ts");
      expect(getTurnDiff).not.toHaveBeenCalled();
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("keeps large inline diff rendering within browser budget and renders only the selected file", async () => {
    const environmentId = EnvironmentId.make("environment-local");
    const threadId = ThreadId.make("thread-1");
    const turnId = TurnId.make("turn-large-diff");
    const selectedPath = "src/generated/file-199.ts";
    const diff = Array.from({ length: 240 }, (_, index) =>
      [
        `diff --git a/src/generated/file-${String(index).padStart(3, "0")}.ts b/src/generated/file-${String(index).padStart(3, "0")}.ts`,
        "index 1111111..2222222 100644",
        `--- a/src/generated/file-${String(index).padStart(3, "0")}.ts`,
        `+++ b/src/generated/file-${String(index).padStart(3, "0")}.ts`,
        "@@ -1 +1 @@",
        `-old-${index}`,
        `+new-${index}`,
      ].join("\n"),
    ).join("\n");
    const getTurnDiff = vi.fn(async () => ({
      threadId,
      fromTurnCount: 1,
      toTurnCount: 2,
      diff,
    }));
    __setEnvironmentApiOverrideForTests(environmentId, {
      orchestration: {
        getTurnDiff,
        getFullThreadDiff: vi.fn(),
      },
    } as unknown as EnvironmentApi);
    hydrateLiveCommandOutputSnapshot(environmentId, {
      threadId,
      turnId,
      toolCallId: ProviderItemId.make("patch-large"),
      updatedAt: "2026-04-13T12:00:02.000Z",
      text: diff,
      truncated: false,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const renderStartedAt = performance.now();
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MessagesTimeline
          {...buildProps()}
          activeThreadId={threadId}
          activeThreadEnvironmentId={environmentId}
          turnDiffSummaryByTurnId={
            new Map([
              [
                turnId,
                {
                  turnId,
                  checkpointTurnCount: 2,
                  completedAt: "2026-04-13T12:00:02.000Z",
                  files: [{ path: selectedPath, additions: 1, deletions: 1 }],
                },
              ],
            ])
          }
          timelineEntries={[
            {
              id: "work-large-diff",
              kind: "work",
              createdAt: "2026-04-13T12:00:00.000Z",
              entry: {
                id: "work-large-diff",
                turnId,
                createdAt: "2026-04-13T12:00:00.000Z",
                label: "File change",
                tone: "tool",
                itemType: "file_change",
                status: "completed",
                toolCallId: "patch-large",
                changedFiles: [selectedPath],
              },
            },
          ]}
        />
      </QueryClientProvider>,
    );

    try {
      await expect.element(page.getByTestId("inline-file-diff")).toHaveTextContent(selectedPath);
      expectBrowserDurationUnder(renderStartedAt, 5_000, "large inline diff render");
      await expect.element(page.getByText("src/generated/file-000.ts")).not.toBeInTheDocument();
      expect(getTurnDiff).not.toHaveBeenCalled();
      await expect.element(page.getByTestId("inline-diff-toggle")).not.toBeInTheDocument();
      await expect.element(page.getByLabelText("Expand inline file diff")).toBeInTheDocument();
      await page.getByTestId("inline-file-diff-counter").click();
      await expect.element(page.getByLabelText("Collapse inline file diff")).toBeInTheDocument();
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });

  it("expands completed same-file changes from separate per-tool buffers", async () => {
    const environmentId = EnvironmentId.make("environment-local");
    const threadId = ThreadId.make("thread-1");
    hydrateLiveCommandOutputSnapshot(environmentId, {
      threadId,
      turnId: TurnId.make("turn-1"),
      toolCallId: ProviderItemId.make("patch-1"),
      updatedAt: "2026-04-13T12:00:01.000Z",
      text: "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+first\n",
      truncated: false,
    });
    hydrateLiveCommandOutputSnapshot(environmentId, {
      threadId,
      turnId: TurnId.make("turn-1"),
      toolCallId: ProviderItemId.make("patch-2"),
      updatedAt: "2026-04-13T12:00:02.000Z",
      text: "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-first\n+second\n",
      truncated: false,
    });
    const onOpenTurnDiff = vi.fn();

    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        onOpenTurnDiff={onOpenTurnDiff}
        activeThreadId={threadId}
        activeThreadEnvironmentId={environmentId}
        timelineEntries={[
          {
            id: "work-1",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-1",
              turnId: TurnId.make("turn-1"),
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "File change",
              tone: "tool",
              itemType: "file_change",
              status: "completed",
              toolCallId: "patch-1",
              changedFiles: ["src/app.ts"],
            },
          },
          {
            id: "work-2",
            kind: "work",
            createdAt: "2026-04-13T12:00:02.000Z",
            entry: {
              id: "work-2",
              turnId: TurnId.make("turn-1"),
              createdAt: "2026-04-13T12:00:02.000Z",
              label: "File change",
              tone: "tool",
              itemType: "file_change",
              status: "completed",
              toolCallId: "patch-2",
              changedFiles: ["src/app.ts"],
            },
          },
        ]}
      />,
    );

    try {
      await expect.element(page.getByText("+first")).toBeInTheDocument();
      await expect.element(page.getByText("+second")).toBeInTheDocument();
      await expect.element(page.getByTestId("inline-diff-toggle")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("normalizes completed add-file patch bodies before rendering with Pierre", async () => {
    const environmentId = EnvironmentId.make("environment-local");
    const threadId = ThreadId.make("thread-1");
    const turnId = TurnId.make("turn-add-file");
    const onOpenTurnDiff = vi.fn();
    hydrateLiveCommandOutputSnapshot(environmentId, {
      threadId,
      turnId,
      toolCallId: ProviderItemId.make("patch-add-file"),
      updatedAt: "2026-04-13T12:00:02.000Z",
      text: [
        "diff --git a/src/new.ts b/src/new.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/new.ts",
        "export const value = 1;",
        "",
        "export const other = 2;",
      ].join("\n"),
      truncated: false,
    });

    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        onOpenTurnDiff={onOpenTurnDiff}
        activeThreadId={threadId}
        activeThreadEnvironmentId={environmentId}
        timelineEntries={[
          {
            id: "work-add-file",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-add-file",
              turnId,
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "File change",
              tone: "tool",
              itemType: "file_change",
              status: "completed",
              toolCallId: "patch-add-file",
              changedFiles: ["src/new.ts"],
            },
          },
        ]}
      />,
    );

    try {
      await expect.element(page.getByTestId("inline-file-diff")).toHaveTextContent("src/new.ts");
      await expect.element(page.getByText("+export const value = 1;")).toBeInTheDocument();
      await expect.element(page.getByText("+export const other = 2;")).toBeInTheDocument();
      await page.getByRole("button", { name: "src/new.ts" }).click();
      expect(onOpenTurnDiff).toHaveBeenCalledWith(turnId, "src/new.ts");
    } finally {
      await screen.unmount();
    }
  });

  it("renders a deleted-file badge instead of an inline diff preview", async () => {
    const environmentId = EnvironmentId.make("environment-local");
    const threadId = ThreadId.make("thread-1");
    const turnId = TurnId.make("turn-delete-file");
    const onOpenTurnDiff = vi.fn();
    hydrateLiveCommandOutputSnapshot(environmentId, {
      threadId,
      turnId,
      toolCallId: ProviderItemId.make("patch-delete-file"),
      updatedAt: "2026-04-13T12:00:02.000Z",
      text: [
        "diff --git a/src/deleted.ts b/src/deleted.ts",
        "deleted file mode 100644",
        "--- a/src/deleted.ts",
        "+++ /dev/null",
        "export const value = 1;",
      ].join("\n"),
      truncated: false,
    });

    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        onOpenTurnDiff={onOpenTurnDiff}
        activeThreadId={threadId}
        activeThreadEnvironmentId={environmentId}
        timelineEntries={[
          {
            id: "work-delete-file",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-delete-file",
              turnId,
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "File change",
              tone: "tool",
              itemType: "file_change",
              status: "completed",
              toolCallId: "patch-delete-file",
              changedFiles: ["src/deleted.ts"],
            },
          },
        ]}
      />,
    );

    try {
      await expect.element(page.getByTestId("inline-file-delete-badge")).toBeVisible();
      await expect.element(page.getByText("src/deleted.ts")).toBeVisible();
      await expect.element(page.getByTestId("inline-file-diff")).not.toBeInTheDocument();
      await page.getByRole("button", { name: "Deleted src/deleted.ts" }).click();
      expect(onOpenTurnDiff).toHaveBeenCalledWith(turnId, "src/deleted.ts");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the last valid inline file diff while streamed metadata is incomplete", async () => {
    const environmentId = EnvironmentId.make("environment-local");
    const threadId = ThreadId.make("thread-1");
    const turnId = TurnId.make("turn-stable-stream");
    const toolCallId = ProviderItemId.make("patch-stable-stream");
    hydrateLiveCommandOutputSnapshot(environmentId, {
      threadId,
      turnId,
      toolCallId,
      updatedAt: "2026-04-13T12:00:01.000Z",
      text: "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+first\n",
      truncated: false,
    });

    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        activeThreadId={threadId}
        activeThreadEnvironmentId={environmentId}
        timelineEntries={[
          {
            id: "work-stable-stream",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-stable-stream",
              turnId,
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "File change",
              tone: "tool",
              itemType: "file_change",
              status: "running",
              toolCallId,
              changedFiles: ["src/app.ts"],
            },
          },
        ]}
      />,
    );

    try {
      await expect.element(page.getByText("+first")).toBeInTheDocument();

      hydrateLiveCommandOutputSnapshot(environmentId, {
        threadId,
        turnId,
        toolCallId,
        updatedAt: "2026-04-13T12:00:02.000Z",
        text: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@\n-old\n+partial\n",
        truncated: false,
      });

      await expect.element(page.getByText("+first")).toBeInTheDocument();
      await expect
        .element(page.getByText("Waiting for complete patch metadata."))
        .not.toBeInTheDocument();

      hydrateLiveCommandOutputSnapshot(environmentId, {
        threadId,
        turnId,
        toolCallId,
        updatedAt: "2026-04-13T12:00:03.000Z",
        text: "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-first\n+second\n",
        truncated: false,
      });

      await expect.element(page.getByText("+second")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
