import {
  HistorySyncConfigError,
  type HistorySyncProjectMappingPlan,
  type HistorySyncProjectMappingsApplyInput,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { describeSyncFailure } from "./config.ts";
import type { HistorySyncStateRow } from "./localRepository.ts";
import type { ProjectCandidate } from "./planner.ts";

export interface HistorySyncProjectMappingControllerDependencies {
  readonly getConnectionString: Effect.Effect<string | null, object>;
  readonly readRemoteMaxSequence: (connectionString: string) => Effect.Effect<number, object>;
  readonly readRemoteProjectMappingCandidates: (
    connectionString: string,
  ) => Effect.Effect<readonly ProjectCandidate[], object>;
  readonly buildProjectMappingPlanFromCandidates: (input: {
    readonly remoteProjects: readonly ProjectCandidate[];
    readonly remoteMaxSequence: number;
  }) => Effect.Effect<HistorySyncProjectMappingPlan, object>;
  readonly autoPersistExactProjectMappings: (
    plan: HistorySyncProjectMappingPlan,
  ) => Effect.Effect<void, object>;
  readonly getSyncId: (remoteMaxSequence: number) => Effect.Effect<string, object>;
  readonly applyMappingActionsForProjectCandidates: (input: {
    readonly actions: HistorySyncProjectMappingsApplyInput["actions"];
    readonly remoteProjects: readonly ProjectCandidate[];
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

export function planProjectMappingApplyContinuation(
  state: Pick<HistorySyncStateRow, "hasCompletedInitialSync"> | null,
): "sync-now" | "start-initial-sync" {
  return state?.hasCompletedInitialSync === 1 ? "sync-now" : "start-initial-sync";
}

export function createHistorySyncProjectMappingController(
  input: HistorySyncProjectMappingControllerDependencies,
) {
  const getProjectMappings = Effect.gen(function* () {
    const connectionString = yield* input.getConnectionString.pipe(
      Effect.flatMap(requireConnectionString),
    );
    const [remoteProjects, maxSequence] = yield* Effect.all([
      input.readRemoteProjectMappingCandidates(connectionString),
      input.readRemoteMaxSequence(connectionString),
    ]);
    const plan = yield* input.buildProjectMappingPlanFromCandidates({
      remoteProjects,
      remoteMaxSequence: maxSequence,
    });
    yield* input.autoPersistExactProjectMappings(plan);
    return yield* input.buildProjectMappingPlanFromCandidates({
      remoteProjects,
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
      const [remoteProjects, maxSequence] = yield* Effect.all([
        input.readRemoteProjectMappingCandidates(connectionString),
        input.readRemoteMaxSequence(connectionString),
      ]);
      const expectedSyncId = yield* input.getSyncId(maxSequence);
      if (mappingInput.syncId !== expectedSyncId) {
        return yield* new HistorySyncConfigError({
          message: "History sync mapping plan is stale. Reload the project mapping wizard.",
        });
      }

      const now = new Date().toISOString();
      yield* input.applyMappingActionsForProjectCandidates({
        actions: mappingInput.actions,
        remoteProjects,
        now,
      });
      yield* input.clearStopped();
      const state = yield* input.readState;
      const continuation = planProjectMappingApplyContinuation(state);
      if (continuation === "sync-now") {
        yield* input.syncNow();
      } else {
        yield* input.startInitialSync();
      }
      return yield* input.buildProjectMappingPlanFromCandidates({
        remoteProjects,
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
