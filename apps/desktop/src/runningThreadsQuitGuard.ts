import type { MessageBoxOptions } from "electron";

export interface RunningThreadsState {
  count: number;
  updatedAt: string;
}

export interface RunningThreadsQuitGuardInput {
  runningCount: number;
  quitConfirmedWithRunningThreads: boolean;
  updateInstallInFlight: boolean;
}

export function shouldPromptBeforeQuitWithRunningThreads({
  runningCount,
  quitConfirmedWithRunningThreads,
  updateInstallInFlight,
}: RunningThreadsQuitGuardInput): boolean {
  return runningCount > 0 && !quitConfirmedWithRunningThreads && !updateInstallInFlight;
}

export function createRunningThreadsQuitDialogOptions(count: number): MessageBoxOptions {
  const threadLabel = count === 1 ? "1 thread is" : `${count} threads are`;

  return {
    type: "warning",
    title: "Threads are still running",
    message: `${threadLabel} still running. Quit anyway?`,
    detail: "Quitting will close T3 Code while agent work is still in progress.",
    buttons: ["Keep Running", "Quit"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

export function normalizeRunningThreadsState(rawState: unknown): RunningThreadsState | null {
  if (typeof rawState !== "object" || rawState === null) {
    return null;
  }

  const state = rawState as { count?: unknown; updatedAt?: unknown };
  const count = state.count;
  const updatedAt = state.updatedAt;
  if (
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < 0 ||
    typeof updatedAt !== "string"
  ) {
    return null;
  }

  return {
    count,
    updatedAt,
  };
}
