import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  ComposerQueuedMessagesBar,
  QUEUED_MESSAGE_LIST_MAX_HEIGHT_PX,
  type ComposerQueuedMessagesBarMessage,
} from "./ComposerQueuedMessagesBar";

function message(input: {
  id: string;
  text?: string;
  attachments?: number;
  terminalContexts?: number;
}): ComposerQueuedMessagesBarMessage {
  return {
    id: input.id,
    text: input.text ?? "",
    attachments: Array.from({ length: input.attachments ?? 0 }),
    terminalContexts: Array.from({ length: input.terminalContexts ?? 0 }),
  };
}

describe("ComposerQueuedMessagesBar", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("expands and collapses queued messages inline", async () => {
    const screen = await render(
      <ComposerQueuedMessagesBar
        messages={[message({ id: "queued-1", text: "first queued prompt" })]}
        onDeleteMessage={vi.fn()}
      />,
    );

    try {
      const toggle = page.getByRole("button", { name: /Queued messages \(1\)/ });
      await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
      await expect.element(page.getByText("first queued prompt")).not.toBeInTheDocument();

      await toggle.click();

      await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
      await expect.element(page.getByText("first queued prompt")).toBeVisible();

      await toggle.click();

      await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
      await expect.element(page.getByText("first queued prompt")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("calls onDeleteMessage with the selected message id", async () => {
    const onDeleteMessage = vi.fn();
    const screen = await render(
      <ComposerQueuedMessagesBar
        messages={[message({ id: "queued-1", text: "delete me" })]}
        onDeleteMessage={onDeleteMessage}
      />,
    );

    try {
      await page.getByRole("button", { name: /Queued messages \(1\)/ }).click();
      await page.getByRole("button", { name: /Delete queued message: delete me/ }).click();
      expect(onDeleteMessage).toHaveBeenCalledWith("queued-1");
    } finally {
      await screen.unmount();
    }
  });

  it("shows text previews in queue order", async () => {
    const screen = await render(
      <ComposerQueuedMessagesBar
        messages={[
          message({ id: "queued-1", text: "first queued prompt" }),
          message({ id: "queued-2", text: "second queued prompt" }),
        ]}
        onDeleteMessage={vi.fn()}
      />,
    );

    try {
      await page.getByRole("button", { name: /Queued messages \(2\)/ }).click();

      const rows = Array.from(
        document.querySelectorAll<HTMLElement>("[data-composer-queued-message-row='true']"),
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]!.textContent).toContain("first queued prompt");
      expect(rows[1]!.textContent).toContain("second queued prompt");
    } finally {
      await screen.unmount();
    }
  });

  it("shows image-only fallback and metadata chips", async () => {
    const screen = await render(
      <ComposerQueuedMessagesBar
        messages={[message({ id: "queued-1", attachments: 2, terminalContexts: 1 })]}
        onDeleteMessage={vi.fn()}
      />,
    );

    try {
      await page.getByRole("button", { name: /Queued messages \(1\)/ }).click();
      await expect.element(page.getByText("Image-only queued message")).toBeVisible();
      await expect.element(page.getByText("2 images")).toBeVisible();
      await expect.element(page.getByText("1 terminal")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("caps the expanded list at four rows and scrolls it independently", async () => {
    const screen = await render(
      <ComposerQueuedMessagesBar
        messages={Array.from({ length: 8 }, (_, index) =>
          message({ id: `queued-${index}`, text: `queued prompt ${index}` }),
        )}
        onDeleteMessage={vi.fn()}
      />,
    );

    try {
      await page.getByRole("button", { name: /Queued messages \(8\)/ }).click();
      await expect.element(page.getByText("queued prompt 0")).toBeVisible();

      const scrollContainer = document.querySelector<HTMLElement>(
        "[data-composer-queued-messages-scroll='true']",
      );
      expect(scrollContainer).not.toBeNull();
      expect(scrollContainer!.style.maxHeight).toBe(`${QUEUED_MESSAGE_LIST_MAX_HEIGHT_PX}px`);
      expect(scrollContainer!.clientHeight).toBeLessThanOrEqual(QUEUED_MESSAGE_LIST_MAX_HEIGHT_PX);
      expect(scrollContainer!.scrollHeight).toBeGreaterThan(scrollContainer!.clientHeight);
    } finally {
      await screen.unmount();
    }
  });

  it("auto-collapses only when the queue becomes empty", async () => {
    const screen = await render(
      <ComposerQueuedMessagesBar
        messages={[message({ id: "queued-1", text: "first queued prompt" })]}
        onDeleteMessage={vi.fn()}
      />,
    );

    try {
      const toggle = page.getByRole("button", { name: /Queued messages \(1\)/ });
      await toggle.click();
      await expect.element(toggle).toHaveAttribute("aria-expanded", "true");

      await screen.rerender(
        <ComposerQueuedMessagesBar
          messages={[
            message({ id: "queued-1", text: "first queued prompt" }),
            message({ id: "queued-2", text: "second queued prompt" }),
          ]}
          onDeleteMessage={vi.fn()}
        />,
      );
      await expect
        .element(page.getByRole("button", { name: /Queued messages \(2\)/ }))
        .toHaveAttribute("aria-expanded", "true");

      await screen.rerender(<ComposerQueuedMessagesBar messages={[]} onDeleteMessage={vi.fn()} />);
      await expect.element(page.getByText(/Queued messages/)).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
