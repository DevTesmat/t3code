import { selectThreadsAcrossEnvironments, useStore, type AppState } from "./store";
import type { Thread } from "./types";

export function isThreadRunning(thread: Pick<Thread, "session" | "latestTurn">): boolean {
  return (
    thread.session?.status === "running" ||
    thread.session?.orchestrationStatus === "running" ||
    thread.latestTurn?.state === "running"
  );
}

export function countRunningThreads(threads: readonly Pick<Thread, "session" | "latestTurn">[]) {
  return threads.filter(isThreadRunning).length;
}

export function selectRunningThreadCount(state: AppState): number {
  return countRunningThreads(selectThreadsAcrossEnvironments(state));
}

function publishRunningThreadCount(count: number): void {
  const bridge = window.desktopBridge;
  if (!bridge?.setRunningThreadsState) {
    return;
  }

  void bridge
    .setRunningThreadsState({
      count,
      updatedAt: new Date().toISOString(),
    })
    .catch(() => undefined);
}

export function startRunningThreadsStatePublisher(): () => void {
  if (typeof window === "undefined" || !window.desktopBridge?.setRunningThreadsState) {
    return () => undefined;
  }

  let lastPublishedCount: number | null = null;
  const publishIfChanged = (state: AppState) => {
    const count = selectRunningThreadCount(state);
    if (count === lastPublishedCount) {
      return;
    }

    lastPublishedCount = count;
    publishRunningThreadCount(count);
  };

  publishIfChanged(useStore.getState());
  return useStore.subscribe(publishIfChanged);
}
