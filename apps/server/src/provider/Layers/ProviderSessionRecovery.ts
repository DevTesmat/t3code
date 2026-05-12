import { CommandId, type OrchestrationThreadShell, type ThreadId } from "@t3tools/contracts";
import { Cause, Effect, Layer } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderSessionRecovery,
  type ProviderSessionRecoveryShape,
} from "../Services/ProviderSessionRecovery.ts";

const RECOVERY_CONCURRENCY = 4;

function isStaleRunningThread(thread: OrchestrationThreadShell): boolean {
  return (
    thread.session?.status === "running" ||
    (thread.session !== null && thread.session.activeTurnId !== null) ||
    thread.latestTurn?.state === "running"
  );
}

function recoveryCommandId(threadId: ThreadId) {
  return CommandId.make(
    `provider-session-recovery:needs-resume:${threadId}:${crypto.randomUUID()}`,
  );
}

const makeProviderSessionRecovery = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const markNeedsResume = (thread: OrchestrationThreadShell, now: string) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: recoveryCommandId(thread.id),
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "needs_resume",
        providerName: thread.session?.providerName ?? null,
        ...(thread.session?.providerInstanceId !== undefined
          ? { providerInstanceId: thread.session.providerInstanceId }
          : {}),
        runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    });

  const recoverThread = (thread: OrchestrationThreadShell) =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      yield* markNeedsResume(thread, now).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider session recovery failed to mark thread needs_resume", {
            threadId: thread.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    });

  const recoverStaleRunningThreads: ProviderSessionRecoveryShape["recoverStaleRunningThreads"] =
    Effect.fn("recoverStaleRunningThreads")(function* () {
      const shellSnapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider session recovery failed to read shell snapshot", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(null)),
        ),
      );
      if (shellSnapshot === null) {
        return;
      }
      const staleThreads = shellSnapshot.threads.filter(isStaleRunningThread);
      if (staleThreads.length === 0) {
        return;
      }

      yield* Effect.logInfo("provider session recovery started", {
        threadCount: staleThreads.length,
      });
      yield* Effect.forEach(staleThreads, recoverThread, {
        concurrency: RECOVERY_CONCURRENCY,
        discard: true,
      });
      yield* Effect.logInfo("provider session recovery completed", {
        threadCount: staleThreads.length,
      });
    });

  return {
    recoverStaleRunningThreads,
  } satisfies ProviderSessionRecoveryShape;
});

export const ProviderSessionRecoveryLive = Layer.effect(
  ProviderSessionRecovery,
  makeProviderSessionRecovery,
);
