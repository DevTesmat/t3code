import { HistorySyncConfigError, type HistorySyncStatus } from "@t3tools/contracts";
import { Effect, Schema } from "effect";

import { describeSyncFailure } from "./config.ts";
import type { HistorySyncStateRow } from "./localRepository.ts";

export interface HistorySyncRestoreControllerDependencies {
  readonly restoreBackupTablesFromDisk: Effect.Effect<void, object>;
  readonly reloadProjections: Effect.Effect<void, HistorySyncConfigError>;
  readonly readState: Effect.Effect<HistorySyncStateRow | null, object>;
  readonly getConnectionString: Effect.Effect<string | null, object>;
  readonly publishStatus: (status: HistorySyncStatus) => Effect.Effect<void>;
}

export function createHistorySyncRestoreController(
  input: HistorySyncRestoreControllerDependencies,
) {
  const restoreBackupFromDisk = Effect.gen(function* () {
    yield* input.restoreBackupTablesFromDisk;
    yield* input.reloadProjections;
    const restoredState = yield* input.readState.pipe(Effect.catch(() => Effect.succeed(null)));
    const connectionString = yield* input.getConnectionString;
    yield* input.publishStatus(
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
  }).pipe(
    Effect.catch((cause) =>
      Schema.is(HistorySyncConfigError)(cause)
        ? Effect.fail(cause)
        : Effect.fail(
            new HistorySyncConfigError({
              message: describeSyncFailure(cause),
            }),
          ),
    ),
  );

  return { restoreBackupFromDisk };
}
