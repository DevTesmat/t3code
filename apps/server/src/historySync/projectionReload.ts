import { HistorySyncConfigError } from "@t3tools/contracts";
import { Effect } from "effect";

import {
  type ProjectionBootstrapProgress,
  subscribeProjectionBootstrapProgress,
} from "../orchestration/Layers/ProjectionPipeline.ts";

export interface HistorySyncProgress {
  readonly phase: string;
  readonly label: string;
  readonly current: number;
  readonly total: number;
}

export interface HistorySyncProjectionReloadContext {
  readonly startedAt: string;
  readonly lastSyncedAt: string | null;
}

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

export function projectionProgressLabel(progress: ProjectionBootstrapProgress): string {
  return `Projecting ${progress.projector.replace(/^projection\./, "").replace(/-/g, " ")}`;
}

export const reloadHistorySyncProjections = (input: {
  readonly reloadFromStorage?: () => Effect.Effect<unknown, object>;
  readonly context?: HistorySyncProjectionReloadContext;
  readonly publishProgress?: (
    input: HistorySyncProjectionReloadContext & { readonly progress: HistorySyncProgress },
  ) => Effect.Effect<void>;
  readonly subscribeProgress?: typeof subscribeProjectionBootstrapProgress;
}): Effect.Effect<void, HistorySyncConfigError> => {
  if (!input.reloadFromStorage) return Effect.void;

  const context = input.context;
  const reloadFromStorage = input.reloadFromStorage;
  const subscribeProgress = input.subscribeProgress ?? subscribeProjectionBootstrapProgress;
  const reload = context
    ? Effect.gen(function* () {
        const unsubscribe = yield* subscribeProgress((progress) =>
          input.publishProgress
            ? input.publishProgress({
                ...context,
                progress: {
                  phase: "projecting",
                  label: projectionProgressLabel(progress),
                  current: progress.projectedCount,
                  total: Math.max(1, progress.maxSequence),
                },
              })
            : Effect.void,
        );
        yield* reloadFromStorage().pipe(Effect.ensuring(Effect.sync(unsubscribe)));
      })
    : reloadFromStorage();

  return reload.pipe(
    Effect.mapError(
      (cause) =>
        new HistorySyncConfigError({
          message: `Projection reload failed: ${describeUnknownError(cause)}`,
        }),
    ),
    Effect.asVoid,
  );
};
