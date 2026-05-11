export interface WorkerHealthSnapshot {
  readonly capacity: number | null;
  readonly backlog: number;
  readonly queued: number;
  readonly active: number;
  readonly oldestItemAgeMs: number | null;
  readonly attempted: number;
  readonly accepted: number;
  readonly processed: number;
  readonly failed: number;
  readonly dropped: number;
  readonly coalesced: number;
}

export const emptyWorkerHealthSnapshot = (): WorkerHealthSnapshot => ({
  capacity: null,
  backlog: 0,
  queued: 0,
  active: 0,
  oldestItemAgeMs: null,
  attempted: 0,
  accepted: 0,
  processed: 0,
  failed: 0,
  dropped: 0,
  coalesced: 0,
});
