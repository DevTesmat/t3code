import "../../index.css";

import { TurnId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerChangedFilesBar } from "./ComposerChangedFilesBar";
import type { TurnDiffSummary } from "../../types";

function buildSummary(input: {
  turnId: string;
  files?: TurnDiffSummary["files"];
}): TurnDiffSummary {
  return {
    turnId: TurnId.make(input.turnId),
    completedAt: "2026-05-01T12:00:00.000Z",
    files: input.files ?? [
      { path: "apps/web/src/ChatView.tsx", additions: 4, deletions: 1 },
      { path: "apps/web/src/components/chat/MessagesTimeline.tsx", additions: 2, deletions: 0 },
    ],
  };
}

describe("ComposerChangedFilesBar", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("expands changed files inline", async () => {
    const screen = await render(
      <ComposerChangedFilesBar
        turnSummary={buildSummary({ turnId: "turn-1" })}
        resolvedTheme="light"
        onOpenTurnDiff={vi.fn()}
      />,
    );

    try {
      const toggle = page.getByRole("button", { name: /Changed files \(2\)/ });
      await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
      await expect.element(page.getByText("ChatView.tsx")).not.toBeInTheDocument();

      await toggle.click();

      await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
      await expect.element(page.getByText("ChatView.tsx")).toBeVisible();
      await expect.element(page.getByText("MessagesTimeline.tsx")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("opens the diff for the first file from the header action", async () => {
    const onOpenTurnDiff = vi.fn();
    const summary = buildSummary({ turnId: "turn-1" });
    const screen = await render(
      <ComposerChangedFilesBar
        turnSummary={summary}
        resolvedTheme="light"
        onOpenTurnDiff={onOpenTurnDiff}
      />,
    );

    try {
      await page.getByRole("button", { name: "View diff" }).click();
      expect(onOpenTurnDiff).toHaveBeenCalledWith(summary.turnId, "apps/web/src/ChatView.tsx");
    } finally {
      await screen.unmount();
    }
  });

  it("opens the diff for a clicked file in the expanded tree", async () => {
    const onOpenTurnDiff = vi.fn();
    const summary = buildSummary({ turnId: "turn-1" });
    const screen = await render(
      <ComposerChangedFilesBar
        turnSummary={summary}
        resolvedTheme="light"
        onOpenTurnDiff={onOpenTurnDiff}
      />,
    );

    try {
      await page.getByRole("button", { name: /Changed files \(2\)/ }).click();
      await page.getByText("MessagesTimeline.tsx").click();
      expect(onOpenTurnDiff).toHaveBeenCalledWith(
        summary.turnId,
        "apps/web/src/components/chat/MessagesTimeline.tsx",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("resets to collapsed when the displayed turn changes", async () => {
    const screen = await render(
      <ComposerChangedFilesBar
        turnSummary={buildSummary({ turnId: "turn-1" })}
        resolvedTheme="light"
        onOpenTurnDiff={vi.fn()}
      />,
    );

    try {
      const toggle = page.getByRole("button", { name: /Changed files \(2\)/ });
      await toggle.click();
      await expect.element(toggle).toHaveAttribute("aria-expanded", "true");

      await screen.rerender(
        <ComposerChangedFilesBar
          turnSummary={buildSummary({
            turnId: "turn-2",
            files: [{ path: "apps/web/src/components/chat/ComposerChangedFilesBar.tsx" }],
          })}
          resolvedTheme="light"
          onOpenTurnDiff={vi.fn()}
        />,
      );

      const nextToggle = page.getByRole("button", { name: /Changed files \(1\)/ });
      await expect.element(nextToggle).toHaveAttribute("aria-expanded", "false");
      await expect.element(page.getByText("ComposerChangedFilesBar.tsx")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("caps the expanded tree and scrolls it independently", async () => {
    const files = Array.from({ length: 40 }, (_, index) => ({
      path: `apps/web/src/generated/file-${String(index).padStart(2, "0")}.tsx`,
      additions: 1,
      deletions: 0,
    }));
    const screen = await render(
      <ComposerChangedFilesBar
        turnSummary={buildSummary({ turnId: "turn-1", files })}
        resolvedTheme="light"
        onOpenTurnDiff={vi.fn()}
        maxExpandedHeightPx={160}
      />,
    );

    try {
      await page.getByRole("button", { name: /Changed files \(40\)/ }).click();
      await expect.element(page.getByText("file-00.tsx")).toBeVisible();

      const scrollContainer = document.querySelector<HTMLElement>(
        "[data-composer-changed-files-scroll='true']",
      );
      expect(scrollContainer).not.toBeNull();
      expect(scrollContainer!.clientHeight).toBeLessThanOrEqual(160);
      expect(scrollContainer!.scrollHeight).toBeGreaterThan(scrollContainer!.clientHeight);

      scrollContainer!.scrollTop = scrollContainer!.scrollHeight;
      expect(scrollContainer!.scrollTop).toBeGreaterThan(0);
    } finally {
      await screen.unmount();
    }
  });
});
