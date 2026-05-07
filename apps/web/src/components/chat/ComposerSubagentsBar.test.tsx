import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerSubagentsBar } from "./ComposerSubagentsBar";
import type { ThreadSubagent } from "../../session-logic";

function makeSubagent(overrides: Partial<ThreadSubagent> = {}): ThreadSubagent {
  return {
    threadId: "child-thread-1",
    createdAt: "2026-05-05T12:00:00.000Z",
    updatedAt: "2026-05-05T12:00:00.000Z",
    status: "running",
    running: true,
    ...overrides,
  };
}

describe("ComposerSubagentsBar", () => {
  it("renders nothing for an empty subagent list", () => {
    const markup = renderToStaticMarkup(<ComposerSubagentsBar subagents={[]} />);

    expect(markup).toBe("");
  });

  it("renders a collapsed header with total and running counts", () => {
    const markup = renderToStaticMarkup(
      <ComposerSubagentsBar
        subagents={[
          makeSubagent({ threadId: "child-thread-1", nickname: "Explorer" }),
          makeSubagent({
            threadId: "child-thread-2",
            status: "completed",
            running: false,
            role: "worker",
          }),
        ]}
      />,
    );

    expect(markup).toContain("Subagents (2, 1 running)");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Explorer");
    expect(markup).not.toContain("worker");
  });
});
