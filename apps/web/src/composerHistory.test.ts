import { describe, expect, it } from "vitest";

import {
  navigateComposerHistory,
  userPromptHistoryFromMessages,
  type ComposerHistoryNavigationState,
} from "./composerHistory";

const entries = [
  { id: "first", text: "first prompt" },
  { id: "second", text: "second prompt" },
  { id: "third", text: "third prompt" },
];

describe("composerHistory", () => {
  it("does nothing without user prompt history", () => {
    expect(
      navigateComposerHistory({
        currentPrompt: "",
        direction: "previous",
        entries: [],
        state: null,
      }),
    ).toBeNull();
  });

  it("walks previous from newest to oldest", () => {
    const first = navigateComposerHistory({
      currentPrompt: "",
      direction: "previous",
      entries,
      state: null,
    });
    expect(first?.prompt).toBe("third prompt");

    const second = navigateComposerHistory({
      currentPrompt: first!.prompt,
      direction: "previous",
      entries,
      state: first!.state,
    });
    expect(second?.prompt).toBe("second prompt");

    const third = navigateComposerHistory({
      currentPrompt: second!.prompt,
      direction: "previous",
      entries,
      state: second!.state,
    });
    expect(third?.prompt).toBe("first prompt");

    const clamped = navigateComposerHistory({
      currentPrompt: third!.prompt,
      direction: "previous",
      entries,
      state: third!.state,
    });
    expect(clamped?.prompt).toBe("first prompt");
  });

  it("walks next and restores the baseline prompt after newest history entry", () => {
    const previousState: ComposerHistoryNavigationState = {
      baselinePrompt: "",
      selectedEntryId: "first",
    };

    const second = navigateComposerHistory({
      currentPrompt: "first prompt",
      direction: "next",
      entries,
      state: previousState,
    });
    expect(second?.prompt).toBe("second prompt");

    const third = navigateComposerHistory({
      currentPrompt: second!.prompt,
      direction: "next",
      entries,
      state: second!.state,
    });
    expect(third?.prompt).toBe("third prompt");

    const restored = navigateComposerHistory({
      currentPrompt: third!.prompt,
      direction: "next",
      entries,
      state: third!.state,
    });
    expect(restored).toEqual({ prompt: "", state: null });
  });

  it("restores a non-empty baseline prompt", () => {
    const first = navigateComposerHistory({
      currentPrompt: "draft in progress",
      direction: "previous",
      entries,
      state: null,
    });
    const restored = navigateComposerHistory({
      currentPrompt: first!.prompt,
      direction: "next",
      entries,
      state: first!.state,
    });

    expect(restored).toEqual({ prompt: "draft in progress", state: null });
  });

  it("treats a reset state as a new navigation session after manual edits or thread changes", () => {
    const first = navigateComposerHistory({
      currentPrompt: "",
      direction: "previous",
      entries,
      state: null,
    });
    expect(first?.prompt).toBe("third prompt");

    const restarted = navigateComposerHistory({
      currentPrompt: "manual edit",
      direction: "previous",
      entries,
      state: null,
    });

    expect(restarted?.prompt).toBe("third prompt");
    expect(restarted?.state?.baselinePrompt).toBe("manual edit");
  });

  it("extracts non-empty user messages without deduplicating repeated prompts", () => {
    expect(
      userPromptHistoryFromMessages([
        { id: "system", role: "system", text: "ignored" },
        { id: "user-empty", role: "user", text: "   " },
        { id: "user-1", role: "user", text: "repeat" },
        { id: "assistant", role: "assistant", text: "ignored" },
        { id: "user-2", role: "user", text: "repeat" },
      ]),
    ).toEqual([
      { id: "user-1", text: "repeat" },
      { id: "user-2", text: "repeat" },
    ]);
  });

  it("excludes non-user and legacy plan implementation prompts from user history", () => {
    expect(
      userPromptHistoryFromMessages([
        {
          id: "harness-plan",
          role: "user",
          source: "harness",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Ship it",
        },
        {
          id: "recovery",
          role: "user",
          source: "recovery",
          text: "The previous runtime session was interrupted.",
        },
        {
          id: "legacy-plan",
          role: "user",
          text: "  PLEASE IMPLEMENT THIS PLAN:\n# Ship it",
        },
        { id: "legacy-user", role: "user", text: "normal legacy prompt" },
        { id: "current-user", role: "user", source: "user", text: "normal prompt" },
      ]),
    ).toEqual([
      { id: "legacy-user", text: "normal legacy prompt" },
      { id: "current-user", text: "normal prompt" },
    ]);
  });
});
