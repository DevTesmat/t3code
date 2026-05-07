import {
  ProviderDriverKind,
  type ModelSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { TraitsPicker } from "./TraitsPicker";

const CODEX_PROVIDER = ProviderDriverKind.make("codex");

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  promptInjectedValues?: ReadonlyArray<string>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
    ...(promptInjectedValues && promptInjectedValues.length > 0
      ? { promptInjectedValues: [...promptInjectedValues] }
      : {}),
  };
}

function booleanDescriptor(id: string, label: string) {
  return {
    id,
    label,
    type: "boolean" as const,
  };
}

const MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5.4",
    name: "GPT-5 Codex",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        selectDescriptor(
          "reasoningEffort",
          "Reasoning",
          [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
            { id: "xhigh", label: "Xhigh" },
            { id: "ultrathink", label: "Ultrathink" },
          ],
          ["ultrathink"],
        ),
        booleanDescriptor("fastMode", "Fast Mode"),
      ],
    }),
  },
];

async function mountTraitsPicker(props?: {
  modelOptions?: ModelSelection["options"];
  prompt?: string;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <TraitsPicker
      provider={CODEX_PROVIDER}
      models={MODELS}
      model="gpt-5.4"
      prompt={props?.prompt ?? ""}
      modelOptions={props?.modelOptions}
      onPromptChange={vi.fn()}
      onModelOptionsChange={vi.fn()}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return { cleanup, host };
}

function getPill(label: string): HTMLElement {
  const match = Array.from(document.querySelectorAll<HTMLElement>("[data-tone]")).find(
    (element) => element.textContent === label,
  );
  expect(match).toBeDefined();
  return match!;
}

function getFastIconPill(host: HTMLElement): HTMLElement {
  const match = host.querySelector<HTMLElement>('[data-tone="fast"][aria-label="Fast mode"]');
  expect(match).not.toBeNull();
  return match!;
}

function getTriggerText(host: HTMLElement): string {
  return host.querySelector("button")?.textContent ?? "";
}

describe("TraitsPicker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not show Normal when fast mode is disabled", async () => {
    const mounted = await mountTraitsPicker({
      modelOptions: [
        { id: "reasoningEffort", value: "medium" },
        { id: "fastMode", value: false },
      ],
    });

    try {
      await vi.waitFor(() => {
        expect(getTriggerText(mounted.host)).toContain("Medium");
        expect(getTriggerText(mounted.host)).not.toContain("Normal");
      });
      expect(getPill("Medium").dataset.tone).toBe("medium");
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a Fast pill only when fast mode is active", async () => {
    const mounted = await mountTraitsPicker({
      modelOptions: [
        { id: "reasoningEffort", value: "low" },
        { id: "fastMode", value: true },
      ],
    });

    try {
      await vi.waitFor(() => {
        expect(getTriggerText(mounted.host)).toContain("Low");
        expect(getTriggerText(mounted.host)).not.toContain("Fast");
      });
      expect(getPill("Low").dataset.tone).toBe("low");
      const fastPill = getFastIconPill(mounted.host);
      expect(fastPill.dataset.tone).toBe("fast");
      expect(fastPill.textContent).toBe("");
    } finally {
      await mounted.cleanup();
    }
  });

  it("colors high and highest reasoning levels distinctly", async () => {
    const mounted = await mountTraitsPicker({
      modelOptions: [{ id: "reasoningEffort", value: "xhigh" }],
    });

    try {
      await vi.waitFor(() => {
        expect(getTriggerText(mounted.host)).toContain("Xhigh");
      });
      expect(getPill("Xhigh").dataset.tone).toBe("highest");
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps prompt-controlled Ultrathink visible with the highest tone", async () => {
    const mounted = await mountTraitsPicker({
      prompt: "Ultrathink:\nReview this carefully",
      modelOptions: [{ id: "reasoningEffort", value: "medium" }],
    });

    try {
      await vi.waitFor(() => {
        expect(getTriggerText(mounted.host)).toContain("Ultrathink");
      });
      expect(getPill("Ultrathink").dataset.tone).toBe("highest");
    } finally {
      await mounted.cleanup();
    }
  });
});
