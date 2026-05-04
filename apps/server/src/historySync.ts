import * as Crypto from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import {
  HistorySyncConfigError,
  type HistorySyncConfig,
  type HistorySyncConnectionTestResult,
  type HistorySyncMysqlFields,
  type HistorySyncProjectMappingAction,
  type HistorySyncProjectMappingCandidate,
  type HistorySyncProjectMappingLocalProject,
  type HistorySyncProjectMappingPlan,
  type HistorySyncProjectMappingsApplyInput,
  type HistorySyncStatus,
  type HistorySyncUpdateConfigInput,
  type OrchestrationEvent,
  ProjectId,
} from "@t3tools/contracts";
import { Context, Data, Duration, Effect, Layer, PubSub, Ref, Scope, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Pool, RowDataPacket } from "mysql2/promise";

import { ServerSecretStore } from "./auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "./config.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import type { ServerSettingsError } from "@t3tools/contracts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import {
  type ProjectionBootstrapProgress,
  subscribeProjectionBootstrapProgress,
} from "./orchestration/Layers/ProjectionPipeline.ts";

export const HISTORY_SYNC_CONNECTION_STRING_SECRET = "history-sync-mysql-connection-string";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const DISABLED_HISTORY_SYNC_STATUS: HistorySyncStatus = { state: "disabled", configured: false };
let latestHistorySyncStatus: HistorySyncStatus = DISABLED_HISTORY_SYNC_STATUS;
const historySyncStatusSubscribers = new Set<(status: HistorySyncStatus) => Effect.Effect<void>>();
let latestHistorySyncControl: Pick<
  HistorySyncServiceShape,
  | "getConfig"
  | "updateConfig"
  | "runSync"
  | "startInitialSync"
  | "restoreBackup"
  | "testConnection"
  | "getProjectMappings"
  | "applyProjectMappings"
> | null = null;
const defaultHistorySyncTiming = {
  intervalMs: 120_000,
  shutdownFlushTimeoutMs: 5_000,
};
const HISTORY_SYNC_MYSQL_BATCH_SIZE = 500;
const HISTORY_SYNC_SQLITE_BATCH_SIZE = 50;
const HISTORY_SYNC_OPERATION_TIMEOUT_MS = 10 * 60_000;
const HISTORY_SYNC_STARTUP_DELAY_MS = 15_000;
const HISTORY_SYNC_AUTOSAVE_DEBOUNCE_MS = 5_000;
const HISTORY_SYNC_BACKUP_FILE_NAME = "history-sync-pre-sync.sqlite";

interface HistorySyncProgress {
  readonly phase: string;
  readonly label: string;
  readonly current: number;
  readonly total: number;
}

class HistorySyncMysqlError extends Data.TaggedError("HistorySyncMysqlError")<{
  readonly cause: unknown;
}> {}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function describeSyncFailure(error: unknown): string {
  const wrappedCause =
    typeof error === "object" && error !== null && "cause" in error
      ? (error as { readonly cause?: unknown }).cause
      : undefined;
  return describeUnknownError(wrappedCause ?? error) || "History sync failed.";
}

function clampHistorySyncProgress(progress: HistorySyncProgress): HistorySyncProgress {
  const total = Math.max(1, Math.floor(progress.total));
  return {
    phase: progress.phase,
    label: progress.label,
    current: Math.min(total, Math.max(0, Math.floor(progress.current))),
    total,
  };
}

function projectionProgressLabel(progress: ProjectionBootstrapProgress): string {
  return `Projecting ${progress.projector.replace(/^projection\./, "").replace(/-/g, " ")}`;
}

function logHistorySyncStatus(status: HistorySyncStatus): void {
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

export const getHistorySyncConfig = Effect.suspend(() =>
  latestHistorySyncControl
    ? latestHistorySyncControl.getConfig
    : Effect.succeed({
        enabled: false,
        configured: false,
        status: latestHistorySyncStatus,
        intervalMs: defaultHistorySyncTiming.intervalMs,
        shutdownFlushTimeoutMs: defaultHistorySyncTiming.shutdownFlushTimeoutMs,
        statusIndicatorEnabled: true,
      } satisfies HistorySyncConfig),
);

export const updateHistorySyncConfig = (input: HistorySyncUpdateConfigInput) =>
  Effect.suspend(() =>
    latestHistorySyncControl
      ? latestHistorySyncControl.updateConfig(input)
      : Effect.fail(
          new HistorySyncConfigError({
            message: "History sync service is not ready.",
          }),
        ),
  );

export const startHistorySyncInitialImport = Effect.suspend(() =>
  latestHistorySyncControl
    ? latestHistorySyncControl.startInitialSync
    : Effect.fail(
        new HistorySyncConfigError({
          message: "History sync service is not ready.",
        }),
      ),
);

export const runHistorySync = Effect.suspend(() =>
  latestHistorySyncControl
    ? latestHistorySyncControl.runSync
    : Effect.fail(
        new HistorySyncConfigError({
          message: "History sync service is not ready.",
        }),
      ),
);

export const restoreHistorySyncBackup = Effect.suspend(() =>
  latestHistorySyncControl
    ? latestHistorySyncControl.restoreBackup
    : Effect.fail(
        new HistorySyncConfigError({
          message: "History sync service is not ready.",
        }),
      ),
);

export const testHistorySyncConnection = (input: HistorySyncMysqlFields) =>
  Effect.suspend(() =>
    latestHistorySyncControl
      ? latestHistorySyncControl.testConnection(input)
      : Effect.fail(
          new HistorySyncConfigError({
            message: "History sync service is not ready.",
          }),
        ),
  );

export const getHistorySyncProjectMappings = Effect.suspend(() =>
  latestHistorySyncControl
    ? latestHistorySyncControl.getProjectMappings
    : Effect.fail(
        new HistorySyncConfigError({
          message: "History sync service is not ready.",
        }),
      ),
);

export const applyHistorySyncProjectMappings = (input: HistorySyncProjectMappingsApplyInput) =>
  Effect.suspend(() =>
    latestHistorySyncControl
      ? latestHistorySyncControl.applyProjectMappings(input)
      : Effect.fail(
          new HistorySyncConfigError({
            message: "History sync service is not ready.",
          }),
        ),
  );

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

interface HistorySyncStateRow {
  readonly hasCompletedInitialSync: number;
  readonly lastSyncedRemoteSequence: number;
  readonly lastSuccessfulSyncAt: string | null;
  readonly clientId?: string | null;
}

interface ThreadCandidate {
  readonly threadId: string;
  readonly projectId: string | null;
  readonly hash: string | null;
  readonly events: readonly HistorySyncEventRow[];
}

interface ProjectCandidate {
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly deleted: boolean;
  readonly threadCount: number;
}

interface HistorySyncProjectMappingRow {
  readonly remoteProjectId: string;
  readonly localProjectId: string;
  readonly localWorkspaceRoot: string;
  readonly remoteWorkspaceRoot: string;
  readonly remoteTitle: string;
  readonly status: "mapped" | "skipped";
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface LocalProjectRow {
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

type HistorySyncMode = "initial" | "full" | "autosave";

export interface HistorySyncServiceShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly syncNow: Effect.Effect<void>;
  readonly runSync: Effect.Effect<HistorySyncConfig, HistorySyncConfigError | ServerSettingsError>;
  readonly getStatus: Effect.Effect<HistorySyncStatus>;
  readonly getConfig: Effect.Effect<HistorySyncConfig, ServerSettingsError>;
  readonly updateConfig: (
    input: HistorySyncUpdateConfigInput,
  ) => Effect.Effect<HistorySyncConfig, HistorySyncConfigError | ServerSettingsError>;
  readonly startInitialSync: Effect.Effect<
    HistorySyncConfig,
    HistorySyncConfigError | ServerSettingsError
  >;
  readonly restoreBackup: Effect.Effect<
    HistorySyncConfig,
    HistorySyncConfigError | ServerSettingsError
  >;
  readonly testConnection: (
    input: HistorySyncMysqlFields,
  ) => Effect.Effect<HistorySyncConnectionTestResult, HistorySyncConfigError>;
  readonly getProjectMappings: Effect.Effect<HistorySyncProjectMappingPlan, HistorySyncConfigError>;
  readonly applyProjectMappings: (
    input: HistorySyncProjectMappingsApplyInput,
  ) => Effect.Effect<HistorySyncProjectMappingPlan, HistorySyncConfigError>;
  readonly streamStatus: Stream.Stream<HistorySyncStatus>;
}

export class HistorySyncService extends Context.Service<
  HistorySyncService,
  HistorySyncServiceShape
>()("t3/historySync/HistorySyncService") {}

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

function normalizeRemoteEventsForLocalImport(
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

function rewriteLocalEventsForRemoteMappings(
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
      (event.payload.session.status === "stopped" ||
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

function insertRemoteEventBatch(
  pool: Pool,
  events: readonly HistorySyncEventRow[],
  batchIndex: number,
  batchCount: number,
) {
  if (events.length === 0) return Promise.resolve();
  const firstSequence = events[0]?.sequence ?? null;
  const lastSequence = events.at(-1)?.sequence ?? null;
  console.info("[history-sync] pushing remote batch", {
    batchIndex,
    batchCount,
    events: events.length,
    firstSequence,
    lastSequence,
  });
  const values = events.map((event) => [
    event.sequence,
    event.eventId,
    event.aggregateKind,
    event.streamId,
    event.streamVersion,
    event.eventType,
    event.occurredAt,
    event.commandId,
    event.causationEventId,
    event.correlationId,
    event.actorKind,
    event.payloadJson,
    event.metadataJson,
  ]);
  return pool.query(
    `INSERT IGNORE INTO orchestration_events
       (sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
        payload_json, metadata_json)
     VALUES ?`,
    [values],
  );
}

function validateMysqlFields(input: HistorySyncMysqlFields): HistorySyncMysqlFields {
  const host = input.host.trim();
  const database = input.database.trim();
  const username = input.username.trim();
  const password = input.password;
  if (!host) throw new Error("MySQL host is required.");
  if (!database) throw new Error("MySQL database is required.");
  if (!username) throw new Error("MySQL username is required.");
  if (!password) throw new Error("MySQL password is required.");
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error("MySQL port must be between 1 and 65535.");
  }
  return { ...input, host, database, username };
}

function buildMysqlConnectionString(input: HistorySyncMysqlFields): string {
  const validated = validateMysqlFields(input);
  const url = new URL("mysql://");
  url.hostname = validated.host;
  url.port = String(validated.port);
  url.pathname = `/${encodeURIComponent(validated.database)}`;
  url.username = validated.username;
  url.password = validated.password;
  if (validated.tlsEnabled) {
    url.searchParams.set("ssl", "{}");
  }
  return url.toString();
}

function toConnectionSummary(input: HistorySyncMysqlFields) {
  const validated = validateMysqlFields(input);
  return {
    host: validated.host,
    port: validated.port,
    database: validated.database,
    username: validated.username,
    tlsEnabled: validated.tlsEnabled,
  };
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

const MYSQL_SCHEMA = `
CREATE TABLE IF NOT EXISTS orchestration_events (
  sequence BIGINT NOT NULL PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL UNIQUE,
  aggregate_kind VARCHAR(32) NOT NULL,
  stream_id VARCHAR(255) NOT NULL,
  stream_version BIGINT NOT NULL,
  event_type VARCHAR(128) NOT NULL,
  occurred_at VARCHAR(64) NOT NULL,
  command_id VARCHAR(255) NULL,
  causation_event_id VARCHAR(255) NULL,
  correlation_id VARCHAR(255) NULL,
  actor_kind VARCHAR(32) NOT NULL,
  payload_json JSON NOT NULL,
  metadata_json JSON NOT NULL,
  UNIQUE KEY idx_orch_events_stream_version (aggregate_kind, stream_id, stream_version),
  KEY idx_orch_events_stream_sequence (aggregate_kind, stream_id, sequence),
  KEY idx_orch_events_command_id (command_id),
  KEY idx_orch_events_correlation_id (correlation_id)
)`;

export const HistorySyncServiceLive = Layer.effect(
  HistorySyncService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const secretStore = yield* ServerSecretStore;
    const settingsService = yield* ServerSettingsService;
    const engine = yield* OrchestrationEngineService;
    const serverConfig = yield* ServerConfig;
    const statusRef = yield* Ref.make<HistorySyncStatus>(DISABLED_HISTORY_SYNC_STATUS);
    const statusPubSub = yield* PubSub.unbounded<HistorySyncStatus>();
    const runningRef = yield* Ref.make(false);
    const stoppedRef = yield* Ref.make(false);
    const pendingAutosaveRef = yield* Ref.make(false);
    let syncNowEffect: Effect.Effect<void> = Effect.void;

    const publishStatus = (status: HistorySyncStatus) =>
      Effect.sync(() => {
        latestHistorySyncStatus = status;
        logHistorySyncStatus(status);
      }).pipe(
        Effect.andThen(
          Effect.all(
            [
              Ref.set(statusRef, status),
              PubSub.publish(statusPubSub, status),
              ...[...historySyncStatusSubscribers].map((subscriber) =>
                subscriber(status).pipe(Effect.ignore({ log: true })),
              ),
            ],
            { concurrency: "unbounded" },
          ),
        ),
        Effect.asVoid,
      );

    const publishSyncProgress = (input: {
      readonly startedAt: string;
      readonly lastSyncedAt: string | null;
      readonly progress: HistorySyncProgress;
    }) =>
      publishStatus({
        state: "syncing",
        configured: true,
        startedAt: input.startedAt,
        lastSyncedAt: input.lastSyncedAt,
        progress: clampHistorySyncProgress(input.progress),
      });

    const getConnectionString = Effect.gen(function* () {
      const secret = yield* secretStore.get(HISTORY_SYNC_CONNECTION_STRING_SECRET).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to read history sync connection string", {
            cause: error,
          }).pipe(Effect.as(null)),
        ),
      );
      const value = secret ? textDecoder.decode(secret).trim() : "";
      return value.length > 0 ? value : null;
    });

    const historySyncBackupPath = Path.join(
      Path.dirname(serverConfig.dbPath),
      HISTORY_SYNC_BACKUP_FILE_NAME,
    );

    const readBackupSummary = Effect.promise(async () => {
      try {
        const stat = await Fs.stat(historySyncBackupPath);
        if (!stat.isFile()) return null;
        return {
          createdAt: stat.mtime.toISOString(),
          path: historySyncBackupPath,
        };
      } catch {
        return null;
      }
    });

    const createSqliteBackup = Effect.gen(function* () {
      yield* sql`PRAGMA wal_checkpoint(FULL)`;
      yield* Effect.tryPromise({
        try: async () => {
          await Fs.mkdir(Path.dirname(historySyncBackupPath), { recursive: true });
          await Fs.copyFile(serverConfig.dbPath, historySyncBackupPath);
        },
        catch: (cause) =>
          new HistorySyncConfigError({
            message: describeUnknownError(cause) || "Failed to create history sync backup.",
          }),
      });
      console.info("[history-sync] sqlite backup created", { path: historySyncBackupPath });
    });

    const withPool = <A>(connectionString: string, use: (pool: Pool) => Promise<A>) =>
      Effect.tryPromise({
        try: async () => {
          const mysql = await import("mysql2/promise");
          const pool = mysql.createPool(connectionString);
          try {
            return await use(pool);
          } finally {
            await pool.end();
          }
        },
        catch: (cause) => new HistorySyncMysqlError({ cause }),
      });

    const ensureRemoteSchema = (pool: Pool) => pool.query(MYSQL_SCHEMA);

    const testConnectionString = (connectionString: string) =>
      withPool(connectionString, async (pool) => {
        await ensureRemoteSchema(pool);
        await pool.query("SELECT 1");
      });

    const toConfig = Effect.gen(function* () {
      const [settings, connectionString, status, state, backup] = yield* Effect.all([
        settingsService.getSettings,
        getConnectionString,
        Ref.get(statusRef),
        readState.pipe(Effect.catch(() => Effect.succeed(null))),
        readBackupSummary,
      ]);
      const effectiveStatus =
        connectionString !== null &&
        state?.hasCompletedInitialSync !== 1 &&
        status.state !== "syncing" &&
        status.state !== "needs-project-mapping" &&
        status.state !== "error"
          ? ({
              state: "needs-initial-sync",
              configured: true,
              lastSyncedAt: state?.lastSuccessfulSyncAt ?? null,
            } satisfies HistorySyncStatus)
          : status;
      return {
        enabled: settings.historySync.enabled,
        configured: connectionString !== null,
        status: {
          ...effectiveStatus,
          configured: connectionString !== null,
        },
        intervalMs: settings.historySync.intervalMs,
        shutdownFlushTimeoutMs: settings.historySync.shutdownFlushTimeoutMs,
        statusIndicatorEnabled: settings.historySync.statusIndicatorEnabled,
        ...(settings.historySync.connectionSummary
          ? { connectionSummary: settings.historySync.connectionSummary }
          : {}),
        ...(backup ? { backup } : {}),
      } satisfies HistorySyncConfig;
    });

    const testConnection: HistorySyncServiceShape["testConnection"] = (mysql) =>
      Effect.try({
        try: () => buildMysqlConnectionString(mysql),
        catch: (cause) => new HistorySyncConfigError({ message: describeUnknownError(cause) }),
      }).pipe(
        Effect.flatMap((connectionString) => testConnectionString(connectionString)),
        Effect.as({ success: true } satisfies HistorySyncConnectionTestResult),
        Effect.catch((cause) =>
          Effect.succeed({
            success: false,
            message: describeSyncFailure(cause),
          } satisfies HistorySyncConnectionTestResult),
        ),
      );

    const updateConfig: HistorySyncServiceShape["updateConfig"] = (input) =>
      Effect.gen(function* () {
        if (input.clearConnection && input.mysql) {
          return yield* new HistorySyncConfigError({
            message: "Cannot clear and update the MySQL connection in the same request.",
          });
        }

        let connectionSummary = undefined as ReturnType<typeof toConnectionSummary> | undefined;
        let connectionString = null as string | null;
        if (input.mysql) {
          try {
            connectionString = buildMysqlConnectionString(input.mysql);
            connectionSummary = toConnectionSummary(input.mysql);
          } catch (cause) {
            return yield* new HistorySyncConfigError({
              message: describeUnknownError(cause),
            });
          }

          const testResult = yield* testConnectionString(connectionString).pipe(
            Effect.as({ success: true } satisfies HistorySyncConnectionTestResult),
            Effect.catch((cause) =>
              Effect.succeed({
                success: false,
                message: describeSyncFailure(cause),
              } satisfies HistorySyncConnectionTestResult),
            ),
          );
          if (!testResult.success) {
            return yield* new HistorySyncConfigError({
              message: testResult.message ?? "MySQL connection test failed.",
            });
          }
        }

        if (connectionString !== null) {
          yield* secretStore
            .set(HISTORY_SYNC_CONNECTION_STRING_SECRET, textEncoder.encode(connectionString))
            .pipe(
              Effect.mapError(
                (_cause) =>
                  new HistorySyncConfigError({
                    message: "Failed to store MySQL connection secret.",
                  }),
              ),
            );
          yield* Ref.set(stoppedRef, false);
        } else if (input.clearConnection) {
          yield* secretStore.remove(HISTORY_SYNC_CONNECTION_STRING_SECRET).pipe(
            Effect.mapError(
              (_cause) =>
                new HistorySyncConfigError({
                  message: "Failed to clear MySQL connection secret.",
                }),
            ),
          );
          yield* Ref.set(stoppedRef, false);
        }

        const current = yield* settingsService.getSettings;
        const nextHistorySync = {
          ...current.historySync,
          ...input.settings,
          ...(connectionSummary ? { connectionSummary } : {}),
          ...(input.clearConnection ? { connectionSummary: null } : {}),
        };
        yield* settingsService.updateSettings({
          historySync: nextHistorySync,
        });

        const syncEnabled = input.settings?.enabled ?? current.historySync.enabled;
        const nextConnectionString =
          connectionString !== null ? connectionString : yield* getConnectionString;
        if (syncEnabled && nextConnectionString !== null) {
          const state = yield* readState.pipe(
            Effect.mapError(
              (cause) =>
                new HistorySyncConfigError({
                  message: describeSyncFailure(cause),
                }),
            ),
          );
          yield* Ref.set(stoppedRef, false);
          if (state?.hasCompletedInitialSync !== 1) {
            yield* publishStatus({
              state: "needs-initial-sync",
              configured: true,
              lastSyncedAt: state?.lastSuccessfulSyncAt ?? null,
            });
          } else {
            yield* publishStatus({
              state: "idle",
              configured: true,
              lastSyncedAt: state?.lastSuccessfulSyncAt ?? null,
            });
          }
        } else if (nextConnectionString !== null) {
          const state = yield* readState.pipe(
            Effect.mapError(
              (cause) =>
                new HistorySyncConfigError({
                  message: describeSyncFailure(cause),
                }),
            ),
          );
          if (state?.hasCompletedInitialSync === 1) {
            yield* publishStatus({
              state: "disabled",
              configured: true,
            });
          } else {
            yield* publishStatus({
              state: "needs-initial-sync",
              configured: true,
              lastSyncedAt: state?.lastSuccessfulSyncAt ?? null,
            });
          }
        } else {
          yield* publishStatus({
            state: "disabled",
            configured: false,
          });
        }
        return yield* toConfig;
      });

    const readRemoteEvents = (connectionString: string, sequenceExclusive = 0) =>
      withPool(connectionString, async (pool) => {
        await ensureRemoteSchema(pool);
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
                  occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
                  JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$')) AS payload_json,
                  JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$')) AS metadata_json
           FROM orchestration_events
           WHERE sequence > ?
           ORDER BY sequence ASC`,
          [sequenceExclusive],
        );
        return rows.map((row) => ({
          sequence: Number(row.sequence),
          eventId: String(row.event_id),
          aggregateKind: row.aggregate_kind as "project" | "thread",
          streamId: String(row.stream_id),
          streamVersion: Number(row.stream_version),
          eventType: row.event_type as OrchestrationEvent["type"],
          occurredAt: String(row.occurred_at),
          commandId: row.command_id === null ? null : String(row.command_id),
          causationEventId: row.causation_event_id === null ? null : String(row.causation_event_id),
          correlationId: row.correlation_id === null ? null : String(row.correlation_id),
          actorKind: String(row.actor_kind),
          payloadJson:
            typeof row.payload_json === "string"
              ? row.payload_json
              : JSON.stringify(row.payload_json),
          metadataJson:
            typeof row.metadata_json === "string"
              ? row.metadata_json
              : JSON.stringify(row.metadata_json),
        })) satisfies HistorySyncEventRow[];
      });

    const readRemoteMaxSequence = (connectionString: string) =>
      withPool(connectionString, async (pool) => {
        await ensureRemoteSchema(pool);
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM orchestration_events`,
        );
        return Number(rows[0]?.max_sequence ?? 0);
      });

    const getProjectMappings: HistorySyncServiceShape["getProjectMappings"] = Effect.gen(
      function* () {
        const connectionString = yield* getConnectionString;
        if (connectionString === null) {
          return yield* new HistorySyncConfigError({
            message: "History sync MySQL connection is not configured.",
          });
        }
        const remoteEvents = yield* readRemoteEvents(connectionString).pipe(
          Effect.mapError(
            (cause) =>
              new HistorySyncConfigError({
                message: describeSyncFailure(cause),
              }),
          ),
        );
        const remoteMaxSequence = Math.max(0, ...remoteEvents.map((event) => event.sequence));
        const plan = yield* buildProjectMappingPlanFromEvents({
          remoteEvents,
          remoteMaxSequence,
        });
        yield* autoPersistExactProjectMappings(plan);
        return yield* buildProjectMappingPlanFromEvents({
          remoteEvents,
          remoteMaxSequence,
        });
      },
    ).pipe(
      Effect.mapError(
        (cause) => new HistorySyncConfigError({ message: describeSyncFailure(cause) }),
      ),
    );

    const applyProjectMappings: HistorySyncServiceShape["applyProjectMappings"] = (input) =>
      Effect.gen(function* () {
        const connectionString = yield* getConnectionString;
        if (connectionString === null) {
          return yield* new HistorySyncConfigError({
            message: "History sync MySQL connection is not configured.",
          });
        }
        const remoteEvents = yield* readRemoteEvents(connectionString).pipe(
          Effect.mapError(
            (cause) =>
              new HistorySyncConfigError({
                message: describeSyncFailure(cause),
              }),
          ),
        );
        const remoteMaxSequence = Math.max(0, ...remoteEvents.map((event) => event.sequence));
        const expectedSyncId = yield* getSyncId(remoteMaxSequence);
        if (input.syncId !== expectedSyncId) {
          return yield* new HistorySyncConfigError({
            message: "History sync mapping plan is stale. Reload the project mapping wizard.",
          });
        }

        const remoteProjectById = new Map(
          collectProjectCandidates(remoteEvents).map((project) => [project.projectId, project]),
        );
        const localProjects = yield* readLocalProjects;
        const now = new Date().toISOString();
        yield* Effect.forEach(
          input.actions,
          (action) => {
            const remoteProject = remoteProjectById.get(action.remoteProjectId);
            if (!remoteProject) {
              return Effect.fail(
                new HistorySyncConfigError({
                  message: `Unknown remote project '${action.remoteProjectId}'.`,
                }),
              );
            }
            return applyMappingAction({ action, remoteProject, localProjects, now });
          },
          { concurrency: 1 },
        );
        yield* Ref.set(stoppedRef, false);
        const state = yield* readState;
        if (state?.hasCompletedInitialSync === 1) {
          yield* syncNowEffect;
        } else {
          yield* startInitialSync;
        }
        return yield* buildProjectMappingPlanFromEvents({ remoteEvents, remoteMaxSequence });
      }).pipe(
        Effect.mapError(
          (cause) => new HistorySyncConfigError({ message: describeSyncFailure(cause) }),
        ),
      );

    const pushEventsBatched = (connectionString: string, events: readonly HistorySyncEventRow[]) =>
      withPool(connectionString, async (pool) => {
        await ensureRemoteSchema(pool);
        if (events.length === 0) return;
        const batches = chunkHistorySyncEvents(events);
        const firstSequence = events[0]?.sequence ?? null;
        const lastSequence = events.at(-1)?.sequence ?? null;
        console.info("[history-sync] pushing remote history", {
          events: events.length,
          batches: batches.length,
          firstSequence,
          lastSequence,
        });
        for (let index = 0; index < batches.length; index++) {
          await insertRemoteEventBatch(pool, batches[index] ?? [], index + 1, batches.length);
        }
      });

    const readLocalEvents = (sequenceExclusive = 0) =>
      sql<HistorySyncEventRow>`
        SELECT
          sequence,
          event_id AS "eventId",
          aggregate_kind AS "aggregateKind",
          stream_id AS "streamId",
          stream_version AS "streamVersion",
          event_type AS "eventType",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          actor_kind AS "actorKind",
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE sequence > ${sequenceExclusive}
        ORDER BY sequence ASC
      `;

    const readUnpushedLocalEvents = sql<HistorySyncEventRow>`
      SELECT
        event.sequence,
        event.event_id AS "eventId",
        event.aggregate_kind AS "aggregateKind",
        event.stream_id AS "streamId",
        event.stream_version AS "streamVersion",
        event.event_type AS "eventType",
        event.occurred_at AS "occurredAt",
        event.command_id AS "commandId",
        event.causation_event_id AS "causationEventId",
        event.correlation_id AS "correlationId",
        event.actor_kind AS "actorKind",
        event.payload_json AS "payloadJson",
        event.metadata_json AS "metadataJson"
      FROM orchestration_events AS event
      LEFT JOIN history_sync_pushed_events AS receipt
        ON receipt.sequence = event.sequence
      WHERE receipt.sequence IS NULL
      ORDER BY event.sequence ASC
    `;

    const readProjectionThreadAutosyncRows = sql<HistorySyncAutosyncProjectionThreadRow>`
      SELECT
        thread.thread_id AS "threadId",
        thread.pending_user_input_count AS "pendingUserInputCount",
        thread.has_actionable_proposed_plan AS "hasActionableProposedPlan",
        thread.latest_turn_id AS "latestTurnId",
        session.status AS "sessionStatus",
        session.active_turn_id AS "sessionActiveTurnId"
      FROM projection_threads AS thread
      LEFT JOIN projection_thread_sessions AS session
        ON session.thread_id = thread.thread_id
      WHERE thread.deleted_at IS NULL
    `;

    const writePushedEventReceipts = (events: readonly HistorySyncEventRow[], pushedAt: string) =>
      Effect.gen(function* () {
        if (events.length === 0) return;
        const batches = chunkHistorySyncEvents(events, HISTORY_SYNC_SQLITE_BATCH_SIZE);
        yield* Effect.forEach(
          batches,
          (batch) =>
            sql`
              INSERT INTO history_sync_pushed_events ${sql.insert(
                buildPushedEventReceiptRows(batch, pushedAt).map((receipt) => ({
                  sequence: receipt.sequence,
                  event_id: receipt.eventId,
                  stream_id: receipt.streamId,
                  event_type: receipt.eventType,
                  pushed_at: receipt.pushedAt,
                })),
              )}
              ON CONFLICT (sequence) DO UPDATE SET
                event_id = excluded.event_id,
                stream_id = excluded.stream_id,
                event_type = excluded.event_type,
                pushed_at = excluded.pushed_at
            `,
          { concurrency: 1 },
        );
      });

    const readPushedEventReceiptCount = Effect.gen(function* () {
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM history_sync_pushed_events
      `;
      return Number(rows[0]?.count ?? 0);
    });

    const seedPushedEventReceiptsForCompletedSync = (
      events: readonly HistorySyncEventRow[],
      input: {
        readonly hasCompletedInitialSync: boolean;
        readonly lastSyncedRemoteSequence: number;
        readonly seededAt: string;
      },
    ) =>
      Effect.gen(function* () {
        if (!input.hasCompletedInitialSync || input.lastSyncedRemoteSequence <= 0) return;
        const receiptCount = yield* readPushedEventReceiptCount;
        const alreadySyncedEvents = selectPushedReceiptSeedEvents({
          events,
          hasCompletedInitialSync: input.hasCompletedInitialSync,
          hasExistingReceipts: receiptCount > 0,
          lastSyncedRemoteSequence: input.lastSyncedRemoteSequence,
        });
        if (alreadySyncedEvents.length === 0) return;
        console.info("[history-sync] seeding local pushed event receipts", {
          events: alreadySyncedEvents.length,
          lastSyncedRemoteSequence: input.lastSyncedRemoteSequence,
        });
        yield* writePushedEventReceipts(alreadySyncedEvents, input.seededAt);
      });

    const readLocalProjectionCounts = Effect.gen(function* () {
      const rows = yield* sql<{
        readonly projectCount: number;
        readonly threadCount: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM projection_projects WHERE deleted_at IS NULL) AS "projectCount",
          (SELECT COUNT(*) FROM projection_threads WHERE deleted_at IS NULL) AS "threadCount"
      `;
      return {
        projectCount: Number(rows[0]?.projectCount ?? 0),
        threadCount: Number(rows[0]?.threadCount ?? 0),
      };
    });

    const readState = Effect.gen(function* () {
      const rows = yield* sql<HistorySyncStateRow>`
        SELECT
          has_completed_initial_sync AS "hasCompletedInitialSync",
          last_synced_remote_sequence AS "lastSyncedRemoteSequence",
          last_successful_sync_at AS "lastSuccessfulSyncAt",
          client_id AS "clientId"
        FROM history_sync_state
        WHERE id = 1
        LIMIT 1
      `;
      return rows[0] ?? null;
    });

    const ensureClientId = Effect.gen(function* () {
      const state = yield* readState;
      if (state?.clientId && state.clientId.length > 0) {
        return state.clientId;
      }
      const clientId = Crypto.randomUUID();
      yield* sql`
        INSERT INTO history_sync_state (
          id,
          client_id,
          has_completed_initial_sync,
          last_synced_remote_sequence,
          last_successful_sync_at
        )
        VALUES (
          1,
          ${clientId},
          ${state?.hasCompletedInitialSync ?? 0},
          ${state?.lastSyncedRemoteSequence ?? 0},
          ${state?.lastSuccessfulSyncAt ?? null}
        )
        ON CONFLICT (id) DO UPDATE SET
          client_id = excluded.client_id
      `;
      return clientId;
    });

    const writeState = (input: {
      readonly hasCompletedInitialSync: boolean;
      readonly lastSyncedRemoteSequence: number;
      readonly lastSuccessfulSyncAt: string;
    }) =>
      Effect.gen(function* () {
        const clientId = yield* ensureClientId;
        yield* sql`
        INSERT INTO history_sync_state (
          id,
          client_id,
          has_completed_initial_sync,
          last_synced_remote_sequence,
          last_successful_sync_at
        )
        VALUES (
          1,
          ${clientId},
          ${input.hasCompletedInitialSync ? 1 : 0},
          ${input.lastSyncedRemoteSequence},
          ${input.lastSuccessfulSyncAt}
        )
        ON CONFLICT (id) DO UPDATE SET
          client_id = history_sync_state.client_id,
          has_completed_initial_sync = excluded.has_completed_initial_sync,
          last_synced_remote_sequence = excluded.last_synced_remote_sequence,
          last_successful_sync_at = excluded.last_successful_sync_at
      `;
      });

    const publishConfiguredStartupStatus = Effect.gen(function* () {
      const [settings, connectionString, state] = yield* Effect.all([
        settingsService.getSettings,
        getConnectionString,
        readState.pipe(Effect.catch(() => Effect.succeed(null))),
      ]);
      const hasCompletedInitialSync = state?.hasCompletedInitialSync === 1;
      if (
        !shouldRunAutomaticHistorySync({
          enabled: settings.historySync.enabled,
          configured: connectionString !== null,
          hasCompletedInitialSync,
        })
      ) {
        if (connectionString !== null && !hasCompletedInitialSync) {
          yield* publishStatus({
            state: "needs-initial-sync",
            configured: true,
            lastSyncedAt: state?.lastSuccessfulSyncAt ?? null,
          });
          return false;
        }
        yield* publishStatus({
          state: "disabled",
          configured: connectionString !== null,
        });
        return false;
      }
      return true;
    });

    const insertLocalEvents = (events: readonly HistorySyncEventRow[]) =>
      Effect.gen(function* () {
        if (events.length === 0) return;
        const batches = chunkHistorySyncEvents(events, HISTORY_SYNC_SQLITE_BATCH_SIZE);
        yield* Effect.forEach(
          batches,
          (batch) => {
            return sql`
              INSERT INTO orchestration_events ${sql.insert(
                batch.map((event) => ({
                  sequence: event.sequence,
                  event_id: event.eventId,
                  aggregate_kind: event.aggregateKind,
                  stream_id: event.streamId,
                  stream_version: event.streamVersion,
                  event_type: event.eventType,
                  occurred_at: event.occurredAt,
                  command_id: event.commandId,
                  causation_event_id: event.causationEventId,
                  correlation_id: event.correlationId,
                  actor_kind: event.actorKind,
                  payload_json: event.payloadJson,
                  metadata_json: event.metadataJson,
                })),
              )}
            `;
          },
          { concurrency: 1 },
        );
      });

    const readProjectMappings = sql<HistorySyncProjectMappingRow>`
      SELECT
        remote_project_id AS "remoteProjectId",
        local_project_id AS "localProjectId",
        local_workspace_root AS "localWorkspaceRoot",
        remote_workspace_root AS "remoteWorkspaceRoot",
        remote_title AS "remoteTitle",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM history_sync_project_mappings
      ORDER BY remote_project_id ASC
    `;

    const readLocalProjects = sql<LocalProjectRow>`
      SELECT
        project_id AS "projectId",
        title,
        workspace_root AS "workspaceRoot"
      FROM projection_projects
      WHERE deleted_at IS NULL
      ORDER BY created_at ASC, project_id ASC
    `;

    const writeProjectMapping = (input: {
      readonly remoteProjectId: string;
      readonly localProjectId: string;
      readonly localWorkspaceRoot: string;
      readonly remoteWorkspaceRoot: string;
      readonly remoteTitle: string;
      readonly status: "mapped" | "skipped";
      readonly now: string;
    }) =>
      sql`
        INSERT INTO history_sync_project_mappings (
          remote_project_id,
          local_project_id,
          local_workspace_root,
          remote_workspace_root,
          remote_title,
          status,
          created_at,
          updated_at
        )
        VALUES (
          ${input.remoteProjectId},
          ${input.localProjectId},
          ${input.localWorkspaceRoot},
          ${input.remoteWorkspaceRoot},
          ${input.remoteTitle},
          ${input.status},
          ${input.now},
          ${input.now}
        )
        ON CONFLICT (remote_project_id) DO UPDATE SET
          local_project_id = excluded.local_project_id,
          local_workspace_root = excluded.local_workspace_root,
          remote_workspace_root = excluded.remote_workspace_root,
          remote_title = excluded.remote_title,
          status = excluded.status,
          updated_at = excluded.updated_at
      `.pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new HistorySyncConfigError({
              message: describeSyncFailure(cause),
            }),
        ),
      );

    const getSyncId = (remoteMaxSequence: number) =>
      ensureClientId.pipe(Effect.map((clientId) => `${clientId}:${remoteMaxSequence}`));

    const findSuggestion = (
      remoteProject: ProjectCandidate,
      localProjects: readonly LocalProjectRow[],
    ): {
      readonly project: LocalProjectRow;
      readonly reason: "exact-path" | "basename";
    } | null => {
      const exact = localProjects.find(
        (project) => project.workspaceRoot === remoteProject.workspaceRoot,
      );
      if (exact) return { project: exact, reason: "exact-path" };

      const remoteBasename = Path.basename(remoteProject.workspaceRoot.replace(/\\/g, "/"));
      const basenameMatches = localProjects.filter(
        (project) => Path.basename(project.workspaceRoot.replace(/\\/g, "/")) === remoteBasename,
      );
      if (basenameMatches.length === 1 && basenameMatches[0]) {
        return { project: basenameMatches[0], reason: "basename" };
      }

      return null;
    };

    const buildProjectMappingPlanFromEvents = Effect.fn(
      "HistorySync.buildProjectMappingPlanFromEvents",
    )(function* (input: {
      readonly remoteEvents: readonly HistorySyncEventRow[];
      readonly remoteMaxSequence: number;
    }) {
      const [mappings, localProjects, syncId] = yield* Effect.all([
        readProjectMappings,
        readLocalProjects,
        getSyncId(input.remoteMaxSequence),
      ]);
      const mappingByRemote = new Map(
        mappings.map((mapping) => [mapping.remoteProjectId, mapping]),
      );
      const activeRemoteProjects = collectProjectCandidates(input.remoteEvents).filter(
        (project) => project.threadCount > 0,
      );
      const candidates: HistorySyncProjectMappingCandidate[] = [];

      for (const remoteProject of activeRemoteProjects) {
        const saved = mappingByRemote.get(remoteProject.projectId);
        if (saved) {
          candidates.push({
            remoteProjectId: ProjectId.make(remoteProject.projectId),
            remoteTitle: remoteProject.title,
            remoteWorkspaceRoot: remoteProject.workspaceRoot,
            threadCount: remoteProject.threadCount,
            suggestedLocalProjectId: ProjectId.make(saved.localProjectId),
            suggestedLocalWorkspaceRoot: saved.localWorkspaceRoot,
            status: "mapped",
          });
          continue;
        }

        const suggestion = findSuggestion(remoteProject, localProjects);
        candidates.push({
          remoteProjectId: ProjectId.make(remoteProject.projectId),
          remoteTitle: remoteProject.title,
          remoteWorkspaceRoot: remoteProject.workspaceRoot,
          threadCount: remoteProject.threadCount,
          ...(suggestion
            ? {
                suggestedLocalProjectId: ProjectId.make(suggestion.project.projectId),
                suggestedLocalWorkspaceRoot: suggestion.project.workspaceRoot,
                suggestionReason: suggestion.reason,
              }
            : {}),
          status: suggestion?.reason === "exact-path" ? "mapped" : "unresolved",
        });
      }

      return {
        syncId,
        remoteMaxSequence: input.remoteMaxSequence,
        candidates,
        localProjects: localProjects.map(
          (project): HistorySyncProjectMappingLocalProject => ({
            projectId: ProjectId.make(project.projectId),
            title: project.title,
            workspaceRoot: project.workspaceRoot,
          }),
        ),
      } satisfies HistorySyncProjectMappingPlan;
    });

    const autoPersistExactProjectMappings = Effect.fn(
      "HistorySync.autoPersistExactProjectMappings",
    )(function* (plan: HistorySyncProjectMappingPlan) {
      const now = new Date().toISOString();
      yield* Effect.forEach(
        plan.candidates,
        (candidate) => {
          if (
            candidate.status !== "mapped" ||
            candidate.suggestionReason !== "exact-path" ||
            !candidate.suggestedLocalProjectId ||
            !candidate.suggestedLocalWorkspaceRoot
          ) {
            return Effect.void;
          }
          return writeProjectMapping({
            remoteProjectId: candidate.remoteProjectId,
            localProjectId: candidate.suggestedLocalProjectId,
            localWorkspaceRoot: candidate.suggestedLocalWorkspaceRoot,
            remoteWorkspaceRoot: candidate.remoteWorkspaceRoot,
            remoteTitle: candidate.remoteTitle,
            status: "mapped",
            now,
          });
        },
        { concurrency: 1 },
      );
    });

    const applyMappingAction = (input: {
      readonly action: HistorySyncProjectMappingAction;
      readonly remoteProject: ProjectCandidate;
      readonly localProjects: readonly LocalProjectRow[];
      readonly now: string;
    }) => {
      const action = input.action;
      if (action.action === "skip") {
        return writeProjectMapping({
          remoteProjectId: input.remoteProject.projectId,
          localProjectId: input.remoteProject.projectId,
          localWorkspaceRoot: input.remoteProject.workspaceRoot,
          remoteWorkspaceRoot: input.remoteProject.workspaceRoot,
          remoteTitle: input.remoteProject.title,
          status: "skipped",
          now: input.now,
        });
      }
      if (action.action === "map-existing") {
        const localProject = input.localProjects.find(
          (project) => project.projectId === action.localProjectId,
        );
        if (!localProject) {
          return Effect.fail(
            new HistorySyncConfigError({
              message: `Unknown local project '${action.localProjectId}'.`,
            }),
          );
        }
        return writeProjectMapping({
          remoteProjectId: input.remoteProject.projectId,
          localProjectId: localProject.projectId,
          localWorkspaceRoot: localProject.workspaceRoot,
          remoteWorkspaceRoot: input.remoteProject.workspaceRoot,
          remoteTitle: input.remoteProject.title,
          status: "mapped",
          now: input.now,
        });
      }
      const localProjectId = Crypto.randomUUID();
      return writeProjectMapping({
        remoteProjectId: input.remoteProject.projectId,
        localProjectId,
        localWorkspaceRoot: action.workspaceRoot,
        remoteWorkspaceRoot: input.remoteProject.workspaceRoot,
        remoteTitle: action.title ?? input.remoteProject.title,
        status: "mapped",
        now: input.now,
      });
    };

    const clearLocalHistory = Effect.all(
      [
        sql`DELETE FROM orchestration_command_receipts`,
        sql`DELETE FROM projection_pending_approvals`,
        sql`DELETE FROM projection_turns`,
        sql`DELETE FROM projection_thread_sessions`,
        sql`DELETE FROM projection_thread_activities`,
        sql`DELETE FROM projection_thread_proposed_plans`,
        sql`DELETE FROM projection_thread_messages`,
        sql`DELETE FROM projection_threads`,
        sql`DELETE FROM projection_projects`,
        sql`DELETE FROM projection_state`,
        sql`DELETE FROM checkpoint_diff_blobs`,
        sql`DELETE FROM history_sync_pushed_events`,
        sql`DELETE FROM orchestration_events`,
      ],
      { concurrency: 1 },
    );

    const importRemoteEvents = (events: readonly HistorySyncEventRow[]) =>
      sql.withTransaction(
        clearLocalHistory.pipe(
          Effect.andThen(insertLocalEvents(events)),
          Effect.andThen(sql`DELETE FROM projection_state`),
        ),
      );

    const importRemoteDeltaEvents = (events: readonly HistorySyncEventRow[]) =>
      sql.withTransaction(insertLocalEvents(events));

    const restoreBackupTables = sql.withTransaction(
      Effect.all(
        [
          sql`DELETE FROM orchestration_command_receipts`,
          sql`DELETE FROM projection_pending_approvals`,
          sql`DELETE FROM projection_turns`,
          sql`DELETE FROM projection_thread_sessions`,
          sql`DELETE FROM projection_thread_activities`,
          sql`DELETE FROM projection_thread_proposed_plans`,
          sql`DELETE FROM projection_thread_messages`,
          sql`DELETE FROM projection_threads`,
          sql`DELETE FROM projection_projects`,
          sql`DELETE FROM projection_state`,
          sql`DELETE FROM checkpoint_diff_blobs`,
          sql`DELETE FROM history_sync_pushed_events`,
          sql`DELETE FROM orchestration_events`,
          sql`DELETE FROM history_sync_project_mappings`,
          sql`DELETE FROM history_sync_state`,
          sql`
            INSERT INTO orchestration_command_receipts
            SELECT * FROM history_sync_backup.orchestration_command_receipts
          `,
          sql`
            INSERT INTO projection_pending_approvals
            SELECT * FROM history_sync_backup.projection_pending_approvals
          `,
          sql`
            INSERT INTO projection_turns
            SELECT * FROM history_sync_backup.projection_turns
          `,
          sql`
            INSERT INTO projection_thread_sessions
            SELECT * FROM history_sync_backup.projection_thread_sessions
          `,
          sql`
            INSERT INTO projection_thread_activities
            SELECT * FROM history_sync_backup.projection_thread_activities
          `,
          sql`
            INSERT INTO projection_thread_proposed_plans
            SELECT * FROM history_sync_backup.projection_thread_proposed_plans
          `,
          sql`
            INSERT INTO projection_thread_messages
            SELECT * FROM history_sync_backup.projection_thread_messages
          `,
          sql`
            INSERT INTO projection_threads
            SELECT * FROM history_sync_backup.projection_threads
          `,
          sql`
            INSERT INTO projection_projects
            SELECT * FROM history_sync_backup.projection_projects
          `,
          sql`
            INSERT INTO projection_state
            SELECT * FROM history_sync_backup.projection_state
          `,
          sql`
            INSERT INTO checkpoint_diff_blobs
            SELECT * FROM history_sync_backup.checkpoint_diff_blobs
          `,
          sql`
            INSERT INTO history_sync_pushed_events
            SELECT * FROM history_sync_backup.history_sync_pushed_events
          `,
          sql`
            INSERT INTO orchestration_events
            SELECT * FROM history_sync_backup.orchestration_events
          `,
          sql`
            INSERT INTO history_sync_project_mappings
            SELECT * FROM history_sync_backup.history_sync_project_mappings
          `,
          sql`
            INSERT INTO history_sync_state
            SELECT * FROM history_sync_backup.history_sync_state
          `,
        ],
        { concurrency: 1 },
      ),
    );

    const restoreBackupFromDisk = Effect.gen(function* () {
      const backup = yield* readBackupSummary;
      if (!backup) {
        return yield* new HistorySyncConfigError({
          message: "No history sync SQLite backup is available.",
        });
      }
      yield* sql`ATTACH DATABASE ${historySyncBackupPath} AS history_sync_backup`;
      yield* restoreBackupTables.pipe(
        Effect.ensuring(sql`DETACH DATABASE history_sync_backup`.pipe(Effect.ignore)),
      );
      if (engine.reloadFromStorage) {
        yield* engine.reloadFromStorage();
      }
      const restoredState = yield* readState.pipe(Effect.catch(() => Effect.succeed(null)));
      const connectionString = yield* getConnectionString;
      yield* publishStatus(
        connectionString !== null && restoredState?.hasCompletedInitialSync !== 1
          ? {
              state: "needs-initial-sync",
              configured: true,
              lastSyncedAt: restoredState?.lastSuccessfulSyncAt ?? null,
            }
          : {
              state: "idle",
              configured: connectionString !== null,
              lastSyncedAt: restoredState?.lastSuccessfulSyncAt ?? null,
            },
      );
      console.info("[history-sync] sqlite backup restored", { path: historySyncBackupPath });
    }).pipe(
      Effect.catchTag("HistorySyncConfigError", (cause) => Effect.fail(cause)),
      Effect.mapError(
        (cause) =>
          new HistorySyncConfigError({
            message: describeSyncFailure(cause),
          }),
      ),
    );

    const runImport = (
      events: readonly HistorySyncEventRow[],
      context: {
        readonly startedAt: string;
        readonly lastSyncedAt: string | null;
      },
      options: { readonly mode?: "replace" | "delta" } = {},
    ) =>
      Effect.gen(function* () {
        yield* publishSyncProgress({
          ...context,
          progress: {
            phase: "importing",
            label: "Importing history",
            current: 0,
            total: Math.max(1, events.length),
          },
        });
        yield* options.mode === "delta"
          ? importRemoteDeltaEvents(events)
          : importRemoteEvents(events);
        if (engine.reloadFromStorage) {
          const unsubscribe = yield* subscribeProjectionBootstrapProgress((progress) =>
            publishSyncProgress({
              ...context,
              progress: {
                phase: "projecting",
                label: projectionProgressLabel(progress),
                current: progress.projectedCount,
                total: Math.max(1, progress.maxSequence),
              },
            }),
          );
          yield* engine.reloadFromStorage().pipe(Effect.ensuring(Effect.sync(unsubscribe)));
        }
        const projectionCounts = yield* readLocalProjectionCounts;
        console.info("[history-sync] local import projected", {
          importedEvents: events.length,
          importedThreadCreates: events.filter((event) => event.eventType === "thread.created")
            .length,
          projectionCounts,
        });
      });

    const performSync = (options: {
      readonly mode: HistorySyncMode;
      readonly autosaveMaxSequence?: number;
    }): Effect.Effect<void> =>
      Effect.gen(function* () {
        const settings = yield* settingsService.getSettings;
        const connectionString = yield* getConnectionString;
        const state = yield* readState;
        const hasCompletedInitialSync = state?.hasCompletedInitialSync === 1;
        const isInitialSync = options.mode === "initial";
        const isAutosave = options.mode === "autosave";
        if (
          connectionString === null ||
          (!settings.historySync.enabled && !(isInitialSync && !hasCompletedInitialSync))
        ) {
          yield* publishStatus({
            state: "disabled",
            configured: connectionString !== null,
          });
          return;
        }

        const previousStatus = yield* Ref.get(statusRef);
        const lastSyncedAt =
          previousStatus.state === "idle" ||
          previousStatus.state === "syncing" ||
          previousStatus.state === "error" ||
          previousStatus.state === "needs-project-mapping" ||
          previousStatus.state === "needs-initial-sync"
            ? previousStatus.lastSyncedAt
            : null;
        const syncStartedAt = new Date().toISOString();
        const syncContext = { startedAt: syncStartedAt, lastSyncedAt };
        yield* publishStatus({
          state: "syncing",
          configured: true,
          startedAt: syncStartedAt,
          lastSyncedAt,
        });

        const localEvents = yield* readLocalEvents();
        const localProjectionCounts = yield* readLocalProjectionCounts;
        const localMaxSequence = Math.max(0, ...localEvents.map((event) => event.sequence));
        const lastSyncedRemoteSequence = state?.lastSyncedRemoteSequence ?? 0;
        yield* seedPushedEventReceiptsForCompletedSync(localEvents, {
          hasCompletedInitialSync,
          lastSyncedRemoteSequence,
          seededAt: syncStartedAt,
        });
        if (!hasCompletedInitialSync && !isInitialSync) {
          yield* publishStatus({
            state: "needs-initial-sync",
            configured: true,
            lastSyncedAt: state?.lastSuccessfulSyncAt ?? lastSyncedAt,
          });
          return;
        }
        if (!hasCompletedInitialSync && isInitialSync) {
          yield* createSqliteBackup;
        }

        if (isAutosave) {
          const remoteMaxSequence = yield* readRemoteMaxSequence(connectionString);
          let autosaveLastSyncedAt = lastSyncedAt;
          if (remoteMaxSequence > lastSyncedRemoteSequence) {
            const remoteDeltaEvents = yield* readRemoteEvents(
              connectionString,
              lastSyncedRemoteSequence,
            );
            const unknownRemoteDeltaEvents = selectUnknownRemoteDeltaEvents({
              remoteEvents: remoteDeltaEvents,
              localEvents,
            });
            if (unknownRemoteDeltaEvents.length > 0) {
              const message =
                "Remote history has newer events from another device. Run Sync now to import them before autosave.";
              console.warn("[history-sync] autosave skipped because remote has unknown events", {
                remoteMaxSequence,
                lastSyncedRemoteSequence,
                remoteDeltaEvents: remoteDeltaEvents.length,
                unknownRemoteDeltaEvents: unknownRemoteDeltaEvents.length,
              });
              yield* Ref.set(stoppedRef, true);
              yield* publishStatus({
                state: "error",
                configured: true,
                message,
                lastSyncedAt,
              });
              return;
            }

            const now = new Date().toISOString();
            const alreadyLocalRemoteDeltaEvents = selectKnownRemoteDeltaLocalEvents({
              remoteEvents: remoteDeltaEvents,
              localEvents,
            });
            yield* writePushedEventReceipts(alreadyLocalRemoteDeltaEvents, now);
            yield* writeState({
              hasCompletedInitialSync: true,
              lastSyncedRemoteSequence: remoteMaxSequence,
              lastSuccessfulSyncAt: now,
            });
            autosaveLastSyncedAt = now;
            console.info("[history-sync] autosave accepted remote delta already present locally", {
              remoteMaxSequence,
              lastSyncedRemoteSequence,
              remoteDeltaEvents: remoteDeltaEvents.length,
            });
          }

          const projectMappings = yield* readProjectMappings;
          const unpushedLocalEvents = yield* readUnpushedLocalEvents;
          const projectionThreadRows = yield* readProjectionThreadAutosyncRows;
          const remoteCoveredReceiptEvents = selectAutosaveRemoteCoveredReceiptEvents({
            unpushedLocalEvents,
            remoteMaxSequence,
          });
          if (remoteCoveredReceiptEvents.length > 0) {
            const now = new Date().toISOString();
            yield* writePushedEventReceipts(remoteCoveredReceiptEvents, now);
            autosaveLastSyncedAt = now;
            console.info("[history-sync] autosave seeded receipts for remote-covered events", {
              events: remoteCoveredReceiptEvents.length,
              remoteMaxSequence,
            });
          }
          const candidateLocalEvents = selectAutosaveCandidateLocalEvents({
            localEvents,
            unpushedLocalEvents,
            remoteMaxSequence,
            ...(options.autosaveMaxSequence !== undefined
              ? { maxSequence: options.autosaveMaxSequence }
              : {}),
          });
          const pushableLocalEvents = selectAutosaveContiguousPushableEvents({
            candidateEvents: candidateLocalEvents,
            threadStates: classifyAutosyncThreadStates(localEvents, projectionThreadRows),
          });
          if (pushableLocalEvents.length > 0) {
            console.info("[history-sync] autosaving local pending history", {
              pendingEvents: pushableLocalEvents.length,
              deferredEvents: candidateLocalEvents.length - pushableLocalEvents.length,
              localMaxSequence,
              lastSyncedRemoteSequence: Math.max(lastSyncedRemoteSequence, remoteMaxSequence),
              remoteMaxSequence,
            });
            yield* pushEventsBatched(
              connectionString,
              rewriteLocalEventsForRemoteMappings(pushableLocalEvents, projectMappings),
            );
            const now = new Date().toISOString();
            yield* writePushedEventReceipts(pushableLocalEvents, now);
            const nextRemoteSequence = nextSyncedRemoteSequenceAfterPush(
              Math.max(lastSyncedRemoteSequence, remoteMaxSequence),
              pushableLocalEvents,
            );
            yield* writeState({
              hasCompletedInitialSync: true,
              lastSyncedRemoteSequence: nextRemoteSequence,
              lastSuccessfulSyncAt: now,
            });
            yield* publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
            return;
          }

          yield* publishStatus({
            state: "idle",
            configured: true,
            lastSyncedAt: autosaveLastSyncedAt,
          });
          return;
        }

        const remoteMaxSequenceForRepair = hasCompletedInitialSync
          ? yield* readRemoteMaxSequence(connectionString)
          : 0;
        const shouldUseFullRemoteForRecovery =
          hasCompletedInitialSync &&
          (localEvents.length === 0 ||
            localProjectionCounts.projectCount + localProjectionCounts.threadCount === 0);
        const remoteEvents =
          !hasCompletedInitialSync || shouldUseFullRemoteForRecovery
            ? yield* readRemoteEvents(connectionString)
            : yield* readRemoteEvents(connectionString, lastSyncedRemoteSequence);
        const remoteMaxSequence = Math.max(
          hasCompletedInitialSync ? remoteMaxSequenceForRepair : 0,
          ...remoteEvents.map((event) => event.sequence),
        );
        const remoteEventsForMapping =
          hasCompletedInitialSync && remoteEvents.length > 0
            ? yield* readRemoteEvents(connectionString)
            : remoteEvents;
        const mappingPlan = yield* buildProjectMappingPlanFromEvents({
          remoteEvents: remoteEventsForMapping,
          remoteMaxSequence,
        });
        yield* autoPersistExactProjectMappings(mappingPlan);
        const refreshedMappingPlan = yield* buildProjectMappingPlanFromEvents({
          remoteEvents: remoteEventsForMapping,
          remoteMaxSequence,
        });
        const unresolvedProjectCount = refreshedMappingPlan.candidates.filter(
          (candidate) => candidate.status === "unresolved",
        ).length;
        if (unresolvedProjectCount > 0) {
          yield* publishStatus({
            state: "needs-project-mapping",
            configured: true,
            remoteMaxSequence,
            unresolvedProjectCount,
            lastSyncedAt,
          });
          return;
        }
        const projectMappings = yield* readProjectMappings;
        const remoteEventsForLocal = rewriteRemoteEventsForLocalMappings(
          normalizeRemoteEventsForLocalImport(remoteEvents),
          projectMappings,
        );
        const remoteProjectCount = collectProjectCandidates(remoteEventsForLocal).length;
        const remoteActiveThreadCount = countActiveThreadCreates(remoteEventsForLocal);
        const localEventsForRemote = rewriteLocalEventsForRemoteMappings(
          localEvents,
          projectMappings,
        );

        if (!hasCompletedInitialSync) {
          console.info("[history-sync] first sync started", {
            localEvents: localEvents.length,
            remoteEvents: remoteEvents.length,
            remoteMaxSequence,
          });
          if (
            shouldPushLocalHistoryOnFirstSync({
              hasCompletedInitialSync,
              localEventCount: localEvents.length,
              remoteEventCount: remoteEvents.length,
            })
          ) {
            console.info("[history-sync] first sync pushing local history to empty remote", {
              localEvents: localEvents.length,
              localMaxSequence,
            });
            yield* pushEventsBatched(connectionString, localEventsForRemote);
            const now = new Date().toISOString();
            yield* writePushedEventReceipts(localEvents, now);
            yield* writeState({
              hasCompletedInitialSync: true,
              lastSyncedRemoteSequence: localMaxSequence,
              lastSuccessfulSyncAt: now,
            });
            yield* publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
            return;
          }

          const mergeEvents =
            localEvents.length === 0
              ? []
              : buildFirstSyncClientMergeEvents(localEvents, remoteEventsForLocal);
          console.info("[history-sync] first sync client merge computed", {
            mergedEvents: mergeEvents.length,
          });
          const importedEvents = [...remoteEventsForLocal, ...mergeEvents];
          yield* pushEventsBatched(
            connectionString,
            rewriteLocalEventsForRemoteMappings(mergeEvents, projectMappings),
          );
          yield* runImport(importedEvents, syncContext);
          const nextRemoteSequence = Math.max(
            remoteMaxSequence,
            ...mergeEvents.map((event) => event.sequence),
          );
          const now = new Date().toISOString();
          yield* writePushedEventReceipts(importedEvents, now);
          yield* writeState({
            hasCompletedInitialSync: true,
            lastSyncedRemoteSequence: nextRemoteSequence,
            lastSuccessfulSyncAt: now,
          });
          yield* publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
          return;
        }

        if (
          isRemoteBehindLocal({
            hasCompletedInitialSync,
            localMaxSequence,
            remoteMaxSequence,
            lastSyncedRemoteSequence,
          })
        ) {
          const pending = selectRemoteBehindLocalEvents(localEvents, remoteMaxSequence);
          console.warn("[history-sync] remote history is behind local state; repairing remote", {
            pendingEvents: pending.length,
            localMaxSequence,
            remoteMaxSequence,
            lastSyncedRemoteSequence,
          });
          yield* pushEventsBatched(
            connectionString,
            rewriteLocalEventsForRemoteMappings(pending, projectMappings),
          );
          const now = new Date().toISOString();
          yield* writePushedEventReceipts(pending, now);
          yield* writeState({
            hasCompletedInitialSync: true,
            lastSyncedRemoteSequence: localMaxSequence,
            lastSuccessfulSyncAt: now,
          });
          yield* publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
          return;
        }

        const shouldReplaceLocalFromRemote = shouldImportRemoteIntoEmptyLocal({
          hasCompletedInitialSync,
          localEventCount: localEvents.length,
          localProjectionCount:
            localProjectionCounts.projectCount + localProjectionCounts.threadCount,
          localProjectProjectionCount: localProjectionCounts.projectCount,
          localThreadProjectionCount: localProjectionCounts.threadCount,
          remoteEventCount: remoteEventsForLocal.length,
          remoteProjectCount,
          remoteActiveThreadCount,
        });
        if (shouldReplaceLocalFromRemote || remoteMaxSequence > lastSyncedRemoteSequence) {
          const remoteEventsToImport = shouldReplaceLocalFromRemote
            ? remoteEventsForLocal
            : filterAlreadyImportedRemoteDeltaEvents(remoteEventsForLocal, localEvents);
          console.info("[history-sync] importing remote history", {
            remoteEvents: remoteEvents.length,
            rewrittenRemoteEvents: remoteEventsForLocal.length,
            importEvents: remoteEventsToImport.length,
            alreadyImportedEvents: remoteEventsForLocal.length - remoteEventsToImport.length,
            remoteMaxSequence,
            lastSyncedRemoteSequence,
            localEvents: localEvents.length,
            localProjectionCounts,
            remoteProjectCount,
            remoteActiveThreadCount,
            mode: shouldReplaceLocalFromRemote ? "replace" : "delta",
          });
          if (remoteEventsToImport.length > 0) {
            yield* runImport(remoteEventsToImport, syncContext, {
              mode: shouldReplaceLocalFromRemote ? "replace" : "delta",
            });
          }
          const now = new Date().toISOString();
          yield* writePushedEventReceipts(remoteEventsForLocal, now);
          yield* writeState({
            hasCompletedInitialSync: true,
            lastSyncedRemoteSequence: remoteMaxSequence,
            lastSuccessfulSyncAt: now,
          });
          if (shouldReplaceLocalFromRemote) {
            yield* publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
            return;
          }

          const refreshedLocalEvents = yield* readLocalEvents();
          const unpushedLocalEvents = yield* readUnpushedLocalEvents;
          const pushableLocalEvents = filterPushableLocalEvents(
            unpushedLocalEvents,
            refreshedLocalEvents,
          );
          if (pushableLocalEvents.length > 0) {
            console.info("[history-sync] pushing local pending history after remote import", {
              pendingEvents: pushableLocalEvents.length,
              deferredEvents: unpushedLocalEvents.length - pushableLocalEvents.length,
              localMaxSequence: Math.max(0, ...refreshedLocalEvents.map((event) => event.sequence)),
              lastSyncedRemoteSequence: remoteMaxSequence,
            });
            yield* pushEventsBatched(
              connectionString,
              rewriteLocalEventsForRemoteMappings(pushableLocalEvents, projectMappings),
            );
            const pushedAt = new Date().toISOString();
            yield* writePushedEventReceipts(pushableLocalEvents, pushedAt);
            const nextRemoteSequence = nextSyncedRemoteSequenceAfterPush(
              remoteMaxSequence,
              pushableLocalEvents,
            );
            yield* writeState({
              hasCompletedInitialSync: true,
              lastSyncedRemoteSequence: nextRemoteSequence,
              lastSuccessfulSyncAt: pushedAt,
            });
            yield* publishStatus({ state: "idle", configured: true, lastSyncedAt: pushedAt });
            return;
          }

          yield* publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
          return;
        }

        const unpushedLocalEvents = yield* readUnpushedLocalEvents;
        const pushableLocalEvents = filterPushableLocalEvents(unpushedLocalEvents, localEvents);
        if (pushableLocalEvents.length > 0) {
          console.info("[history-sync] pushing local pending history", {
            pendingEvents: pushableLocalEvents.length,
            deferredEvents: unpushedLocalEvents.length - pushableLocalEvents.length,
            localMaxSequence,
            lastSyncedRemoteSequence,
          });
          yield* pushEventsBatched(
            connectionString,
            rewriteLocalEventsForRemoteMappings(pushableLocalEvents, projectMappings),
          );
          const now = new Date().toISOString();
          yield* writePushedEventReceipts(pushableLocalEvents, now);
          const nextRemoteSequence = nextSyncedRemoteSequenceAfterPush(
            lastSyncedRemoteSequence,
            pushableLocalEvents,
          );
          yield* writeState({
            hasCompletedInitialSync: true,
            lastSyncedRemoteSequence: nextRemoteSequence,
            lastSuccessfulSyncAt: now,
          });
          yield* publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
          return;
        }

        const now = new Date().toISOString();
        yield* writeState({
          hasCompletedInitialSync: true,
          lastSyncedRemoteSequence,
          lastSuccessfulSyncAt: now,
        });
        yield* publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
      }).pipe(
        Effect.timeout(HISTORY_SYNC_OPERATION_TIMEOUT_MS),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            yield* Ref.set(stoppedRef, true);
            const previousStatus = yield* Ref.get(statusRef);
            const lastSyncedAt =
              previousStatus.state === "idle" ||
              previousStatus.state === "syncing" ||
              previousStatus.state === "error" ||
              previousStatus.state === "needs-project-mapping" ||
              previousStatus.state === "needs-initial-sync"
                ? previousStatus.lastSyncedAt
                : null;
            const message = describeSyncFailure(cause);
            console.error("[history-sync] sync failed", {
              mode: options.mode,
              message,
              cause,
            });
            yield* Effect.logWarning("history sync failed", { cause });
            yield* publishStatus({
              state: "error",
              configured: true,
              message: message || "History sync failed.",
              lastSyncedAt,
            });
          }),
        ),
      );

    const runSyncMode = (
      mode: HistorySyncMode,
      options: { readonly clearStopped: boolean; readonly autosaveMaxSequence?: number },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const running = yield* Ref.get(runningRef);
        if (running) {
          if (mode === "autosave") {
            yield* Ref.set(pendingAutosaveRef, true);
          }
          return;
        }
        if (options.clearStopped) {
          yield* Ref.set(stoppedRef, false);
        } else {
          const stopped = yield* Ref.get(stoppedRef);
          if (stopped) return;
        }
        yield* Ref.set(runningRef, true);
        yield* performSync({
          mode,
          ...(options.autosaveMaxSequence !== undefined
            ? { autosaveMaxSequence: options.autosaveMaxSequence }
            : {}),
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Ref.set(runningRef, false);
              const shouldReschedule = yield* Ref.getAndSet(pendingAutosaveRef, false);
              if (shouldReschedule) {
                yield* Effect.sleep(HISTORY_SYNC_AUTOSAVE_DEBOUNCE_MS).pipe(
                  Effect.andThen(runSyncMode("autosave", { clearStopped: false })),
                );
              }
            }),
          ),
        );
      });

    const syncNow: HistorySyncServiceShape["syncNow"] = runSyncMode("full", {
      clearStopped: false,
    });
    syncNowEffect = syncNow;

    const runSync: HistorySyncServiceShape["runSync"] = runSyncMode("full", {
      clearStopped: true,
    }).pipe(Effect.andThen(toConfig));

    const startInitialSync: HistorySyncServiceShape["startInitialSync"] = Ref.get(runningRef).pipe(
      Effect.flatMap((running) => {
        if (running) return toConfig;
        return Ref.set(stoppedRef, false).pipe(
          Effect.andThen(Ref.set(runningRef, true)),
          Effect.andThen(performSync({ mode: "initial" })),
          Effect.ensuring(Ref.set(runningRef, false)),
          Effect.andThen(toConfig),
        );
      }),
    );

    const restoreBackup: HistorySyncServiceShape["restoreBackup"] = Ref.get(runningRef).pipe(
      Effect.flatMap((running) => {
        if (running) {
          return Effect.fail(
            new HistorySyncConfigError({
              message: "Cannot restore the history sync backup while sync is running.",
            }),
          );
        }
        return Ref.set(runningRef, true).pipe(
          Effect.andThen(restoreBackupFromDisk),
          Effect.ensuring(Ref.set(runningRef, false)),
          Effect.andThen(toConfig),
        );
      }),
    );

    const start: HistorySyncServiceShape["start"] = Effect.gen(function* () {
      const timing = yield* settingsService.getSettings.pipe(
        Effect.map((settings) => settings.historySync),
        Effect.catch((error) =>
          Effect.logWarning("history sync using default timing because settings failed to load", {
            cause: error,
          }).pipe(Effect.as(defaultHistorySyncTiming)),
        ),
      );
      const syncWhenNotRunning = Ref.get(runningRef).pipe(
        Effect.flatMap((running) =>
          running
            ? Effect.void
            : publishConfiguredStartupStatus.pipe(
                Effect.flatMap((shouldSync) => (shouldSync ? syncNow : Effect.void)),
              ),
        ),
      );
      yield* Effect.sleep(HISTORY_SYNC_STARTUP_DELAY_MS).pipe(
        Effect.andThen(syncWhenNotRunning),
        Effect.forkScoped,
      );
      yield* Effect.addFinalizer(() =>
        runSyncMode("autosave", { clearStopped: false }).pipe(
          Effect.timeout(timing.shutdownFlushTimeoutMs),
          Effect.ignore({ log: true }),
        ),
      );
      yield* engine.streamDomainEvents.pipe(
        Stream.filter(shouldScheduleAutosaveForDomainEvent),
        Stream.debounce(Duration.millis(HISTORY_SYNC_AUTOSAVE_DEBOUNCE_MS)),
        Stream.runForEach((event) =>
          runSyncMode("autosave", {
            clearStopped: false,
            autosaveMaxSequence: event.sequence,
          }),
        ),
        Effect.forkScoped,
      );
    });

    latestHistorySyncControl = {
      getConfig: toConfig,
      updateConfig,
      runSync,
      startInitialSync,
      restoreBackup,
      testConnection,
      getProjectMappings,
      applyProjectMappings,
    };

    return {
      start,
      syncNow,
      runSync,
      getStatus: Ref.get(statusRef),
      getConfig: toConfig,
      updateConfig,
      startInitialSync,
      restoreBackup,
      testConnection,
      getProjectMappings,
      applyProjectMappings,
      get streamStatus() {
        return Stream.fromPubSub(statusPubSub);
      },
    } satisfies HistorySyncServiceShape;
  }),
);
