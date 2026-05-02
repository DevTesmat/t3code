import "../../index.css";

import { EnvironmentId } from "@t3tools/contracts";
import { createRef } from "react";
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

import { MessagesTimeline } from "./MessagesTimeline";

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnId: null,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    completionDividerBeforeEntryId: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: vi.fn(),
    isRevertingCheckpoint: false,
    onImageExpand: vi.fn(),
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    markdownCwd: undefined,
    timestampFormat: "24-hour" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: vi.fn(),
  };
}

describe("MessagesTimeline", () => {
  afterEach(() => {
    scrollToEndSpy.mockReset();
    getStateSpy.mockClear();
    legendListPropsSpy.mockClear();
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
});
