import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ComposerQueuedMessagesBar } from "./ComposerQueuedMessagesBar";

describe("ComposerQueuedMessagesBar", () => {
  it("renders nothing for an empty queue", () => {
    const markup = renderToStaticMarkup(
      <ComposerQueuedMessagesBar messages={[]} onDeleteMessage={vi.fn()} />,
    );

    expect(markup).toBe("");
  });

  it("renders a collapsed header with the queued message count", () => {
    const markup = renderToStaticMarkup(
      <ComposerQueuedMessagesBar
        messages={[
          { id: "queued-1", text: "first", attachments: [], terminalContexts: [] },
          { id: "queued-2", text: "second", attachments: [], terminalContexts: [] },
        ]}
        onDeleteMessage={vi.fn()}
      />,
    );

    expect(markup).toContain("Queued messages (2)");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("first");
    expect(markup).not.toContain("second");
  });
});
