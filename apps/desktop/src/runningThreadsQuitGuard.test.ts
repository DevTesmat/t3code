import { describe, expect, it } from "vitest";

import {
  createRunningThreadsQuitDialogOptions,
  normalizeRunningThreadsState,
  shouldPromptBeforeQuitWithRunningThreads,
} from "./runningThreadsQuitGuard.ts";

describe("running threads quit guard", () => {
  it("allows close when no threads are running", () => {
    expect(
      shouldPromptBeforeQuitWithRunningThreads({
        runningCount: 0,
        quitConfirmedWithRunningThreads: false,
        updateInstallInFlight: false,
      }),
    ).toBe(false);
  });

  it("blocks close and uses singular copy for one running thread", () => {
    expect(
      shouldPromptBeforeQuitWithRunningThreads({
        runningCount: 1,
        quitConfirmedWithRunningThreads: false,
        updateInstallInFlight: false,
      }),
    ).toBe(true);
    expect(createRunningThreadsQuitDialogOptions(1)).toMatchObject({
      title: "Threads are still running",
      message: "1 thread is still running. Quit anyway?",
      detail: "Quitting will close T3 Code while agent work is still in progress.",
      buttons: ["Keep Running", "Quit"],
      defaultId: 0,
      cancelId: 0,
    });
  });

  it("blocks close and uses plural copy for multiple running threads", () => {
    expect(
      shouldPromptBeforeQuitWithRunningThreads({
        runningCount: 3,
        quitConfirmedWithRunningThreads: false,
        updateInstallInFlight: false,
      }),
    ).toBe(true);
    expect(createRunningThreadsQuitDialogOptions(3).message).toBe(
      "3 threads are still running. Quit anyway?",
    );
  });

  it("allows close after the user confirms quit", () => {
    expect(
      shouldPromptBeforeQuitWithRunningThreads({
        runningCount: 1,
        quitConfirmedWithRunningThreads: true,
        updateInstallInFlight: false,
      }),
    ).toBe(false);
  });

  it("bypasses prompts during updater install quit", () => {
    expect(
      shouldPromptBeforeQuitWithRunningThreads({
        runningCount: 1,
        quitConfirmedWithRunningThreads: false,
        updateInstallInFlight: true,
      }),
    ).toBe(false);
  });

  it("normalizes only valid renderer snapshots", () => {
    expect(
      normalizeRunningThreadsState({ count: 2, updatedAt: "2026-05-01T00:00:00.000Z" }),
    ).toEqual({
      count: 2,
      updatedAt: "2026-05-01T00:00:00.000Z",
    });
    expect(normalizeRunningThreadsState({ count: -1, updatedAt: "" })).toBeNull();
    expect(normalizeRunningThreadsState({ count: 1.5, updatedAt: "" })).toBeNull();
    expect(normalizeRunningThreadsState({ count: 1, updatedAt: null })).toBeNull();
  });
});
