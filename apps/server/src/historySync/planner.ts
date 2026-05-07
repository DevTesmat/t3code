import * as Crypto from "node:crypto";

import type { OrchestrationEvent } from "@t3tools/contracts";

const HISTORY_SYNC_MYSQL_BATCH_SIZE = 500;

export interface HistorySyncEventRow {
  readonly sequence: number;
  readonly eventId: string;
  readonly aggregateKind: "project" | "thread";
  readonly streamId: string;
  readonly streamVersion: number;
  readonly eventType: OrchestrationEvent["type"];
  readonly occurredAt: string;
  readonly commandId: string | null;
  readonly causationEventId: string | null;
  readonly correlationId: string | null;
  readonly actorKind: string;
  readonly payloadJson: string;
  readonly metadataJson: string;
}

export interface HistorySyncPushedEventReceiptRow {
  readonly sequence: number;
  readonly eventId: string;
  readonly streamId: string;
  readonly eventType: OrchestrationEvent["type"];
  readonly pushedAt: string;
}

export interface HistorySyncAutosyncProjectionThreadRow {
  readonly threadId: string;
  readonly pendingUserInputCount: number;
  readonly hasActionableProposedPlan: number;
  readonly latestTurnId: string | null;
  readonly sessionStatus: string | null;
  readonly sessionActiveTurnId: string | null;
}

export interface HistorySyncAutosyncThreadState {
  readonly threadId: string;
  readonly hasOpenTurn: boolean;
  readonly hasCompletedTurn: boolean;
  readonly pendingUserInputCount: number;
  readonly hasActionableProposedPlan: boolean;
  readonly sessionStatus: string | null;
  readonly sessionActiveTurnId: string | null;
}

interface ThreadCandidate {
  readonly threadId: string;
  readonly projectId: string | null;
  readonly hash: string | null;
  readonly events: readonly HistorySyncEventRow[];
}

export interface ProjectCandidate {
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly deleted: boolean;
  readonly threadCount: number;
}

export interface HistorySyncProjectMappingRow {
  readonly remoteProjectId: string;
  readonly localProjectId: string;
  readonly localWorkspaceRoot: string;
  readonly remoteWorkspaceRoot: string;
  readonly remoteTitle: string;
  readonly status: "mapped" | "skipped";
  readonly createdAt: string;
  readonly updatedAt: string;
}

function normalizeUserText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function readPayload(row: HistorySyncEventRow): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(row.payloadJson);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function computeThreadUserSequenceHash(
  events: readonly HistorySyncEventRow[],
): string | null {
  const userMessages = events
    .filter((event) => event.eventType === "thread.message-sent")
    .toSorted(
      (left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId),
    )
    .flatMap((event) => {
      const payload = readPayload(event);
      if (!payload || payload.role !== "user" || (payload.source ?? "user") !== "user") {
        return [];
      }
      return [
        {
          text: normalizeUserText(String(payload.text ?? "")),
          attachments: payload.attachments ?? null,
        },
      ];
    });

  if (userMessages.length === 0) {
    return null;
  }

  return Crypto.createHash("sha256").update(stableStringify(userMessages)).digest("hex");
}

export function shouldRunAutomaticHistorySync(input: {
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly hasCompletedInitialSync: boolean;
}): boolean {
  return input.enabled && input.configured && input.hasCompletedInitialSync;
}

function groupThreadCandidates(events: readonly HistorySyncEventRow[]): ThreadCandidate[] {
  const grouped = new Map<string, HistorySyncEventRow[]>();
  for (const event of events) {
    if (event.aggregateKind !== "thread") continue;
    const rows = grouped.get(event.streamId) ?? [];
    rows.push(event);
    grouped.set(event.streamId, rows);
  }

  return [...grouped.entries()].map(([threadId, rows]) => {
    const sorted = rows.toSorted((left, right) => left.sequence - right.sequence);
    const created = sorted.find((event) => event.eventType === "thread.created");
    const payload = created ? readPayload(created) : null;
    const projectId = typeof payload?.projectId === "string" ? payload.projectId : null;
    return {
      threadId,
      projectId,
      hash: computeThreadUserSequenceHash(sorted),
      events: sorted,
    };
  });
}

function readString(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function eventProjectId(
  event: HistorySyncEventRow,
  payload: Record<string, unknown> | null,
): string {
  return readString(payload, "projectId") ?? event.streamId;
}

export function collectProjectCandidates(
  events: readonly HistorySyncEventRow[],
): ProjectCandidate[] {
  const projects = new Map<string, ProjectCandidate>();
  const threadProjectIds = new Map<string, string>();

  for (const event of events.toSorted((left, right) => left.sequence - right.sequence)) {
    const payload = readPayload(event);
    if (event.eventType === "project.created") {
      const projectId = eventProjectId(event, payload);
      projects.set(projectId, {
        projectId,
        title: readString(payload, "title") ?? projectId,
        workspaceRoot: readString(payload, "workspaceRoot") ?? "",
        deleted: false,
        threadCount: projects.get(projectId)?.threadCount ?? 0,
      });
      continue;
    }
    if (event.eventType === "project.meta-updated") {
      const projectId = eventProjectId(event, payload);
      const existing = projects.get(projectId);
      if (!existing) continue;
      projects.set(projectId, {
        ...existing,
        title: readString(payload, "title") ?? existing.title,
        workspaceRoot: readString(payload, "workspaceRoot") ?? existing.workspaceRoot,
      });
      continue;
    }
    if (event.eventType === "project.deleted") {
      const projectId = eventProjectId(event, payload);
      const existing = projects.get(projectId);
      if (existing) {
        projects.set(projectId, { ...existing, deleted: true });
      }
      continue;
    }
    if (event.eventType === "thread.created") {
      const threadId = readString(payload, "threadId") ?? event.streamId;
      const projectId = readString(payload, "projectId");
      if (projectId) {
        threadProjectIds.set(threadId, projectId);
      }
    }
  }

  const threadCounts = new Map<string, number>();
  for (const projectId of threadProjectIds.values()) {
    threadCounts.set(projectId, (threadCounts.get(projectId) ?? 0) + 1);
    if (!projects.has(projectId)) {
      projects.set(projectId, {
        projectId,
        title: projectId,
        workspaceRoot: "",
        deleted: false,
        threadCount: 0,
      });
    }
  }

  const candidates: ProjectCandidate[] = [];
  for (const project of projects.values()) {
    const threadCount = threadCounts.get(project.projectId) ?? 0;
    if (project.deleted && threadCount === 0) continue;
    candidates.push({
      projectId: project.projectId,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      deleted: false,
      threadCount,
    });
  }
  return candidates;
}

function collectThreadProjectIds(events: readonly HistorySyncEventRow[]): Map<string, string> {
  const threadProjectIds = new Map<string, string>();
  for (const event of events) {
    if (event.eventType !== "thread.created") continue;
    const payload = readPayload(event);
    const threadId = readString(payload, "threadId") ?? event.streamId;
    const projectId = readString(payload, "projectId");
    if (projectId) {
      threadProjectIds.set(threadId, projectId);
    }
  }
  return threadProjectIds;
}

function updateEventPayload(
  row: HistorySyncEventRow,
  update: (payload: Record<string, unknown>) => Record<string, unknown>,
): HistorySyncEventRow {
  const payload = readPayload(row);
  if (!payload) return row;
  return {
    ...row,
    payloadJson: JSON.stringify(update(payload)),
  };
}

function rewriteProjectAggregate(
  row: HistorySyncEventRow,
  input: { readonly projectId: string; readonly workspaceRoot: string },
): HistorySyncEventRow {
  return updateEventPayload(
    {
      ...row,
      streamId: input.projectId,
    },
    (payload) => ({
      ...payload,
      projectId: input.projectId,
      ...("workspaceRoot" in payload ? { workspaceRoot: input.workspaceRoot } : {}),
    }),
  );
}

function rewriteThreadCreatedProjectId(
  row: HistorySyncEventRow,
  projectId: string,
): HistorySyncEventRow {
  if (row.eventType !== "thread.created") return row;
  return updateEventPayload(row, (payload) => ({
    ...payload,
    projectId,
  }));
}

function normalizeModelSelectionPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const existing = payload.modelSelection;
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return payload;
  }
  const legacyModel =
    typeof payload.model === "string" && payload.model.trim() ? payload.model : null;
  const legacyInstanceId =
    typeof payload.instanceId === "string" && payload.instanceId.trim()
      ? payload.instanceId
      : typeof payload.provider === "string" && payload.provider.trim()
        ? payload.provider
        : "codex";
  return {
    ...payload,
    modelSelection: {
      instanceId: legacyInstanceId,
      model: legacyModel ?? "gpt-5.4",
    },
  };
}

function normalizeThreadCreatedPayload(
  row: HistorySyncEventRow,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const withModelSelection = normalizeModelSelectionPayload(payload);
  const threadId = readString(withModelSelection, "threadId") ?? row.streamId;
  const title = readString(withModelSelection, "title") ?? threadId;
  return {
    ...withModelSelection,
    threadId,
    title,
    runtimeMode: readString(withModelSelection, "runtimeMode") ?? "full-access",
    interactionMode: readString(withModelSelection, "interactionMode") ?? "default",
    branch: "branch" in withModelSelection ? withModelSelection.branch : null,
    worktreePath: "worktreePath" in withModelSelection ? withModelSelection.worktreePath : null,
    createdAt: readString(withModelSelection, "createdAt") ?? row.occurredAt,
    updatedAt: readString(withModelSelection, "updatedAt") ?? row.occurredAt,
  };
}

export function normalizeRemoteEventForLocalImport(row: HistorySyncEventRow): HistorySyncEventRow {
  if (row.eventType !== "thread.created") return row;
  return updateEventPayload(row, (payload) => normalizeThreadCreatedPayload(row, payload));
}

export function normalizeRemoteEventsForLocalImport(
  events: readonly HistorySyncEventRow[],
): readonly HistorySyncEventRow[] {
  return events.map(normalizeRemoteEventForLocalImport);
}

export function rewriteRemoteEventsForLocalMappings(
  events: readonly HistorySyncEventRow[],
  mappings: readonly Pick<
    HistorySyncProjectMappingRow,
    "remoteProjectId" | "localProjectId" | "localWorkspaceRoot" | "status"
  >[],
): readonly HistorySyncEventRow[] {
  const mappingByRemote = new Map(mappings.map((mapping) => [mapping.remoteProjectId, mapping]));
  const threadProjectIds = collectThreadProjectIds(events);
  const rewritten: HistorySyncEventRow[] = [];

  for (const event of events) {
    if (event.aggregateKind === "project") {
      const payload = readPayload(event);
      const mapping = mappingByRemote.get(eventProjectId(event, payload));
      if (!mapping) {
        rewritten.push(event);
        continue;
      }
      if (mapping.status === "skipped") {
        continue;
      }
      if (event.eventType === "project.deleted") {
        continue;
      }
      rewritten.push(
        rewriteProjectAggregate(event, {
          projectId: mapping.localProjectId,
          workspaceRoot: mapping.localWorkspaceRoot,
        }),
      );
      continue;
    }

    const remoteProjectId = threadProjectIds.get(event.streamId);
    const mapping = remoteProjectId ? mappingByRemote.get(remoteProjectId) : undefined;
    if (mapping?.status === "skipped") {
      continue;
    }
    rewritten.push(
      mapping?.status === "mapped"
        ? rewriteThreadCreatedProjectId(event, mapping.localProjectId)
        : event,
    );
  }

  return rewritten;
}

export function rewriteLocalEventsForRemoteMappings(
  events: readonly HistorySyncEventRow[],
  mappings: readonly Pick<
    HistorySyncProjectMappingRow,
    "remoteProjectId" | "localProjectId" | "remoteWorkspaceRoot" | "status"
  >[],
): readonly HistorySyncEventRow[] {
  const mappedByLocal = new Map(
    mappings
      .filter((mapping) => mapping.status === "mapped")
      .map((mapping) => [mapping.localProjectId, mapping]),
  );
  const threadProjectIds = collectThreadProjectIds(events);

  return events.map((event) => {
    if (event.aggregateKind === "project") {
      const payload = readPayload(event);
      const mapping = mappedByLocal.get(eventProjectId(event, payload));
      return mapping
        ? rewriteProjectAggregate(event, {
            projectId: mapping.remoteProjectId,
            workspaceRoot: mapping.remoteWorkspaceRoot,
          })
        : event;
    }
    const localProjectId = threadProjectIds.get(event.streamId);
    const mapping = localProjectId ? mappedByLocal.get(localProjectId) : undefined;
    return mapping ? rewriteThreadCreatedProjectId(event, mapping.remoteProjectId) : event;
  });
}

function rewriteThreadEvent(row: HistorySyncEventRow, nextThreadId: string): HistorySyncEventRow {
  const payload = readPayload(row);
  return {
    ...row,
    streamId: nextThreadId,
    eventId: `${row.eventId}:rescued:${Crypto.randomUUID()}`,
    ...(payload && typeof payload.threadId === "string"
      ? { payloadJson: JSON.stringify({ ...payload, threadId: nextThreadId }) }
      : {}),
  };
}

function cloneEventWithSequence(row: HistorySyncEventRow, sequence: number): HistorySyncEventRow {
  return {
    ...row,
    sequence,
  };
}

export function chunkHistorySyncEvents(
  events: readonly HistorySyncEventRow[],
  batchSize = HISTORY_SYNC_MYSQL_BATCH_SIZE,
): readonly (readonly HistorySyncEventRow[])[] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("History sync batch size must be a positive integer.");
  }

  const batches: HistorySyncEventRow[][] = [];
  for (let index = 0; index < events.length; index += batchSize) {
    batches.push(events.slice(index, index + batchSize));
  }
  return batches;
}

export function shouldPushLocalHistoryOnFirstSync(input: {
  readonly hasCompletedInitialSync: boolean;
  readonly localEventCount: number;
  readonly remoteEventCount: number;
}): boolean {
  return (
    !input.hasCompletedInitialSync && input.localEventCount > 0 && input.remoteEventCount === 0
  );
}

export function isRemoteBehindLocal(input: {
  readonly hasCompletedInitialSync: boolean;
  readonly localMaxSequence: number;
  readonly remoteMaxSequence: number;
  readonly lastSyncedRemoteSequence: number;
}): boolean {
  return (
    input.hasCompletedInitialSync &&
    input.localMaxSequence > input.remoteMaxSequence &&
    input.lastSyncedRemoteSequence > input.remoteMaxSequence
  );
}

export function selectRemoteBehindLocalEvents(
  localEvents: readonly HistorySyncEventRow[],
  remoteMaxSequence: number,
): readonly HistorySyncEventRow[] {
  return localEvents.filter((event) => event.sequence > remoteMaxSequence);
}

export function nextSyncedRemoteSequenceAfterPush(
  previousRemoteSequence: number,
  pushedEvents: readonly HistorySyncEventRow[],
): number {
  return Math.max(previousRemoteSequence, 0, ...pushedEvents.map((event) => event.sequence));
}

function readPayloadThreadId(row: HistorySyncEventRow): string {
  return readString(readPayload(row), "threadId") ?? row.streamId;
}

function readPayloadTurnId(row: HistorySyncEventRow): string | null {
  return readString(readPayload(row), "turnId");
}

export function selectRemoteDeltaEvents(
  remoteEvents: readonly HistorySyncEventRow[],
  lastSyncedRemoteSequence: number,
): readonly HistorySyncEventRow[] {
  return remoteEvents.filter((event) => event.sequence > lastSyncedRemoteSequence);
}

export function filterAlreadyImportedRemoteDeltaEvents(
  remoteEvents: readonly HistorySyncEventRow[],
  localEvents: readonly HistorySyncEventRow[],
): readonly HistorySyncEventRow[] {
  const localEventIdBySequence = new Map(
    localEvents.map((event) => [event.sequence, event.eventId]),
  );
  return remoteEvents.filter(
    (event) => localEventIdBySequence.get(event.sequence) !== event.eventId,
  );
}

export function selectKnownRemoteDeltaLocalEvents(input: {
  readonly remoteEvents: readonly HistorySyncEventRow[];
  readonly localEvents: readonly HistorySyncEventRow[];
}): readonly HistorySyncEventRow[] {
  const localEventById = new Map(input.localEvents.map((event) => [event.eventId, event]));
  return input.remoteEvents.flatMap((event) => {
    const localEvent = localEventById.get(event.eventId);
    return localEvent ? [localEvent] : [];
  });
}

export function selectUnknownRemoteDeltaEvents(input: {
  readonly remoteEvents: readonly HistorySyncEventRow[];
  readonly localEvents: readonly HistorySyncEventRow[];
}): readonly HistorySyncEventRow[] {
  const localEventIds = new Set(input.localEvents.map((event) => event.eventId));
  return input.remoteEvents.filter((event) => !localEventIds.has(event.eventId));
}

export function filterUnpushedLocalEvents(
  localEvents: readonly HistorySyncEventRow[],
  pushedSequences: ReadonlySet<number>,
): readonly HistorySyncEventRow[] {
  return localEvents.filter((event) => !pushedSequences.has(event.sequence));
}

export function classifyAutosyncThreadStates(
  events: readonly HistorySyncEventRow[],
  projectionThreadRows: readonly HistorySyncAutosyncProjectionThreadRow[] = [],
): ReadonlyMap<string, HistorySyncAutosyncThreadState> {
  const openTurnByThread = new Map<string, string>();
  const completedTurnThreads = new Set<string>();
  const threadIds = new Set<string>();
  for (const event of events.toSorted((left, right) => left.sequence - right.sequence)) {
    if (event.aggregateKind !== "thread") continue;
    const threadId = readPayloadThreadId(event);
    threadIds.add(threadId);
    if (event.eventType === "thread.turn-start-requested") {
      const turnId = readPayloadTurnId(event);
      const messageId = readString(readPayload(event), "messageId");
      openTurnByThread.set(threadId, turnId ?? messageId ?? event.eventId);
      continue;
    }
    if (event.eventType === "thread.turn-diff-completed" || event.eventType === "thread.deleted") {
      openTurnByThread.delete(threadId);
    }
    if (event.eventType === "thread.turn-diff-completed") {
      completedTurnThreads.add(threadId);
    }
  }

  const projectionByThreadId = new Map(projectionThreadRows.map((row) => [row.threadId, row]));
  for (const row of projectionThreadRows) {
    threadIds.add(row.threadId);
  }

  return new Map(
    [...threadIds].map((threadId) => {
      const projection = projectionByThreadId.get(threadId);
      return [
        threadId,
        {
          threadId,
          hasOpenTurn: openTurnByThread.has(threadId),
          hasCompletedTurn: completedTurnThreads.has(threadId),
          pendingUserInputCount: projection?.pendingUserInputCount ?? 0,
          hasActionableProposedPlan: projection?.hasActionableProposedPlan === 1,
          sessionStatus: projection?.sessionStatus ?? null,
          sessionActiveTurnId: projection?.sessionActiveTurnId ?? null,
        },
      ];
    }),
  );
}

export function isAutosyncEligibleThread(state: HistorySyncAutosyncThreadState): boolean {
  if (state.pendingUserInputCount > 0 || state.hasActionableProposedPlan) {
    return true;
  }
  return (
    state.sessionActiveTurnId === null &&
    ((state.sessionStatus === "ready" && state.hasCompletedTurn) ||
      state.sessionStatus === "stopped" ||
      state.sessionStatus === "interrupted" ||
      state.sessionStatus === "error")
  );
}

export function selectAutosaveCandidateLocalEvents(input: {
  readonly localEvents: readonly HistorySyncEventRow[];
  readonly unpushedLocalEvents: readonly HistorySyncEventRow[];
  readonly remoteMaxSequence: number;
  readonly maxSequence?: number;
}): readonly HistorySyncEventRow[] {
  const candidateBySequence = new Map<number, HistorySyncEventRow>();
  for (const event of input.unpushedLocalEvents) {
    if (event.sequence <= input.remoteMaxSequence) continue;
    if (input.maxSequence !== undefined && event.sequence > input.maxSequence) continue;
    candidateBySequence.set(event.sequence, event);
  }
  for (const event of selectRemoteBehindLocalEvents(input.localEvents, input.remoteMaxSequence)) {
    if (input.maxSequence !== undefined && event.sequence > input.maxSequence) continue;
    candidateBySequence.set(event.sequence, event);
  }
  return [...candidateBySequence.values()].toSorted(
    (left, right) => left.sequence - right.sequence,
  );
}

export function selectAutosaveRemoteCoveredReceiptEvents(input: {
  readonly unpushedLocalEvents: readonly HistorySyncEventRow[];
  readonly remoteMaxSequence: number;
}): readonly HistorySyncEventRow[] {
  return input.unpushedLocalEvents.filter((event) => event.sequence <= input.remoteMaxSequence);
}

export function selectAutosaveContiguousPushableEvents(input: {
  readonly candidateEvents: readonly HistorySyncEventRow[];
  readonly threadStates: ReadonlyMap<string, HistorySyncAutosyncThreadState>;
}): readonly HistorySyncEventRow[] {
  const pushable: HistorySyncEventRow[] = [];
  for (const event of input.candidateEvents.toSorted(
    (left, right) => left.sequence - right.sequence,
  )) {
    if (event.aggregateKind !== "thread") {
      pushable.push(event);
      continue;
    }
    const threadId = readPayloadThreadId(event);
    const threadState =
      input.threadStates.get(threadId) ??
      ({
        threadId,
        hasOpenTurn: true,
        hasCompletedTurn: false,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: false,
        sessionStatus: null,
        sessionActiveTurnId: null,
      } satisfies HistorySyncAutosyncThreadState);
    if (!isAutosyncEligibleThread(threadState)) {
      break;
    }
    pushable.push(event);
  }
  return pushable;
}

export function shouldScheduleAutosaveForDomainEvent(event: OrchestrationEvent): boolean {
  if (event.type === "thread.turn-diff-completed") {
    return true;
  }
  if (event.type === "thread.proposed-plan-upserted") {
    return true;
  }
  if (event.type === "thread.user-input-response-requested") {
    return true;
  }
  if (event.type === "thread.session-set") {
    return (
      event.payload.session.activeTurnId === null &&
      (event.payload.session.status === "ready" ||
        event.payload.session.status === "stopped" ||
        event.payload.session.status === "interrupted" ||
        event.payload.session.status === "error")
    );
  }
  return false;
}

export function filterPushableLocalEvents(
  candidateEvents: readonly HistorySyncEventRow[],
  allLocalEvents: readonly HistorySyncEventRow[] = candidateEvents,
): readonly HistorySyncEventRow[] {
  const openTurnByThread = new Map<string, string>();
  for (const event of allLocalEvents.toSorted((left, right) => left.sequence - right.sequence)) {
    if (event.eventType === "thread.turn-start-requested") {
      const turnId = readPayloadTurnId(event);
      const messageId = readString(readPayload(event), "messageId");
      openTurnByThread.set(readPayloadThreadId(event), turnId ?? messageId ?? event.eventId);
      continue;
    }
    if (event.eventType === "thread.turn-diff-completed") {
      openTurnByThread.delete(readPayloadThreadId(event));
    }
    if (event.eventType === "thread.deleted") {
      openTurnByThread.delete(readPayloadThreadId(event));
    }
  }

  return candidateEvents.filter((event) => {
    if (event.aggregateKind !== "thread") return true;
    return !openTurnByThread.has(readPayloadThreadId(event));
  });
}

export function buildPushedEventReceiptRows(
  events: readonly HistorySyncEventRow[],
  pushedAt: string,
): readonly HistorySyncPushedEventReceiptRow[] {
  return events.map((event) => ({
    sequence: event.sequence,
    eventId: event.eventId,
    streamId: event.streamId,
    eventType: event.eventType,
    pushedAt,
  }));
}

export function selectPushedReceiptSeedEvents(input: {
  readonly events: readonly HistorySyncEventRow[];
  readonly hasCompletedInitialSync: boolean;
  readonly hasExistingReceipts: boolean;
  readonly lastSyncedRemoteSequence: number;
}): readonly HistorySyncEventRow[] {
  if (
    !input.hasCompletedInitialSync ||
    input.hasExistingReceipts ||
    input.lastSyncedRemoteSequence <= 0
  ) {
    return [];
  }
  return input.events.filter((event) => event.sequence <= input.lastSyncedRemoteSequence);
}

export function countActiveThreadCreates(events: readonly HistorySyncEventRow[]): number {
  const activeThreadIds = new Set<string>();
  for (const event of events.toSorted((left, right) => left.sequence - right.sequence)) {
    if (event.eventType !== "thread.created" && event.eventType !== "thread.deleted") {
      continue;
    }
    const payload = readPayload(event);
    const threadId = readString(payload, "threadId") ?? event.streamId;
    if (event.eventType === "thread.created") {
      activeThreadIds.add(threadId);
    } else {
      activeThreadIds.delete(threadId);
    }
  }
  return activeThreadIds.size;
}

export function shouldImportRemoteIntoEmptyLocal(input: {
  readonly hasCompletedInitialSync: boolean;
  readonly localEventCount: number;
  readonly localProjectionCount?: number;
  readonly localProjectProjectionCount?: number;
  readonly localThreadProjectionCount?: number;
  readonly remoteEventCount: number;
  readonly remoteProjectCount?: number;
  readonly remoteActiveThreadCount?: number;
}): boolean {
  return (
    input.hasCompletedInitialSync &&
    (input.localEventCount === 0 ||
      input.localProjectionCount === 0 ||
      ((input.remoteProjectCount ?? 0) > 0 && (input.localProjectProjectionCount ?? 0) === 0) ||
      (input.remoteActiveThreadCount ?? 0) >
        (input.localThreadProjectionCount ?? Number.MAX_SAFE_INTEGER)) &&
    input.remoteEventCount > 0
  );
}

export type HistorySyncLocalReplacementReason =
  | "local-events-empty"
  | "local-projections-empty"
  | "missing-project-projections"
  | "remote-has-more-active-threads";

export interface HistorySyncLocalReplacementDecision {
  readonly shouldReplace: boolean;
  readonly reason: HistorySyncLocalReplacementReason | null;
}

export function planLocalReplacementFromRemote(input: {
  readonly hasCompletedInitialSync: boolean;
  readonly localEventCount: number;
  readonly localProjectionCount?: number;
  readonly localProjectProjectionCount?: number;
  readonly localThreadProjectionCount?: number;
  readonly remoteEventCount: number;
  readonly remoteProjectCount?: number;
  readonly remoteActiveThreadCount?: number;
}): HistorySyncLocalReplacementDecision {
  if (!input.hasCompletedInitialSync || input.remoteEventCount <= 0) {
    return { shouldReplace: false, reason: null };
  }
  if (input.localEventCount === 0) {
    return { shouldReplace: true, reason: "local-events-empty" };
  }
  if (input.localProjectionCount === 0) {
    return { shouldReplace: true, reason: "local-projections-empty" };
  }
  if ((input.remoteProjectCount ?? 0) > 0 && (input.localProjectProjectionCount ?? 0) === 0) {
    return { shouldReplace: true, reason: "missing-project-projections" };
  }
  if (
    (input.remoteActiveThreadCount ?? 0) >
    (input.localThreadProjectionCount ?? Number.MAX_SAFE_INTEGER)
  ) {
    return { shouldReplace: true, reason: "remote-has-more-active-threads" };
  }
  return { shouldReplace: false, reason: null };
}

export function buildFirstSyncRescueEvents(
  localEvents: readonly HistorySyncEventRow[],
  remoteEvents: readonly HistorySyncEventRow[],
): readonly HistorySyncEventRow[] {
  const localThreads = groupThreadCandidates(localEvents);
  const remoteThreads = groupThreadCandidates(remoteEvents);
  const remoteThreadIds = new Set(remoteThreads.map((thread) => thread.threadId));
  const remoteProjectIds = new Set(
    remoteEvents
      .filter((event) => event.aggregateKind === "project")
      .map((event) => event.streamId),
  );
  const localProjectEventsById = new Map<string, HistorySyncEventRow[]>();
  for (const event of localEvents) {
    if (event.aggregateKind !== "project") continue;
    const rows = localProjectEventsById.get(event.streamId) ?? [];
    rows.push(event);
    localProjectEventsById.set(event.streamId, rows);
  }

  const rescueRows: HistorySyncEventRow[] = [];
  const addedProjectIds = new Set<string>();
  for (const thread of localThreads) {
    if (
      thread.projectId &&
      !remoteProjectIds.has(thread.projectId) &&
      !addedProjectIds.has(thread.projectId)
    ) {
      rescueRows.push(...(localProjectEventsById.get(thread.projectId) ?? []));
      addedProjectIds.add(thread.projectId);
    }

    const nextThreadId = remoteThreadIds.has(thread.threadId)
      ? `rescued-${Crypto.randomUUID()}`
      : thread.threadId;
    rescueRows.push(
      ...thread.events.map((event) =>
        nextThreadId === thread.threadId ? event : rewriteThreadEvent(event, nextThreadId),
      ),
    );
  }

  let nextSequence = Math.max(0, ...remoteEvents.map((event) => event.sequence));
  return rescueRows
    .toSorted((left, right) => left.sequence - right.sequence)
    .map((event) => cloneEventWithSequence(event, ++nextSequence));
}

export function buildFirstSyncClientMergeEvents(
  clientBackupEvents: readonly HistorySyncEventRow[],
  importedRemoteEvents: readonly HistorySyncEventRow[],
  mappings: readonly Pick<
    HistorySyncProjectMappingRow,
    "remoteProjectId" | "localProjectId" | "remoteWorkspaceRoot" | "status"
  >[] = [],
): readonly HistorySyncEventRow[] {
  if (clientBackupEvents.length === 0) {
    return [];
  }

  const remoteThreadIds = new Set(
    groupThreadCandidates(importedRemoteEvents).map((thread) => thread.threadId),
  );
  const remoteProjectIds = new Set(
    importedRemoteEvents
      .filter((event) => event.aggregateKind === "project")
      .map((event) => eventProjectId(event, readPayload(event))),
  );
  const clientThreadProjectIds = collectThreadProjectIds(clientBackupEvents);
  const mappedByLocalProject = new Map(
    mappings
      .filter((mapping) => mapping.status === "mapped")
      .map((mapping) => [mapping.localProjectId, mapping]),
  );
  const rewrittenClientEvents = rewriteLocalEventsForRemoteMappings(clientBackupEvents, mappings);
  const clientProjectEventsById = new Map<string, HistorySyncEventRow[]>();

  for (const event of rewrittenClientEvents) {
    if (event.aggregateKind !== "project") continue;
    const projectId = eventProjectId(event, readPayload(event));
    const rows = clientProjectEventsById.get(projectId) ?? [];
    rows.push(event);
    clientProjectEventsById.set(projectId, rows);
  }

  const mergeRows: HistorySyncEventRow[] = [];
  const addedProjectIds = new Set<string>();
  for (const thread of groupThreadCandidates(rewrittenClientEvents)) {
    const originalProjectId = clientThreadProjectIds.get(thread.threadId);
    const mappedProjectId =
      originalProjectId && mappedByLocalProject.has(originalProjectId)
        ? mappedByLocalProject.get(originalProjectId)?.remoteProjectId
        : thread.projectId;

    if (
      mappedProjectId &&
      !remoteProjectIds.has(mappedProjectId) &&
      !addedProjectIds.has(mappedProjectId)
    ) {
      mergeRows.push(...(clientProjectEventsById.get(mappedProjectId) ?? []));
      addedProjectIds.add(mappedProjectId);
    }

    const nextThreadId = remoteThreadIds.has(thread.threadId)
      ? `rescued-${Crypto.randomUUID()}`
      : thread.threadId;
    mergeRows.push(
      ...thread.events.map((event) =>
        nextThreadId === thread.threadId ? event : rewriteThreadEvent(event, nextThreadId),
      ),
    );
  }

  let nextSequence = Math.max(0, ...importedRemoteEvents.map((event) => event.sequence));
  return mergeRows
    .toSorted((left, right) => left.sequence - right.sequence)
    .map((event) => cloneEventWithSequence(event, ++nextSequence));
}
