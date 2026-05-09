import {
  HistorySyncConfigError,
  type HistorySyncConfig,
  type HistorySyncConnectionTestResult,
  type HistorySyncMysqlFields,
  type HistorySyncProjectMappingPlan,
  type HistorySyncProjectMappingsApplyInput,
  type HistorySyncUpdateConfigInput,
} from "@t3tools/contracts";
import { Effect } from "effect";

import type { ServerSettingsError } from "@t3tools/contracts";

import { readHistorySyncStatus } from "./statusBus.ts";

const defaultHistorySyncTiming = {
  intervalMs: 120_000,
  shutdownFlushTimeoutMs: 5_000,
};

export interface HistorySyncFacadeControl {
  readonly getConfig: Effect.Effect<HistorySyncConfig, ServerSettingsError>;
  readonly updateConfig: (
    input: HistorySyncUpdateConfigInput,
  ) => Effect.Effect<HistorySyncConfig, HistorySyncConfigError | ServerSettingsError>;
  readonly runSync: Effect.Effect<HistorySyncConfig, HistorySyncConfigError | ServerSettingsError>;
  readonly prioritizeThreadSync: (threadId: string) => Effect.Effect<void>;
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
}

let latestHistorySyncControl: HistorySyncFacadeControl | null = null;

function serviceNotReady() {
  return new HistorySyncConfigError({
    message: "History sync service is not ready.",
  });
}

export function registerHistorySyncFacadeControl(control: HistorySyncFacadeControl): void {
  latestHistorySyncControl = control;
}

export function resetHistorySyncFacadeControlForTest(): void {
  latestHistorySyncControl = null;
}

export const getHistorySyncConfig = Effect.suspend(() =>
  latestHistorySyncControl
    ? latestHistorySyncControl.getConfig
    : Effect.succeed({
        enabled: false,
        configured: false,
        status: readHistorySyncStatus(),
        intervalMs: defaultHistorySyncTiming.intervalMs,
        shutdownFlushTimeoutMs: defaultHistorySyncTiming.shutdownFlushTimeoutMs,
        statusIndicatorEnabled: true,
      } satisfies HistorySyncConfig),
);

export const updateHistorySyncConfig = (input: HistorySyncUpdateConfigInput) =>
  Effect.suspend(() =>
    latestHistorySyncControl
      ? latestHistorySyncControl.updateConfig(input)
      : Effect.fail(serviceNotReady()),
  );

export const startHistorySyncInitialImport = Effect.suspend(() =>
  latestHistorySyncControl
    ? latestHistorySyncControl.startInitialSync
    : Effect.fail(serviceNotReady()),
);

export const runHistorySync = Effect.suspend(() =>
  latestHistorySyncControl ? latestHistorySyncControl.runSync : Effect.fail(serviceNotReady()),
);

export const prioritizeHistorySyncThread = (threadId: string) =>
  Effect.suspend(() =>
    latestHistorySyncControl
      ? latestHistorySyncControl.prioritizeThreadSync(threadId)
      : Effect.fail(serviceNotReady()),
  );

export const restoreHistorySyncBackup = Effect.suspend(() =>
  latestHistorySyncControl
    ? latestHistorySyncControl.restoreBackup
    : Effect.fail(serviceNotReady()),
);

export const testHistorySyncConnection = (input: HistorySyncMysqlFields) =>
  Effect.suspend(() =>
    latestHistorySyncControl
      ? latestHistorySyncControl.testConnection(input)
      : Effect.fail(serviceNotReady()),
  );

export const getHistorySyncProjectMappings = Effect.suspend(() =>
  latestHistorySyncControl
    ? latestHistorySyncControl.getProjectMappings
    : Effect.fail(serviceNotReady()),
);

export const applyHistorySyncProjectMappings = (input: HistorySyncProjectMappingsApplyInput) =>
  Effect.suspend(() =>
    latestHistorySyncControl
      ? latestHistorySyncControl.applyProjectMappings(input)
      : Effect.fail(serviceNotReady()),
  );
