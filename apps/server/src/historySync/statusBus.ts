import type { HistorySyncStatus } from "@t3tools/contracts";
import { Effect, PubSub, Ref } from "effect";

export const DISABLED_HISTORY_SYNC_STATUS: HistorySyncStatus = {
  state: "disabled",
  configured: false,
};

let latestHistorySyncStatus: HistorySyncStatus = DISABLED_HISTORY_SYNC_STATUS;
const historySyncStatusSubscribers = new Set<(status: HistorySyncStatus) => Effect.Effect<void>>();
let lastLoggedStatusKey: string | null = null;

function statusLogKey(status: HistorySyncStatus): string {
  if (status.state === "syncing") {
    return JSON.stringify({
      state: status.state,
      startedAt: status.startedAt,
      lane: status.lane ?? null,
      phase: status.progress?.phase ?? null,
      label: status.progress?.label ?? null,
      current: status.progress?.current ?? null,
      total: status.progress?.total ?? null,
    });
  }
  return JSON.stringify(status);
}

function logHistorySyncStatus(status: HistorySyncStatus): void {
  const key = statusLogKey(status);
  if (key === lastLoggedStatusKey) {
    return;
  }
  lastLoggedStatusKey = key;
  switch (status.state) {
    case "disabled":
      console.info("[history-sync] disabled", { configured: status.configured });
      return;
    case "needs-initial-sync":
      console.info("[history-sync] waiting for explicit initial sync", {
        configured: status.configured,
        lastSyncedAt: status.lastSyncedAt,
      });
      return;
    case "syncing":
      console.info("[history-sync] syncing", {
        startedAt: status.startedAt,
        lastSyncedAt: status.lastSyncedAt,
        lane: status.lane ?? "legacy",
        progress: status.progress ?? null,
        partial: status.partial ?? null,
      });
      return;
    case "retrying":
      console.warn("[history-sync] retrying after connection failure", {
        message: status.message,
        attempt: status.attempt,
        maxAttempts: status.maxAttempts,
        nextRetryAt: status.nextRetryAt,
        lastSyncedAt: status.lastSyncedAt,
      });
      return;
    case "idle":
      console.info("[history-sync] idle", { lastSyncedAt: status.lastSyncedAt });
      return;
    case "error":
      console.error("[history-sync] stopped after error", {
        message: status.message,
        lastSyncedAt: status.lastSyncedAt,
      });
      return;
    case "needs-project-mapping":
      console.warn("[history-sync] waiting for project mapping", {
        remoteMaxSequence: status.remoteMaxSequence,
        unresolvedProjectCount: status.unresolvedProjectCount,
        lastSyncedAt: status.lastSyncedAt,
      });
      return;
  }
}

export function readHistorySyncStatus(): HistorySyncStatus {
  return latestHistorySyncStatus;
}

export function subscribeHistorySyncStatus(
  subscriber: (status: HistorySyncStatus) => Effect.Effect<void>,
): Effect.Effect<() => void> {
  return Effect.sync(() => {
    historySyncStatusSubscribers.add(subscriber);
    return () => {
      historySyncStatusSubscribers.delete(subscriber);
    };
  });
}

export function publishHistorySyncStatus(input: {
  readonly status: HistorySyncStatus;
  readonly statusRef: Ref.Ref<HistorySyncStatus>;
  readonly statusPubSub: PubSub.PubSub<HistorySyncStatus>;
}) {
  return Effect.sync(() => {
    latestHistorySyncStatus = input.status;
    logHistorySyncStatus(input.status);
  }).pipe(
    Effect.andThen(
      Effect.all(
        [
          Ref.set(input.statusRef, input.status),
          PubSub.publish(input.statusPubSub, input.status),
          ...[...historySyncStatusSubscribers].map((subscriber) =>
            subscriber(input.status).pipe(Effect.ignore({ log: true })),
          ),
        ],
        { concurrency: "unbounded" },
      ),
    ),
    Effect.asVoid,
  );
}
