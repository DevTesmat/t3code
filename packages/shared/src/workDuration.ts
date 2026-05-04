export interface WorkDurationActivity {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly sequence?: number | undefined;
  readonly createdAt: string;
}

export function computeWorkDurationMs(input: {
  startedAt: string | null;
  completedAt: string | null;
  activities?: ReadonlyArray<WorkDurationActivity>;
}): number {
  if (input.startedAt === null || input.completedAt === null) {
    return 0;
  }
  const startedAtMs = Date.parse(input.startedAt);
  const completedAtMs = Date.parse(input.completedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)) {
    return 0;
  }
  if (completedAtMs <= startedAtMs) {
    return 0;
  }
  const pauseState = deriveUserInputPauseDurationMs(
    input.activities ?? [],
    input.startedAt,
    completedAtMs,
  );
  return Math.max(0, completedAtMs - startedAtMs - pauseState.pausedDurationMs);
}

export function deriveUserInputPauseDurationMs(
  activities: ReadonlyArray<WorkDurationActivity>,
  activeStartIso: string,
  activeEndMs: number,
): { pausedDurationMs: number; hasOpenPause: boolean } {
  const activeStartMs = Date.parse(activeStartIso);
  if (
    !Number.isFinite(activeStartMs) ||
    !Number.isFinite(activeEndMs) ||
    activeEndMs <= activeStartMs
  ) {
    return { pausedDurationMs: 0, hasOpenPause: false };
  }

  const openByRequestId = new Map<string, number>();
  const pauseIntervals: Array<{ startMs: number; endMs: number }> = [];
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  const closePauseWindow = (requestId: string, closedAtIso: string) => {
    const openedAtMs = openByRequestId.get(requestId);
    if (openedAtMs === undefined) {
      return;
    }
    openByRequestId.delete(requestId);

    const closedAtMs = Date.parse(closedAtIso);
    if (!Number.isFinite(openedAtMs) || !Number.isFinite(closedAtMs)) {
      return;
    }
    const overlapStartMs = Math.max(openedAtMs, activeStartMs);
    const overlapEndMs = Math.min(closedAtMs, activeEndMs);
    if (overlapEndMs > overlapStartMs) {
      pauseIntervals.push({ startMs: overlapStartMs, endMs: overlapEndMs });
    }
  };

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = payload && typeof payload.requestId === "string" ? payload.requestId : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "user-input.requested" && requestId) {
      openByRequestId.set(requestId, Date.parse(activity.createdAt));
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      closePauseWindow(requestId, activity.createdAt);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      closePauseWindow(requestId, activity.createdAt);
    }
  }

  for (const openedAtMs of openByRequestId.values()) {
    if (!Number.isFinite(openedAtMs)) {
      continue;
    }
    const overlapStartMs = Math.max(openedAtMs, activeStartMs);
    if (activeEndMs > overlapStartMs) {
      pauseIntervals.push({ startMs: overlapStartMs, endMs: activeEndMs });
    }
  }

  return {
    pausedDurationMs: sumMergedIntervals(pauseIntervals),
    hasOpenPause: openByRequestId.size > 0,
  };
}

function compareActivitiesByOrder(left: WorkDurationActivity, right: WorkDurationActivity): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  const lifecycleRankComparison =
    compareActivityLifecycleRank(left.kind) - compareActivityLifecycleRank(right.kind);
  if (lifecycleRankComparison !== 0) {
    return lifecycleRankComparison;
  }

  return left.id.localeCompare(right.id);
}

function compareActivityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
}

function sumMergedIntervals(intervals: ReadonlyArray<{ startMs: number; endMs: number }>): number {
  if (intervals.length === 0) {
    return 0;
  }

  const sorted = [...intervals].toSorted((left, right) => left.startMs - right.startMs);
  let total = 0;
  let current = sorted[0]!;

  for (const interval of sorted.slice(1)) {
    if (interval.startMs <= current.endMs) {
      current = {
        startMs: current.startMs,
        endMs: Math.max(current.endMs, interval.endMs),
      };
      continue;
    }
    total += current.endMs - current.startMs;
    current = interval;
  }

  total += current.endMs - current.startMs;
  return Math.max(0, total);
}

function isStalePendingRequestFailureDetail(detail: string | undefined): boolean {
  if (!detail) {
    return false;
  }
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("unknown pending user-input request") ||
    (normalized.includes("pending") &&
      (normalized.includes("not found") ||
        normalized.includes("missing") ||
        normalized.includes("no longer")))
  );
}
