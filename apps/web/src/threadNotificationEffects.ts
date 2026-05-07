import type { EnvironmentId, OrchestrationThreadShell } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";

import { hasUnseenTimestamp } from "./components/Sidebar.logic";
import { getClientSettings } from "./hooks/useSettings";
import { useUiStateStore } from "./uiStateStore";

type ThreadNotificationState = {
  doneNotifiedAt: string | null;
  pendingInputNotifiedAt: string | null;
};

const notificationStateByThreadKey = new Map<string, ThreadNotificationState>();

let chimeAudio: HTMLAudioElement | null = null;

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function toneEnvelope(position: number): number {
  if (position < 0 || position > 1) return 0;
  if (position < 0.08) return position / 0.08;
  const release = (position - 0.08) / 0.92;
  return Math.cos((release * Math.PI) / 2) ** 2;
}

function makeThreadNotificationChimeUrl(): string {
  const sampleRate = 44_100;
  const durationSeconds = 0.52;
  const sampleCount = Math.floor(sampleRate * durationSeconds);
  const bytesPerSample = 2;
  const dataSize = sampleCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const time = sample / sampleRate;
    const firstTonePosition = time / 0.32;
    const secondTonePosition = (time - 0.12) / 0.34;
    const firstTone = Math.sin(2 * Math.PI * 660 * time) * toneEnvelope(firstTonePosition) * 0.18;
    const secondTone = Math.sin(2 * Math.PI * 880 * time) * toneEnvelope(secondTonePosition) * 0.15;
    const sampleValue = Math.max(-1, Math.min(1, firstTone + secondTone));

    view.setInt16(44 + sample * bytesPerSample, Math.round(sampleValue * 0x7fff), true);
  }

  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }

  return `data:audio/wav;base64,${btoa(binary)}`;
}

function playThreadNotificationChime(): void {
  if (!getClientSettings().notificationSoundsEnabled) {
    return;
  }

  const desktopBridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
  if (desktopBridge) {
    void desktopBridge.playNotificationSound().catch(() => undefined);
    return;
  }

  if (typeof Audio === "undefined" || typeof btoa === "undefined") {
    return;
  }

  try {
    chimeAudio ??= new Audio(makeThreadNotificationChimeUrl());
    chimeAudio.currentTime = 0;
    void chimeAudio.play().catch(() => undefined);
  } catch {
    // Notification sounds are best-effort and should never interrupt UI updates.
  }
}

function deriveUnseenNotificationTimestamps(input: {
  readonly thread: OrchestrationThreadShell;
  readonly lastVisitedAt: string | undefined;
}): {
  readonly doneAt: string | null;
  readonly pendingInputAt: string | null;
} {
  const latestTurnCompletedAt =
    input.thread.latestTurn?.startedAt &&
    input.thread.latestTurn.completedAt &&
    input.thread.session?.status !== "running"
      ? input.thread.latestTurn?.completedAt
      : null;
  const doneAt = hasUnseenTimestamp(latestTurnCompletedAt, input.lastVisitedAt)
    ? (latestTurnCompletedAt ?? null)
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
