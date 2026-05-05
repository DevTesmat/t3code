export type PowerSaveBlockerType = "prevent-display-sleep";

export interface PowerSaveBlockerLike {
  start: (type: PowerSaveBlockerType) => number;
  stop: (id: number) => void;
  isStarted: (id: number) => boolean;
}

export interface RunningThreadsPowerSaveBlocker {
  syncRunningThreadCount: (count: number) => void;
  release: () => void;
  getBlockerId: () => number | null;
}

export function createRunningThreadsPowerSaveBlocker(
  powerSaveBlocker: PowerSaveBlockerLike,
): RunningThreadsPowerSaveBlocker {
  let blockerId: number | null = null;

  const release = () => {
    const currentBlockerId = blockerId;
    blockerId = null;

    if (currentBlockerId === null) {
      return;
    }

    if (powerSaveBlocker.isStarted(currentBlockerId)) {
      powerSaveBlocker.stop(currentBlockerId);
    }
  };

  const syncRunningThreadCount = (count: number) => {
    if (count <= 0) {
      release();
      return;
    }

    if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
      return;
    }

    blockerId = powerSaveBlocker.start("prevent-display-sleep");
  };

  return {
    syncRunningThreadCount,
    release,
    getBlockerId: () => blockerId,
  };
}
