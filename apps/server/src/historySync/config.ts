import {
  HistorySyncConfigError,
  type HistorySyncBackupSummary,
  type HistorySyncConfig,
  type HistorySyncConnectionTestResult,
  type HistorySyncMysqlFields,
  type HistorySyncStatus,
  type HistorySyncUpdateConfigInput,
  type ServerSettingsError,
} from "@t3tools/contracts";
import { Effect, Ref } from "effect";

import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore.ts";
import type { ServerSettingsShape } from "../serverSettings.ts";
import type { HistorySyncStateRow } from "./localRepository.ts";
import { shouldRunAutomaticHistorySync } from "./planner.ts";
import {
  buildMysqlConnectionString,
  testConnectionString,
  toConnectionSummary,
} from "./remoteStore.ts";

export const HISTORY_SYNC_CONNECTION_STRING_SECRET = "history-sync-mysql-connection-string";

export const defaultHistorySyncTiming = {
  intervalMs: 120_000,
  shutdownFlushTimeoutMs: 5_000,
};

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export function describeUnknownError(error: unknown): string {
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

export function describeSyncFailure(error: unknown): string {
  const wrappedCause =
    typeof error === "object" && error !== null && "cause" in error
      ? (error as { readonly cause?: unknown }).cause
      : undefined;
  return describeUnknownError(wrappedCause ?? error) || "History sync failed.";
}

export interface HistorySyncConfigController {
  readonly getConnectionString: Effect.Effect<string | null>;
  readonly toConfig: Effect.Effect<HistorySyncConfig, ServerSettingsError>;
  readonly testConnection: (
    input: HistorySyncMysqlFields,
  ) => Effect.Effect<HistorySyncConnectionTestResult, HistorySyncConfigError>;
  readonly updateConfig: (
    input: HistorySyncUpdateConfigInput,
  ) => Effect.Effect<HistorySyncConfig, HistorySyncConfigError | ServerSettingsError>;
  readonly publishConfiguredStartupStatus: Effect.Effect<boolean, ServerSettingsError>;
  readonly loadTiming: Effect.Effect<
    { readonly shutdownFlushTimeoutMs: number },
    ServerSettingsError
  >;
}

export function createHistorySyncConfigController(input: {
  readonly secretStore: ServerSecretStoreShape;
  readonly settingsService: ServerSettingsShape;
  readonly statusRef: Ref.Ref<HistorySyncStatus>;
  readonly readState: Effect.Effect<HistorySyncStateRow | null, HistorySyncConfigError>;
  readonly readBackupSummary: Effect.Effect<HistorySyncBackupSummary | null>;
  readonly publishStatus: (status: HistorySyncStatus) => Effect.Effect<void>;
  readonly clearStopped: () => Effect.Effect<void>;
  readonly syncNow: () => Effect.Effect<void>;
}): HistorySyncConfigController {
  const getConnectionString = Effect.gen(function* () {
    const secret = yield* input.secretStore.get(HISTORY_SYNC_CONNECTION_STRING_SECRET).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to read history sync connection string", {
          cause: error,
        }).pipe(Effect.as(null)),
      ),
    );
    const value = secret ? textDecoder.decode(secret).trim() : "";
    return value.length > 0 ? value : null;
  });

  const toConfig = Effect.gen(function* () {
    const [settings, connectionString, status, state, backup] = yield* Effect.all([
      input.settingsService.getSettings,
      getConnectionString,
      Ref.get(input.statusRef),
      input.readState.pipe(Effect.catch(() => Effect.succeed(null))),
      input.readBackupSummary,
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

  const testConnection: HistorySyncConfigController["testConnection"] = (mysql) =>
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

  const updateConfig: HistorySyncConfigController["updateConfig"] = (configInput) =>
    Effect.gen(function* () {
      if (configInput.clearConnection && configInput.mysql) {
        return yield* new HistorySyncConfigError({
          message: "Cannot clear and update the MySQL connection in the same request.",
        });
      }

      let connectionSummary = undefined as ReturnType<typeof toConnectionSummary> | undefined;
      let connectionString = null as string | null;
      if (configInput.mysql) {
        const mysql = configInput.mysql;
        const builtConnection = yield* Effect.try({
          try: () => ({
            connectionString: buildMysqlConnectionString(mysql),
            connectionSummary: toConnectionSummary(mysql),
          }),
          catch: (cause) =>
            new HistorySyncConfigError({
              message: describeUnknownError(cause),
            }),
        });
        connectionString = builtConnection.connectionString;
        connectionSummary = builtConnection.connectionSummary;

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
        yield* input.secretStore
          .set(HISTORY_SYNC_CONNECTION_STRING_SECRET, textEncoder.encode(connectionString))
          .pipe(
            Effect.mapError(
              (_cause) =>
                new HistorySyncConfigError({
                  message: "Failed to store MySQL connection secret.",
                }),
            ),
          );
        yield* input.clearStopped();
      } else if (configInput.clearConnection) {
        yield* input.secretStore.remove(HISTORY_SYNC_CONNECTION_STRING_SECRET).pipe(
          Effect.mapError(
            (_cause) =>
              new HistorySyncConfigError({
                message: "Failed to clear MySQL connection secret.",
              }),
          ),
        );
        yield* input.clearStopped();
      }

      const current = yield* input.settingsService.getSettings;
      const nextHistorySync = {
        ...current.historySync,
        ...configInput.settings,
        ...(connectionSummary ? { connectionSummary } : {}),
        ...(configInput.clearConnection ? { connectionSummary: null } : {}),
      };
      yield* input.settingsService.updateSettings({
        historySync: nextHistorySync,
      });

      const syncEnabled = configInput.settings?.enabled ?? current.historySync.enabled;
      const nextConnectionString =
        connectionString !== null ? connectionString : yield* getConnectionString;
      if (syncEnabled && nextConnectionString !== null) {
        const state = yield* input.readState.pipe(
          Effect.mapError(
            (cause) =>
              new HistorySyncConfigError({
                message: describeSyncFailure(cause),
              }),
          ),
        );
        yield* input.clearStopped();
        if (state?.hasCompletedInitialSync !== 1) {
          yield* input.publishStatus({
            state: "needs-initial-sync",
            configured: true,
            lastSyncedAt: state?.lastSuccessfulSyncAt ?? null,
          });
        } else {
          yield* input.publishStatus({
            state: "idle",
            configured: true,
            lastSyncedAt: state?.lastSuccessfulSyncAt ?? null,
          });
        }
      } else if (nextConnectionString !== null) {
        const state = yield* input.readState.pipe(
          Effect.mapError(
            (cause) =>
              new HistorySyncConfigError({
                message: describeSyncFailure(cause),
              }),
          ),
        );
        if (state?.hasCompletedInitialSync === 1) {
          yield* input.publishStatus({
            state: "disabled",
            configured: true,
          });
        } else {
          yield* input.publishStatus({
            state: "needs-initial-sync",
            configured: true,
            lastSyncedAt: state?.lastSuccessfulSyncAt ?? null,
          });
        }
      } else {
        yield* input.publishStatus({
          state: "disabled",
          configured: false,
        });
      }
      return yield* toConfig;
    });

  const publishConfiguredStartupStatus = Effect.gen(function* () {
    const [settings, connectionString, state] = yield* Effect.all([
      input.settingsService.getSettings,
      getConnectionString,
      input.readState.pipe(Effect.catch(() => Effect.succeed(null))),
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
        yield* input.publishStatus({
          state: "needs-initial-sync",
          configured: true,
          lastSyncedAt: state?.lastSuccessfulSyncAt ?? null,
        });
        return false;
      }
      yield* input.publishStatus({
        state: "disabled",
        configured: connectionString !== null,
      });
      return false;
    }
    return true;
  });

  const loadTiming = input.settingsService.getSettings.pipe(
    Effect.map((settings) => ({
      shutdownFlushTimeoutMs: settings.historySync.shutdownFlushTimeoutMs,
    })),
  );

  return {
    getConnectionString,
    toConfig,
    testConnection,
    updateConfig,
    publishConfiguredStartupStatus,
    loadTiming,
  };
}
