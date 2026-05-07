import { TurnId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ComposerChangedFilesBar } from "./ComposerChangedFilesBar";
import type { TurnDiffSummary } from "../../types";

const turnId = TurnId.make("turn-1");

function buildSummary(files: TurnDiffSummary["files"]): TurnDiffSummary {
  return {
    turnId,
    completedAt: "2026-05-01T12:00:00.000Z",
    files,
  };
}

describe("ComposerChangedFilesBar", () => {
  it("renders nothing when the turn summary is null", () => {
    const markup = renderToStaticMarkup(
      <ComposerChangedFilesBar turnSummary={null} resolvedTheme="light" onOpenTurnDiff={vi.fn()} />,
    );

    expect(markup).toBe("");
  });

  it("renders nothing when the turn summary has no files", () => {
    const markup = renderToStaticMarkup(
      <ComposerChangedFilesBar
        turnSummary={buildSummary([])}
        resolvedTheme="light"
        onOpenTurnDiff={vi.fn()}
      />,
    );

    expect(markup).toBe("");
  });

  it("renders a collapsed one-line header by default", () => {
    const markup = renderToStaticMarkup(
      <ComposerChangedFilesBar
        turnSummary={buildSummary([
          { path: "apps/web/src/ChatView.tsx", additions: 4, deletions: 1 },
          { path: "apps/web/src/components/chat/MessagesTimeline.tsx", additions: 2, deletions: 0 },
        ])}
        resolvedTheme="light"
        onOpenTurnDiff={vi.fn()}
      />,
    );

    expect(markup).toContain("Changed files (2)");
    expect(markup).toContain("+6");
    expect(markup).toContain("-1");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("ChatView.tsx");
    expect(markup).not.toContain("MessagesTimeline.tsx");
  });
});
