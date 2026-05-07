import {
  CommandId,
  type OrchestrationThread,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import { Cause, Effect, Layer } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import {
  ProviderSessionRecovery,
  type ProviderSessionRecoveryShape,
} from "../Services/ProviderSessionRecovery.ts";

export const PROVIDER_SESSION_RECOVERY_RESTART_MESSAGE =
  "The app closed while this thread was working, and T3 Code could not automatically resume it. Review the latest output, then retry or send a follow-up when ready.";

const RECOVERY_CONCURRENCY = 4;

function isStaleRunningThread(thread: OrchestrationThread): boolean {
  return (
    thread.session?.status === "running" ||
    (thread.session !== null && thread.session.activeTurnId !== null) ||
    thread.latestTurn?.state === "running"
  );
}

function recoveryCommandId(threadId: ThreadId, outcome: "running" | "interrupted") {
  return CommandId.make(`provider-session-recovery:${outcome}:${threadId}:${crypto.randomUUID()}`);
}

const makeProviderSessionRecovery = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;

  const interruptThread = (thread: OrchestrationThread, now: string) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: recoveryCommandId(thread.id, "interrupted"),
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "interrupted",
        providerName: thread.session?.providerName ?? null,
        ...(thread.session?.providerInstanceId !== undefined
          ? { providerInstanceId: thread.session.providerInstanceId }
          : {}),
        runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
        activeTurnId: null,
        lastError: PROVIDER_SESSION_RECOVERY_RESTART_MESSAGE,
        updatedAt: now,
      },
      createdAt: now,
    });

  const markRecoveredRunning = (
    thread: OrchestrationThread,
    session: ProviderSession,
    now: string,
  ) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: recoveryCommandId(thread.id, "running"),
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "running",
        providerName: session.provider,
        ...(session.providerInstanceId !== undefined
          ? { providerInstanceId: session.providerInstanceId }
          : {}),
        runtimeMode: session.runtimeMode,
        activeTurnId: thread.session?.activeTurnId ?? thread.latestTurn?.turnId ?? null,
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    });

  const recoverThread = (thread: OrchestrationThread) =>
    Effect.gen(function* () {
      const recovered = yield* providerService.recoverSession(thread.id).pipe(Effect.exit);
      const now = new Date().toISOString();
      if (recovered._tag === "Success") {
        yield* markRecoveredRunning(thread, recovered.value, now).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider session recovery failed to mark thread running", {
              threadId: thread.id,
              cause: Cause.pretty(cause),
            }),
          ),
        );
        return;
      }

      yield* Effect.logWarning("provider session recovery failed", {
        threadId: thread.id,
        cause: Cause.pretty(recovered.cause),
      });
      yield* interruptThread(thread, now).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider session recovery failed to mark thread interrupted", {
            threadId: thread.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    });

  const recoverStaleRunningThreads: ProviderSessionRecoveryShape["recoverStaleRunningThreads"] =
    Effect.fn("recoverStaleRunningThreads")(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const staleThreads = readModel.threads.filter(isStaleRunningThread);
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
