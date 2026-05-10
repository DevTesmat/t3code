import { useSyncExternalStore } from "react";
import type {
  EnvironmentId,
  OrchestrationCommandOutputDelta,
  OrchestrationCommandOutputSnapshot,
  ThreadId,
} from "@t3tools/contracts";

const MAX_BUFFER_CHARS = 5 * 1024 * 1024;
const MAX_TOTAL_CHARS = 100 * 1024 * 1024;
const MAX_SEEN_CHUNKS = 4_000;
const RETENTION_MS = 10 * 60_000;

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
  snapshot: LiveCommandOutputSnapshot;
  subscribers: Set<() => void>;
  seenChunkIds: Set<string>;
  seenChunkOrder: string[];
  notifyQueued: boolean;
  lastAccessedAt: number;
  expiresAt: number;
}

const EMPTY_SNAPSHOT: LiveCommandOutputSnapshot = {
  text: "",
  version: 0,
  truncated: false,
  updatedAt: null,
};

const entries = new Map<string, LiveCommandOutputEntry>();
let totalChars = 0;
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

function shouldDebugFileChangeStreams(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage?.getItem("t3.debug.fileChanges") === "1";
  } catch {
    return false;
  }
}

export function debugFileChangeStream(event: string, details: Record<string, unknown>): void {
  if (
    !shouldDebugFileChangeStreams() ||
    typeof console === "undefined" ||
    typeof console.log !== "function"
  ) {
    return;
  }
  console.log(`[t3:file-change] ${event}`, details);
}

function liveCommandOutputKey(input: LiveCommandOutputKey): string {
  return `${input.environmentId}:${input.threadId}:${input.toolCallId}`;
}

function isResetChunkId(chunkId: string): boolean {
  return chunkId.includes(":file-change-reset:");
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

  return { text: nextText, truncated };
}

function evictEntry(key: string, entry: LiveCommandOutputEntry): void {
  totalChars -= entry.text.length;
  entries.delete(key);
}

function evictExpired(now: number): void {
  for (const [key, entry] of entries) {
    if (entry.subscribers.size === 0 && entry.expiresAt <= now) {
      evictEntry(key, entry);
    }
  }
}

function evictLru(): void {
  while (totalChars > MAX_TOTAL_CHARS && entries.size > 0) {
    let oldestKey: string | null = null;
    let oldestAccessedAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of entries) {
      if (entry.subscribers.size > 0) {
        continue;
      }
      if (entry.lastAccessedAt < oldestAccessedAt) {
        oldestAccessedAt = entry.lastAccessedAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) {
      return;
    }
    const entry = entries.get(oldestKey);
    if (entry) {
      evictEntry(oldestKey, entry);
    }
  }
}

function scheduleCleanup(): void {
  if (cleanupTimer !== null || typeof setTimeout !== "function") return;
  cleanupTimer = setTimeout(() => {
    cleanupTimer = null;
    evictExpired(Date.now());
    if ([...entries.values()].some((entry) => entry.subscribers.size === 0)) {
      scheduleCleanup();
    }
  }, RETENTION_MS);
}

function touchEntry(entry: LiveCommandOutputEntry, now: number): void {
  entry.lastAccessedAt = now;
  entry.expiresAt = now + RETENTION_MS;
}

function getOrCreateEntry(key: string): LiveCommandOutputEntry {
  const now = Date.now();
  evictExpired(now);
  const existing = entries.get(key);
  if (existing) {
    touchEntry(existing, now);
    return existing;
  }
  const entry: LiveCommandOutputEntry = {
    ...EMPTY_SNAPSHOT,
    snapshot: EMPTY_SNAPSHOT,
    subscribers: new Set(),
    seenChunkIds: new Set(),
    seenChunkOrder: [],
    notifyQueued: false,
    lastAccessedAt: now,
    expiresAt: now + RETENTION_MS,
  };
  entries.set(key, entry);
  scheduleCleanup();
  return entry;
}

function refreshEntrySnapshot(entry: LiveCommandOutputEntry): void {
  entry.snapshot = {
    text: entry.text,
    version: entry.version,
    truncated: entry.truncated,
    updatedAt: entry.updatedAt,
  };
}

function queueNotify(entry: LiveCommandOutputEntry, mode: "frame" | "microtask" = "frame"): void {
  if (entry.notifyQueued) return;
  entry.notifyQueued = true;
  const notify = () => {
    entry.notifyQueued = false;
    for (const subscriber of entry.subscribers) {
      subscriber();
    }
  };
  if (
    mode === "microtask" ||
    typeof window === "undefined" ||
    typeof window.requestAnimationFrame !== "function"
  ) {
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
  if (isResetChunkId(chunkId)) {
    totalChars -= entry.text.length;
    entry.text = "";
    entry.truncated = false;
    entry.seenChunkIds.clear();
    entry.seenChunkOrder.length = 0;
  }
  if (entry.seenChunkIds.has(chunkId)) {
    return;
  }
  entry.seenChunkIds.add(chunkId);
  entry.seenChunkOrder.push(chunkId);
  while (entry.seenChunkOrder.length > MAX_SEEN_CHUNKS) {
    const removed = entry.seenChunkOrder.shift();
    if (removed) entry.seenChunkIds.delete(removed);
  }

  const previousLength = entry.text.length;
  const trimmed = trimBufferedText(`${entry.text}${delta.delta}`);
  entry.text = trimmed.text;
  entry.truncated = entry.truncated || trimmed.truncated;
  entry.updatedAt = delta.createdAt;
  entry.version += 1;
  refreshEntrySnapshot(entry);
  totalChars += entry.text.length - previousLength;
  touchEntry(entry, Date.now());
  evictLru();
  queueNotify(entry);
}

export function hydrateLiveCommandOutputSnapshot(
  environmentId: EnvironmentId,
  snapshot: OrchestrationCommandOutputSnapshot,
): void {
  const key = liveCommandOutputKey({
    environmentId,
    threadId: snapshot.threadId,
    toolCallId: snapshot.toolCallId,
  });
  const entry = getOrCreateEntry(key);
  if (snapshot.text.length === 0 && entry.text.length > 0) {
    debugFileChangeStream("live-buffer-ignore-empty-snapshot", {
      environmentId,
      threadId: snapshot.threadId,
      toolCallId: snapshot.toolCallId,
      currentLength: entry.text.length,
      incomingUpdatedAt: snapshot.updatedAt,
      currentUpdatedAt: entry.updatedAt,
    });
    return;
  }
  if (entry.updatedAt && snapshot.updatedAt && entry.updatedAt > snapshot.updatedAt) {
    debugFileChangeStream("live-buffer-ignore-stale-snapshot", {
      environmentId,
      threadId: snapshot.threadId,
      toolCallId: snapshot.toolCallId,
      currentLength: entry.text.length,
      incomingLength: snapshot.text.length,
      incomingUpdatedAt: snapshot.updatedAt,
      currentUpdatedAt: entry.updatedAt,
    });
    return;
  }
  const previousLength = entry.text.length;
  entry.text = snapshot.text;
  entry.truncated = snapshot.truncated;
  entry.updatedAt = snapshot.updatedAt;
  entry.version += 1;
  refreshEntrySnapshot(entry);
  totalChars += entry.text.length - previousLength;
  touchEntry(entry, Date.now());
  evictLru();
  debugFileChangeStream("live-buffer-hydrate-snapshot", {
    environmentId,
    threadId: snapshot.threadId,
    toolCallId: snapshot.toolCallId,
    previousLength,
    incomingLength: snapshot.text.length,
    version: entry.version,
    updatedAt: snapshot.updatedAt,
    subscribers: entry.subscribers.size,
  });
  queueNotify(entry);
}

export function readLiveCommandOutputSnapshot(
  keyInput: LiveCommandOutputKey | null,
): LiveCommandOutputSnapshot {
  if (!keyInput) return EMPTY_SNAPSHOT;
  const now = Date.now();
  evictExpired(now);
  const entry = entries.get(liveCommandOutputKey(keyInput));
  if (!entry) return EMPTY_SNAPSHOT;
  touchEntry(entry, now);
  return entry.snapshot;
}

export function subscribeLiveCommandOutput(
  keyInput: LiveCommandOutputKey | null,
  subscriber: () => void,
): () => void {
  if (!keyInput) return () => undefined;
  const entry = getOrCreateEntry(liveCommandOutputKey(keyInput));
  entry.subscribers.add(subscriber);
  touchEntry(entry, Date.now());
  return () => {
    entry.subscribers.delete(subscriber);
    touchEntry(entry, Date.now());
    scheduleCleanup();
  };
}

export function useLiveCommandOutput(
  keyInput: LiveCommandOutputKey | null,
): LiveCommandOutputSnapshot {
  return useSyncExternalStore(
    (subscriber) => subscribeLiveCommandOutput(keyInput, subscriber),
    () => readLiveCommandOutputSnapshot(keyInput),
    () => readLiveCommandOutputSnapshot(keyInput),
  );
}

export function resetLiveCommandOutputForTests(): void {
  entries.clear();
  totalChars = 0;
  if (cleanupTimer !== null) {
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }
}

export function sweepLiveCommandOutputForTests(now = Date.now()): void {
  evictExpired(now);
  evictLru();
}
