import type { EnvironmentId, OrchestrationThreadShell } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";

import { hasUnseenTimestamp } from "./components/Sidebar.logic";
import { useUiStateStore } from "./uiStateStore";

type ThreadNotificationState = {
  doneNotifiedAt: string | null;
  pendingInputNotifiedAt: string | null;
};

const notificationStateByThreadKey = new Map<string, ThreadNotificationState>();

let chimeAudio: HTMLAudioElement | null = null;

function playThreadNotificationChime(): void {
  if (typeof Audio === "undefined") {
    return;
  }

  chimeAudio ??= new Audio(
    "data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YRAAAAAAACI/UW9xb1E/IgAA3MDH0ODgx8DcAA==",
  );
  chimeAudio.currentTime = 0;
  void chimeAudio.play().catch(() => undefined);
}

function deriveUnseenNotificationTimestamps(input: {
  readonly thread: OrchestrationThreadShell;
  readonly lastVisitedAt: string | undefined;
}): {
  readonly doneAt: string | null;
  readonly pendingInputAt: string | null;
} {
  const doneAt = hasUnseenTimestamp(input.thread.latestTurn?.completedAt, input.lastVisitedAt)
    ? (input.thread.latestTurn?.completedAt ?? null)
    : null;
  const pendingInputAt =
    input.thread.hasPendingUserInput &&
    hasUnseenTimestamp(input.thread.latestPendingUserInputAt, input.lastVisitedAt)
      ? input.thread.latestPendingUserInputAt
      : null;

  return {
    doneAt,
    pendingInputAt,
  };
}

export function reconcileThreadNotificationEffects(input: {
  readonly environmentId: EnvironmentId;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly suppressInitialChime?: boolean | undefined;
}): void {
  const lastVisitedAtByThreadKey = useUiStateStore.getState().threadLastVisitedAtById;

  for (const thread of input.threads) {
    const threadKey = scopedThreadKey(scopeThreadRef(input.environmentId, thread.id));
    const previous = notificationStateByThreadKey.get(threadKey) ?? {
      doneNotifiedAt: null,
      pendingInputNotifiedAt: null,
    };
    const next = deriveUnseenNotificationTimestamps({
      thread,
      lastVisitedAt: lastVisitedAtByThreadKey[threadKey],
    });

    const shouldChime =
      !input.suppressInitialChime &&
      ((next.doneAt !== null && next.doneAt !== previous.doneNotifiedAt) ||
        (next.pendingInputAt !== null && next.pendingInputAt !== previous.pendingInputNotifiedAt));

    notificationStateByThreadKey.set(threadKey, {
      doneNotifiedAt: next.doneAt,
      pendingInputNotifiedAt: next.pendingInputAt,
    });

    if (shouldChime) {
      playThreadNotificationChime();
    }
  }
}

export function clearThreadNotificationEffects(threadKey: string): void {
  notificationStateByThreadKey.delete(threadKey);
}

export function resetThreadNotificationEffectsForTests(): void {
  notificationStateByThreadKey.clear();
  chimeAudio = null;
}
