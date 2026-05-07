import {
  HistorySyncConfigError,
  type HistorySyncProjectMappingPlan,
  type HistorySyncProjectMappingsApplyInput,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { describeSyncFailure } from "./config.ts";
import type { HistorySyncStateRow } from "./localRepository.ts";
import type { HistorySyncEventRow } from "./planner.ts";

export interface HistorySyncProjectMappingControllerDependencies {
  readonly getConnectionString: Effect.Effect<string | null, object>;
  readonly readRemoteEvents: (
    connectionString: string,
  ) => Effect.Effect<readonly HistorySyncEventRow[], object>;
  readonly buildProjectMappingPlanFromEvents: (input: {
    readonly remoteEvents: readonly HistorySyncEventRow[];
    readonly remoteMaxSequence: number;
  }) => Effect.Effect<HistorySyncProjectMappingPlan, object>;
  readonly autoPersistExactProjectMappings: (
    plan: HistorySyncProjectMappingPlan,
  ) => Effect.Effect<void, object>;
  readonly getSyncId: (remoteMaxSequence: number) => Effect.Effect<string, object>;
  readonly applyMappingActions: (input: {
    readonly actions: HistorySyncProjectMappingsApplyInput["actions"];
    readonly remoteEvents: readonly HistorySyncEventRow[];
    readonly now: string;
  }) => Effect.Effect<void, object>;
  readonly clearStopped: () => Effect.Effect<void>;
  readonly readState: Effect.Effect<HistorySyncStateRow | null, object>;
  readonly syncNow: () => Effect.Effect<void>;
  readonly startInitialSync: () => Effect.Effect<void, object>;
}

function requireConnectionString(
  connectionString: string | null,
): Effect.Effect<string, HistorySyncConfigError> {
  if (connectionString !== null) return Effect.succeed(connectionString);
  return Effect.fail(
    new HistorySyncConfigError({
      message: "History sync MySQL connection is not configured.",
    }),
  );
}

function remoteMaxSequence(events: readonly HistorySyncEventRow[]): number {
  return Math.max(0, ...events.map((event) => event.sequence));
}

export function createHistorySyncProjectMappingController(
  input: HistorySyncProjectMappingControllerDependencies,
) {
  const getProjectMappings = Effect.gen(function* () {
    const connectionString = yield* input.getConnectionString.pipe(
      Effect.flatMap(requireConnectionString),
    );
    const remoteEvents = yield* input.readRemoteEvents(connectionString);
    const maxSequence = remoteMaxSequence(remoteEvents);
    const plan = yield* input.buildProjectMappingPlanFromEvents({
      remoteEvents,
      remoteMaxSequence: maxSequence,
    });
    yield* input.autoPersistExactProjectMappings(plan);
    return yield* input.buildProjectMappingPlanFromEvents({
      remoteEvents,
      remoteMaxSequence: maxSequence,
    });
  }).pipe(
    Effect.mapError((cause) => new HistorySyncConfigError({ message: describeSyncFailure(cause) })),
  );

  const applyProjectMappings = (mappingInput: HistorySyncProjectMappingsApplyInput) =>
    Effect.gen(function* () {
      const connectionString = yield* input.getConnectionString.pipe(
        Effect.flatMap(requireConnectionString),
      );
      const remoteEvents = yield* input.readRemoteEvents(connectionString);
      const maxSequence = remoteMaxSequence(remoteEvents);
      const expectedSyncId = yield* input.getSyncId(maxSequence);
      if (mappingInput.syncId !== expectedSyncId) {
        return yield* new HistorySyncConfigError({
          message: "History sync mapping plan is stale. Reload the project mapping wizard.",
        });
      }

      const now = new Date().toISOString();
      yield* input.applyMappingActions({
        actions: mappingInput.actions,
        remoteEvents,
        now,
      });
      yield* input.clearStopped();
      const state = yield* input.readState;
      if (state?.hasCompletedInitialSync === 1) {
        yield* input.syncNow();
      } else {
        yield* input.startInitialSync();
      }
      return yield* input.buildProjectMappingPlanFromEvents({
        remoteEvents,
        remoteMaxSequence: maxSequence,
      });
    }).pipe(
      Effect.mapError(
        (cause) => new HistorySyncConfigError({ message: describeSyncFailure(cause) }),
      ),
    );

  return {
    getProjectMappings,
    applyProjectMappings,
  };
}
