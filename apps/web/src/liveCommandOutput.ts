import { useSyncExternalStore } from "react";
import type { EnvironmentId, OrchestrationCommandOutputDelta, ThreadId } from "@t3tools/contracts";

const MAX_BUFFER_CHARS = 96_000;
const MAX_BUFFER_LINES = 2_000;
const MAX_SEEN_CHUNKS = 4_000;

export interface LiveCommandOutputKey {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  toolCallId: string;
}

export interface LiveCommandOutputSnapshot {
  text: string;
  version: number;
  truncated: boolean;
  updatedAt: string | null;
}

interface LiveCommandOutputEntry extends LiveCommandOutputSnapshot {
  subscribers: Set<() => void>;
  seenChunkIds: Set<string>;
  seenChunkOrder: string[];
  notifyQueued: boolean;
}

const EMPTY_SNAPSHOT: LiveCommandOutputSnapshot = {
  text: "",
  version: 0,
  truncated: false,
  updatedAt: null,
};

const entries = new Map<string, LiveCommandOutputEntry>();

function liveCommandOutputKey(input: LiveCommandOutputKey): string {
  return `${input.environmentId}:${input.threadId}:${input.toolCallId}`;
}

function trimBufferedText(text: string): { text: string; truncated: boolean } {
  let nextText = text;
  let truncated = false;
  if (nextText.length > MAX_BUFFER_CHARS) {
    nextText = nextText.slice(nextText.length - MAX_BUFFER_CHARS);
    const firstLineBreak = nextText.search(/\r\n|\n|\r/u);
    if (firstLineBreak >= 0) {
      nextText = nextText.slice(firstLineBreak + 1);
    }
    truncated = true;
  }

  const lines = nextText.split(/\r\n|\n|\r/u);
  if (lines.length > MAX_BUFFER_LINES) {
    nextText = lines.slice(-MAX_BUFFER_LINES).join("\n");
    truncated = true;
  }

  return { text: nextText, truncated };
}

function getOrCreateEntry(key: string): LiveCommandOutputEntry {
  const existing = entries.get(key);
  if (existing) return existing;
  const entry: LiveCommandOutputEntry = {
    ...EMPTY_SNAPSHOT,
    subscribers: new Set(),
    seenChunkIds: new Set(),
    seenChunkOrder: [],
    notifyQueued: false,
  };
  entries.set(key, entry);
  return entry;
}

function queueNotify(entry: LiveCommandOutputEntry): void {
  if (entry.notifyQueued) return;
  entry.notifyQueued = true;
  const notify = () => {
    entry.notifyQueued = false;
    for (const subscriber of entry.subscribers) {
      subscriber();
    }
  };
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    queueMicrotask(notify);
    return;
  }
  window.requestAnimationFrame(notify);
}

export function appendLiveCommandOutputDelta(
  environmentId: EnvironmentId,
  delta: OrchestrationCommandOutputDelta,
): void {
  const key = liveCommandOutputKey({
    environmentId,
    threadId: delta.threadId,
    toolCallId: delta.toolCallId,
  });
  const entry = getOrCreateEntry(key);
  const chunkId = String(delta.chunkId);
  if (entry.seenChunkIds.has(chunkId)) {
    return;
  }
  entry.seenChunkIds.add(chunkId);
  entry.seenChunkOrder.push(chunkId);
  while (entry.seenChunkOrder.length > MAX_SEEN_CHUNKS) {
    const removed = entry.seenChunkOrder.shift();
    if (removed) entry.seenChunkIds.delete(removed);
  }

  const trimmed = trimBufferedText(`${entry.text}${delta.delta}`);
  entry.text = trimmed.text;
  entry.truncated = entry.truncated || trimmed.truncated;
  entry.updatedAt = delta.createdAt;
  entry.version += 1;
  queueNotify(entry);
}

export function readLiveCommandOutputSnapshot(
  keyInput: LiveCommandOutputKey | null,
): LiveCommandOutputSnapshot {
  if (!keyInput) return EMPTY_SNAPSHOT;
  return entries.get(liveCommandOutputKey(keyInput)) ?? EMPTY_SNAPSHOT;
}

export function subscribeLiveCommandOutput(
  keyInput: LiveCommandOutputKey | null,
  subscriber: () => void,
): () => void {
  if (!keyInput) return () => undefined;
  const entry = getOrCreateEntry(liveCommandOutputKey(keyInput));
  entry.subscribers.add(subscriber);
  return () => {
    entry.subscribers.delete(subscriber);
  };
}

export function useLiveCommandOutput(
  keyInput: LiveCommandOutputKey | null,
): LiveCommandOutputSnapshot {
  return useSyncExternalStore(
    (subscriber) => subscribeLiveCommandOutput(keyInput, subscriber),
    () => readLiveCommandOutputSnapshot(keyInput),
    () => EMPTY_SNAPSHOT,
  );
}

export function resetLiveCommandOutputForTests(): void {
  entries.clear();
}
