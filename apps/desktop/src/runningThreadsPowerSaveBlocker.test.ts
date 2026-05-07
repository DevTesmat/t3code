import { describe, expect, it, vi } from "vitest";

import {
  createRunningThreadsPowerSaveBlocker,
  type PowerSaveBlockerLike,
} from "./runningThreadsPowerSaveBlocker.ts";

function createMockPowerSaveBlocker() {
  const activeIds = new Set<number>();
  let nextId = 1;

  const blocker: PowerSaveBlockerLike = {
    start: vi.fn(() => {
      const id = nextId;
      nextId += 1;
      activeIds.add(id);
      return id;
    }),
    stop: vi.fn((id: number) => {
      activeIds.delete(id);
    }),
    isStarted: vi.fn((id: number) => activeIds.has(id)),
  };

  return {
    blocker,
    activeIds,
  };
}

describe("running threads power save blocker", () => {
  it("starts display sleep prevention when threads become active", () => {
    const { blocker } = createMockPowerSaveBlocker();
    const runningThreadsBlocker = createRunningThreadsPowerSaveBlocker(blocker);

    runningThreadsBlocker.syncRunningThreadCount(1);

    expect(blocker.start).toHaveBeenCalledOnce();
    expect(blocker.start).toHaveBeenCalledWith("prevent-display-sleep");
    expect(runningThreadsBlocker.getBlockerId()).toBe(1);
  });

  it("does not start repeatedly while an active blocker already exists", () => {
    const { blocker } = createMockPowerSaveBlocker();
    const runningThreadsBlocker = createRunningThreadsPowerSaveBlocker(blocker);

    runningThreadsBlocker.syncRunningThreadCount(1);
    runningThreadsBlocker.syncRunningThreadCount(2);

    expect(blocker.start).toHaveBeenCalledOnce();
    expect(runningThreadsBlocker.getBlockerId()).toBe(1);
  });

  it("stops display sleep prevention when no threads are running", () => {
    const { blocker } = createMockPowerSaveBlocker();
    const runningThreadsBlocker = createRunningThreadsPowerSaveBlocker(blocker);

    runningThreadsBlocker.syncRunningThreadCount(1);
    runningThreadsBlocker.syncRunningThreadCount(0);

    expect(blocker.stop).toHaveBeenCalledOnce();
    expect(blocker.stop).toHaveBeenCalledWith(1);
    expect(runningThreadsBlocker.getBlockerId()).toBeNull();
  });

  it("starts a fresh blocker when the previous id is stale", () => {
    const { blocker, activeIds } = createMockPowerSaveBlocker();
    const runningThreadsBlocker = createRunningThreadsPowerSaveBlocker(blocker);

    runningThreadsBlocker.syncRunningThreadCount(1);
    activeIds.clear();
    runningThreadsBlocker.syncRunningThreadCount(1);

    expect(blocker.start).toHaveBeenCalledTimes(2);
    expect(blocker.stop).not.toHaveBeenCalled();
    expect(runningThreadsBlocker.getBlockerId()).toBe(2);
  });

  it("ignores stale blocker ids when releasing", () => {
    const { blocker, activeIds } = createMockPowerSaveBlocker();
    const runningThreadsBlocker = createRunningThreadsPowerSaveBlocker(blocker);

    runningThreadsBlocker.syncRunningThreadCount(1);
    activeIds.clear();
    runningThreadsBlocker.release();

    expect(blocker.stop).not.toHaveBeenCalled();
    expect(runningThreadsBlocker.getBlockerId()).toBeNull();
  });
});
