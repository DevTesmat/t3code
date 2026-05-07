export type ComposerHistoryDirection = "previous" | "next";

export interface ComposerHistoryEntry {
  id: string;
  text: string;
}

export interface ComposerHistoryNavigationState {
  baselinePrompt: string;
  selectedEntryId: string;
}

export interface ComposerHistoryNavigationResult {
  prompt: string;
  state: ComposerHistoryNavigationState | null;
}

export function userPromptHistoryFromMessages(
  messages: ReadonlyArray<{ id: string; role: string; text: string }>,
): ComposerHistoryEntry[] {
  return messages.flatMap((message) => {
    if (message.role !== "user") return [];
    if (message.text.trim().length === 0) return [];
    return [{ id: message.id, text: message.text }];
  });
}

export function navigateComposerHistory(input: {
  currentPrompt: string;
  direction: ComposerHistoryDirection;
  entries: ReadonlyArray<ComposerHistoryEntry>;
  state: ComposerHistoryNavigationState | null;
}): ComposerHistoryNavigationResult | null {
  const entries = input.entries;
  if (entries.length === 0) return null;

  if (!input.state) {
    if (input.direction === "next") return null;
    const selectedEntry = entries[entries.length - 1];
    if (!selectedEntry) return null;
    return {
      prompt: selectedEntry.text,
      state: {
        baselinePrompt: input.currentPrompt,
        selectedEntryId: selectedEntry.id,
      },
    };
  }

  const selectedIndex = entries.findIndex((entry) => entry.id === input.state?.selectedEntryId);
  const normalizedIndex = selectedIndex >= 0 ? selectedIndex : entries.length - 1;

  if (input.direction === "previous") {
    const previousEntry = entries[Math.max(0, normalizedIndex - 1)];
    if (!previousEntry) return null;
    return {
      prompt: previousEntry.text,
      state: {
        baselinePrompt: input.state.baselinePrompt,
        selectedEntryId: previousEntry.id,
      },
    };
  }

  const nextEntry = entries[normalizedIndex + 1];
  if (!nextEntry) {
    return {
      prompt: input.state.baselinePrompt,
      state: null,
    };
  }

  return {
    prompt: nextEntry.text,
    state: {
      baselinePrompt: input.state.baselinePrompt,
      selectedEntryId: nextEntry.id,
    },
  };
}
