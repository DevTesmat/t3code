import { CommandId, EventId } from "@t3tools/contracts";
import { Duration, Effect, Layer, Schedule } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const NEEDS_RESUME_INACTIVITY_MESSAGE =
  "No provider, tool, or subagent activity was observed while this thread was working. Review the latest output, then resume when ready.";

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const orchestrationEngine = yield* OrchestrationEngineService;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const sweep = Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const threadsById = new Map(readModel.threads.map((thread) => [thread.id, thread] as const));
      const bindings = yield* directory.listBindings();
      const now = Date.now();
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const idleDurationMs = now - lastSeenMs;
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }

        const thread = threadsById.get(binding.threadId);
        if (thread?.session?.activeTurnId != null) {
          const nowIso = new Date(now).toISOString();
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(
              `provider-session-reaper:needs-resume-activity:${binding.threadId}:${crypto.randomUUID()}`,
            ),
            threadId: binding.threadId,
            activity: {
              id: EventId.make(crypto.randomUUID()),
              tone: "error",
              kind: "provider.session.needs_resume",
              summary: "Thread needs resume",
              payload: {
                detail: NEEDS_RESUME_INACTIVITY_MESSAGE,
                idleDurationMs,
                provider: binding.provider,
              },
              turnId: thread.session.activeTurnId,
              createdAt: nowIso,
            },
            createdAt: nowIso,
          });
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(
              `provider-session-reaper:needs-resume:${binding.threadId}:${crypto.randomUUID()}`,
            ),
            threadId: binding.threadId,
            session: {
              threadId: binding.threadId,
              status: "needs_resume",
              providerName: thread.session.providerName,
              ...(thread.session.providerInstanceId !== undefined
                ? { providerInstanceId: thread.session.providerInstanceId }
                : {}),
              runtimeMode: thread.session.runtimeMode,
              activeTurnId: null,
              lastError: null,
              updatedAt: nowIso,
            },
            createdAt: nowIso,
          });
          yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.session.reaper.stop-active-needs-resume-failed", {
                threadId: binding.threadId,
                provider: binding.provider,
                idleDurationMs,
                cause,
              }),
            ),
          );
          reapedCount += 1;
          yield* Effect.logInfo("provider.session.marked-needs-resume", {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
            idleDurationMs,
          });
          continue;
        }

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              reason: "inactivity_threshold",
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
