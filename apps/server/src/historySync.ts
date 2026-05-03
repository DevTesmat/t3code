import * as Crypto from "node:crypto";

import {
  HistorySyncConfigError,
  type HistorySyncConfig,
  type HistorySyncConnectionTestResult,
  type HistorySyncMysqlFields,
  type HistorySyncStatus,
  type HistorySyncUpdateConfigInput,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Context, Data, Effect, Layer, PubSub, Ref, Scope, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Pool, RowDataPacket } from "mysql2/promise";

import { ServerSecretStore } from "./auth/Services/ServerSecretStore.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import type { ServerSettingsError } from "@t3tools/contracts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";

export const HISTORY_SYNC_CONNECTION_STRING_SECRET = "history-sync-mysql-connection-string";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const DISABLED_HISTORY_SYNC_STATUS: HistorySyncStatus = { state: "disabled", configured: false };
let latestHistorySyncStatus: HistorySyncStatus = DISABLED_HISTORY_SYNC_STATUS;
const historySyncStatusSubscribers = new Set<(status: HistorySyncStatus) => Effect.Effect<void>>();
let latestHistorySyncControl: Pick<
  HistorySyncServiceShape,
  "getConfig" | "updateConfig" | "testConnection"
> | null = null;
const defaultHistorySyncTiming = {
  intervalMs: 120_000,
  shutdownFlushTimeoutMs: 5_000,
};

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

function logHistorySyncStatus(status: HistorySyncStatus): void {
  switch (status.state) {
    case "disabled":
      console.info("[history-sync] disabled", { configured: status.configured });
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

interface HistorySyncStateRow {
  readonly hasCompletedInitialSync: number;
  readonly lastSyncedRemoteSequence: number;
  readonly lastSuccessfulSyncAt: string | null;
}

interface ThreadCandidate {
  readonly threadId: string;
  readonly projectId: string | null;
  readonly hash: string | null;
  readonly events: readonly HistorySyncEventRow[];
}

export interface HistorySyncServiceShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly syncNow: Effect.Effect<void>;
  readonly getStatus: Effect.Effect<HistorySyncStatus>;
  readonly getConfig: Effect.Effect<HistorySyncConfig, ServerSettingsError>;
  readonly updateConfig: (
    input: HistorySyncUpdateConfigInput,
  ) => Effect.Effect<HistorySyncConfig, HistorySyncConfigError | ServerSettingsError>;
  readonly testConnection: (
    input: HistorySyncMysqlFields,
  ) => Effect.Effect<HistorySyncConnectionTestResult, HistorySyncConfigError>;
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
  const remoteHashes = new Set(
    remoteThreads.flatMap((thread) => (thread.hash ? [thread.hash] : [])),
  );
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
    if (thread.hash === null || remoteHashes.has(thread.hash)) {
      continue;
    }

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
    const statusRef = yield* Ref.make<HistorySyncStatus>(DISABLED_HISTORY_SYNC_STATUS);
    const statusPubSub = yield* PubSub.unbounded<HistorySyncStatus>();
    const runningRef = yield* Ref.make(false);
    const stoppedRef = yield* Ref.make(false);

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
      const [settings, connectionString, status] = yield* Effect.all([
        settingsService.getSettings,
        getConnectionString,
        Ref.get(statusRef),
      ]);
      return {
        enabled: settings.historySync.enabled,
        configured: connectionString !== null,
        status: {
          ...status,
          configured: connectionString !== null,
        },
        intervalMs: settings.historySync.intervalMs,
        shutdownFlushTimeoutMs: settings.historySync.shutdownFlushTimeoutMs,
        statusIndicatorEnabled: settings.historySync.statusIndicatorEnabled,
        ...(settings.historySync.connectionSummary
          ? { connectionSummary: settings.historySync.connectionSummary }
          : {}),
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
          ...(input.settings ?? {}),
          ...(connectionSummary ? { connectionSummary } : {}),
          ...(input.clearConnection ? { connectionSummary: null } : {}),
        };
        yield* settingsService.updateSettings({
          historySync: nextHistorySync,
        });

        if ((input.settings?.enabled ?? current.historySync.enabled) && connectionString !== null) {
          yield* syncNow;
        }
        return yield* toConfig;
      });

    const readRemoteEvents = (connectionString: string) =>
      withPool(connectionString, async (pool) => {
        await ensureRemoteSchema(pool);
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
                  occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
                  JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$')) AS payload_json,
                  JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$')) AS metadata_json
           FROM orchestration_events
           ORDER BY sequence ASC`,
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

    const pushEvents = (connectionString: string, events: readonly HistorySyncEventRow[]) =>
      withPool(connectionString, async (pool) => {
        await ensureRemoteSchema(pool);
        if (events.length === 0) return;
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
        await pool.query(
          `INSERT IGNORE INTO orchestration_events
             (sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
              occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
              payload_json, metadata_json)
           VALUES ?`,
          [values],
        );
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

    const readState = Effect.gen(function* () {
      const rows = yield* sql<HistorySyncStateRow>`
        SELECT
          has_completed_initial_sync AS "hasCompletedInitialSync",
          last_synced_remote_sequence AS "lastSyncedRemoteSequence",
          last_successful_sync_at AS "lastSuccessfulSyncAt"
        FROM history_sync_state
        WHERE id = 1
        LIMIT 1
      `;
      return rows[0] ?? null;
    });

    const writeState = (input: {
      readonly hasCompletedInitialSync: boolean;
      readonly lastSyncedRemoteSequence: number;
      readonly lastSuccessfulSyncAt: string;
    }) =>
      sql`
        INSERT INTO history_sync_state (
          id,
          has_completed_initial_sync,
          last_synced_remote_sequence,
          last_successful_sync_at
        )
        VALUES (
          1,
          ${input.hasCompletedInitialSync ? 1 : 0},
          ${input.lastSyncedRemoteSequence},
          ${input.lastSuccessfulSyncAt}
        )
        ON CONFLICT (id) DO UPDATE SET
          has_completed_initial_sync = excluded.has_completed_initial_sync,
          last_synced_remote_sequence = excluded.last_synced_remote_sequence,
          last_successful_sync_at = excluded.last_successful_sync_at
      `;

    const insertLocalEvents = (events: readonly HistorySyncEventRow[]) =>
      Effect.forEach(
        events,
        (event) =>
          sql`
            INSERT INTO orchestration_events (
              sequence,
              event_id,
              aggregate_kind,
              stream_id,
              stream_version,
              event_type,
              occurred_at,
              command_id,
              causation_event_id,
              correlation_id,
              actor_kind,
              payload_json,
              metadata_json
            )
            VALUES (
              ${event.sequence},
              ${event.eventId},
              ${event.aggregateKind},
              ${event.streamId},
              ${event.streamVersion},
              ${event.eventType},
              ${event.occurredAt},
              ${event.commandId},
              ${event.causationEventId},
              ${event.correlationId},
              ${event.actorKind},
              ${event.payloadJson},
              ${event.metadataJson}
            )
          `,
        { concurrency: 1 },
      );

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

    const runImport = (events: readonly HistorySyncEventRow[]) =>
      Effect.gen(function* () {
        yield* importRemoteEvents(events);
        if (engine.reloadFromStorage) {
          yield* engine.reloadFromStorage();
        }
      });

    const performSync: Effect.Effect<void> = Effect.gen(function* () {
      const settings = yield* settingsService.getSettings;
      const connectionString = yield* getConnectionString;
      if (!settings.historySync.enabled || connectionString === null) {
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
        previousStatus.state === "error"
          ? previousStatus.lastSyncedAt
          : null;
      yield* publishStatus({
        state: "syncing",
        configured: true,
        startedAt: new Date().toISOString(),
        lastSyncedAt,
      });

      const state = yield* readState;
      const localEvents = yield* readLocalEvents();
      const remoteEvents = yield* readRemoteEvents(connectionString);
      const remoteMaxSequence = Math.max(0, ...remoteEvents.map((event) => event.sequence));
      const localMaxSequence = Math.max(0, ...localEvents.map((event) => event.sequence));
      const hasCompletedInitialSync = state?.hasCompletedInitialSync === 1;
      const lastSyncedRemoteSequence = state?.lastSyncedRemoteSequence ?? 0;

      if (!hasCompletedInitialSync) {
        console.info("[history-sync] first sync started", {
          localEvents: localEvents.length,
          remoteEvents: remoteEvents.length,
          remoteMaxSequence,
        });
        const rescueEvents =
          localEvents.length === 0 ? [] : buildFirstSyncRescueEvents(localEvents, remoteEvents);
        console.info("[history-sync] first sync rescue computed", {
          rescuedEvents: rescueEvents.length,
        });
        const importedEvents = [...remoteEvents, ...rescueEvents];
        yield* runImport(importedEvents);
        yield* pushEvents(connectionString, rescueEvents);
        const nextRemoteSequence = Math.max(
          remoteMaxSequence,
          ...rescueEvents.map((event) => event.sequence),
        );
        const now = new Date().toISOString();
        yield* writeState({
          hasCompletedInitialSync: true,
          lastSyncedRemoteSequence: nextRemoteSequence,
          lastSuccessfulSyncAt: now,
        });
        yield* publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
        return;
      }

      if (remoteMaxSequence > lastSyncedRemoteSequence) {
        console.info("[history-sync] importing remote history", {
          remoteEvents: remoteEvents.length,
          remoteMaxSequence,
          lastSyncedRemoteSequence,
        });
        yield* runImport(remoteEvents);
        const now = new Date().toISOString();
        yield* writeState({
          hasCompletedInitialSync: true,
          lastSyncedRemoteSequence: remoteMaxSequence,
          lastSuccessfulSyncAt: now,
        });
        yield* publishStatus({ state: "idle", configured: true, lastSyncedAt: now });
        return;
      }

      if (localMaxSequence > lastSyncedRemoteSequence) {
        const pending = localEvents.filter((event) => event.sequence > lastSyncedRemoteSequence);
        console.info("[history-sync] pushing local pending history", {
          pendingEvents: pending.length,
          localMaxSequence,
          lastSyncedRemoteSequence,
        });
        yield* pushEvents(connectionString, pending);
        const now = new Date().toISOString();
        yield* writeState({
          hasCompletedInitialSync: true,
          lastSyncedRemoteSequence: localMaxSequence,
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
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* Ref.set(stoppedRef, true);
          const previousStatus = yield* Ref.get(statusRef);
          const lastSyncedAt =
            previousStatus.state === "idle" ||
            previousStatus.state === "syncing" ||
            previousStatus.state === "error"
              ? previousStatus.lastSyncedAt
              : null;
          const message = describeSyncFailure(cause);
          console.error("[history-sync] sync failed; periodic sync is stopped", {
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

    const syncNow: HistorySyncServiceShape["syncNow"] = Ref.get(runningRef).pipe(
      Effect.flatMap((running) => {
        if (running) return Effect.void;
        return Ref.get(stoppedRef).pipe(
          Effect.flatMap((stopped) => {
            if (stopped) return Effect.void;
            return Ref.set(runningRef, true).pipe(
              Effect.andThen(performSync),
              Effect.ensuring(Ref.set(runningRef, false)),
            );
          }),
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
      yield* syncNow;
      yield* Effect.addFinalizer(() =>
        syncNow.pipe(Effect.timeout(timing.shutdownFlushTimeoutMs), Effect.ignore({ log: true })),
      );
      yield* Effect.forever(Effect.sleep(timing.intervalMs).pipe(Effect.andThen(syncNow))).pipe(
        Effect.forkScoped,
      );
    });

    latestHistorySyncControl = {
      getConfig: toConfig,
      updateConfig,
      testConnection,
    };

    return {
      start,
      syncNow,
      getStatus: Ref.get(statusRef),
      getConfig: toConfig,
      updateConfig,
      testConnection,
      get streamStatus() {
        return Stream.fromPubSub(statusPubSub);
      },
    } satisfies HistorySyncServiceShape;
  }),
);
