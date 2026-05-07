import { Effect } from "effect";
import type {
  OrchestrationCommandOutputDelta,
  OrchestrationCommandOutputSnapshot,
  ThreadId,
} from "@t3tools/contracts";

const RETENTION_MS = 10 * 60_000;
const MAX_ENTRY_CHARS = 5 * 1024 * 1024;
const MAX_TOTAL_CHARS = 100 * 1024 * 1024;
const MAX_SEEN_CHUNKS = 10_000;

interface CommandOutputBufferEntry {
  readonly threadId: OrchestrationCommandOutputDelta["threadId"];
  readonly turnId: OrchestrationCommandOutputDelta["turnId"];
  readonly toolCallId: OrchestrationCommandOutputDelta["toolCallId"];
  text: string;
  truncated: boolean;
  updatedAt: string | null;
  lastAccessedAt: number;
  expiresAt: number;
  seenChunkIds: Set<string>;
  seenChunkOrder: string[];
}

const entries = new Map<string, CommandOutputBufferEntry>();
let totalChars = 0;

function bufferKey(
  input: Pick<OrchestrationCommandOutputDelta, "threadId" | "toolCallId">,
): string {
  return `${input.threadId}:${input.toolCallId}`;
}

function trimEntryText(entry: CommandOutputBufferEntry): void {
  if (entry.text.length <= MAX_ENTRY_CHARS) {
    return;
  }
  const previousLength = entry.text.length;
  entry.text = entry.text.slice(entry.text.length - MAX_ENTRY_CHARS);
  const firstLineBreak = entry.text.search(/\r\n|\n|\r/u);
  if (firstLineBreak >= 0) {
    entry.text = entry.text.slice(firstLineBreak + 1);
  }
  entry.truncated = true;
  totalChars -= previousLength - entry.text.length;
}

function evictExpired(now: number): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) {
      totalChars -= entry.text.length;
      entries.delete(key);
    }
  }
}

function evictLru(): void {
  while (totalChars > MAX_TOTAL_CHARS && entries.size > 0) {
    let oldestKey: string | null = null;
    let oldestAccessedAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of entries) {
      if (entry.lastAccessedAt < oldestAccessedAt) {
        oldestAccessedAt = entry.lastAccessedAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) {
      return;
    }
    const evicted = entries.get(oldestKey);
    if (evicted) {
      totalChars -= evicted.text.length;
    }
    entries.delete(oldestKey);
  }
}

function toSnapshot(entry: CommandOutputBufferEntry): OrchestrationCommandOutputSnapshot {
  return {
    threadId: entry.threadId,
    turnId: entry.turnId,
    toolCallId: entry.toolCallId,
    updatedAt: entry.updatedAt,
    text: entry.text,
    truncated: entry.truncated,
  };
}

export const appendCommandOutputBufferDelta = (delta: OrchestrationCommandOutputDelta) =>
  Effect.sync(() => {
    const now = Date.now();
    evictExpired(now);
    const key = bufferKey(delta);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        threadId: delta.threadId,
        turnId: delta.turnId,
        toolCallId: delta.toolCallId,
        text: "",
        truncated: false,
        updatedAt: null,
        lastAccessedAt: now,
        expiresAt: now + RETENTION_MS,
        seenChunkIds: new Set(),
        seenChunkOrder: [],
      };
      entries.set(key, entry);
    }

    const chunkId = String(delta.chunkId);
    if (entry.seenChunkIds.has(chunkId)) {
      entry.lastAccessedAt = now;
      entry.expiresAt = now + RETENTION_MS;
      return;
    }
    entry.seenChunkIds.add(chunkId);
    entry.seenChunkOrder.push(chunkId);
    while (entry.seenChunkOrder.length > MAX_SEEN_CHUNKS) {
      const removed = entry.seenChunkOrder.shift();
      if (removed) entry.seenChunkIds.delete(removed);
    }

    entry.text += delta.delta;
    totalChars += delta.delta.length;
    entry.updatedAt = delta.createdAt;
    entry.lastAccessedAt = now;
    entry.expiresAt = now + RETENTION_MS;
    trimEntryText(entry);
    evictLru();
  });

export const readCommandOutputSnapshotsForThread = (threadId: ThreadId) =>
  Effect.sync(() => {
    const now = Date.now();
    evictExpired(now);
    const snapshots: OrchestrationCommandOutputSnapshot[] = [];
    for (const entry of entries.values()) {
      if (entry.threadId !== threadId || entry.text.length === 0) {
        continue;
      }
      entry.lastAccessedAt = now;
      snapshots.push(toSnapshot(entry));
    }
    return snapshots;
  });

export const resetCommandOutputBufferForTests = (): void => {
  entries.clear();
  totalChars = 0;
};
