import { Context, Data, Effect, Layer, Option } from "effect";

import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "./persistence/Services/OrchestrationEventStore.ts";
import {
  ProjectionStateRepository,
  type ProjectionStateRepositoryShape,
} from "./persistence/Services/ProjectionState.ts";
import { ProviderService } from "./provider/Services/ProviderService.ts";
import { ServerLifecycleEvents, type ServerLifecycleEventsShape } from "./serverLifecycleEvents.ts";
import type { ProviderServiceShape } from "./provider/Services/ProviderService.ts";

export interface OperationalProjectionLagSnapshot {
  readonly maxEventSequence: number;
  readonly minAppliedSequence: number | null;
  readonly lagEvents: number | null;
  readonly projectors: ReadonlyArray<{
    readonly projector: string;
    readonly lastAppliedSequence: number;
    readonly lagEvents: number;
    readonly updatedAt: string;
  }>;
}

export interface OperationalProviderSessionsSnapshot {
  readonly activeCount: number;
  readonly byProvider: Readonly<Record<ProviderDriverKind, number>>;
  readonly byProviderInstance: Readonly<Record<ProviderInstanceId, number>>;
  readonly activeTurnCount: number;
}

export interface OperationalStartupSnapshot {
  readonly lifecycleSequence: number;
  readonly ready: boolean;
  readonly readyAt: string | null;
  readonly latestEventTypes: ReadonlyArray<"welcome" | "ready">;
}

export interface OperationalQueueSnapshot {
  readonly orchestrationCommandBacklog: null;
  readonly projectionBacklog: null;
}

export interface OperationalHealthSnapshot {
  readonly ok: boolean;
  readonly generatedAt: string;
  readonly projection: OperationalProjectionLagSnapshot;
  readonly providerSessions: OperationalProviderSessionsSnapshot;
  readonly startup: OperationalStartupSnapshot;
  readonly queues: OperationalQueueSnapshot;
}

export class OperationalHealthError extends Data.TaggedError("OperationalHealthError")<{
  readonly cause: unknown;
}> {}

export interface OperationalHealthServiceShape {
  readonly snapshot: Effect.Effect<OperationalHealthSnapshot, OperationalHealthError>;
}

export class OperationalHealthService extends Context.Service<
  OperationalHealthService,
  OperationalHealthServiceShape
>()("t3/operationalHealth") {}

function incrementRecord<K extends string>(record: Record<K, number>, key: K): void {
  record[key] = (record[key] ?? 0) + 1;
}

const collectOperationalHealthFrom = (services: {
  readonly eventStore: OrchestrationEventStoreShape;
  readonly projectionStateRepository: ProjectionStateRepositoryShape;
  readonly providerService: ProviderServiceShape;
  readonly lifecycleEvents: ServerLifecycleEventsShape;
}) =>
  Effect.gen(function* () {
    const [maxEventSequence, projectionStates, activeSessions, lifecycleSnapshot] =
      yield* Effect.all([
        services.eventStore.getMaxSequence(),
        services.projectionStateRepository.listAll(),
        services.providerService.listSessions(),
        services.lifecycleEvents.snapshot,
      ]);

    const minAppliedSequence =
      projectionStates.length === 0
        ? null
        : Math.min(...projectionStates.map((state) => state.lastAppliedSequence));
    const readyEvent = lifecycleSnapshot.events.find((event) => event.type === "ready");
    const byProvider: Record<ProviderDriverKind, number> = {};
    const byProviderInstance: Record<ProviderInstanceId, number> = {};
    let activeTurnCount = 0;

    for (const session of activeSessions) {
      incrementRecord(byProvider, session.provider);
      if (session.providerInstanceId !== undefined) {
        incrementRecord(byProviderInstance, session.providerInstanceId);
      }
      if (session.activeTurnId !== undefined) {
        activeTurnCount += 1;
      }
    }

    return {
      ok: readyEvent !== undefined,
      generatedAt: new Date().toISOString(),
      projection: {
        maxEventSequence,
        minAppliedSequence,
        lagEvents:
          minAppliedSequence === null ? null : Math.max(0, maxEventSequence - minAppliedSequence),
        projectors: projectionStates.map((state) => ({
          projector: state.projector,
          lastAppliedSequence: state.lastAppliedSequence,
          lagEvents: Math.max(0, maxEventSequence - state.lastAppliedSequence),
          updatedAt: state.updatedAt,
        })),
      },
      providerSessions: {
        activeCount: activeSessions.length,
        byProvider,
        byProviderInstance,
        activeTurnCount,
      },
      startup: {
        lifecycleSequence: lifecycleSnapshot.sequence,
        ready: readyEvent !== undefined,
        readyAt: readyEvent?.payload.at ?? null,
        latestEventTypes: lifecycleSnapshot.events.map((event) => event.type),
      },
      queues: {
        orchestrationCommandBacklog: null,
        projectionBacklog: null,
      },
    } satisfies OperationalHealthSnapshot;
  });

export const collectOperationalHealth = Effect.gen(function* () {
  const eventStore = yield* OrchestrationEventStore;
  const projectionStateRepository = yield* ProjectionStateRepository;
  const providerService = yield* ProviderService;
  const lifecycleEvents = yield* ServerLifecycleEvents;

  return yield* collectOperationalHealthFrom({
    eventStore,
    projectionStateRepository,
    providerService,
    lifecycleEvents,
  });
});

const requireService = <A>(serviceName: string, option: Option.Option<A>) =>
  option.pipe(
    Option.match({
      onNone: () =>
        Effect.fail(new OperationalHealthError({ cause: `${serviceName} is unavailable.` })),
      onSome: Effect.succeed,
    }),
  );

export const OperationalHealthLive = Layer.succeed(OperationalHealthService, {
  snapshot: Effect.gen(function* () {
    const eventStore = yield* requireService(
      "OrchestrationEventStore",
      yield* Effect.serviceOption(OrchestrationEventStore),
    );
    const projectionStateRepository = yield* requireService(
      "ProjectionStateRepository",
      yield* Effect.serviceOption(ProjectionStateRepository),
    );
    const providerService = yield* requireService(
      "ProviderService",
      yield* Effect.serviceOption(ProviderService),
    );
    const lifecycleEvents = yield* requireService(
      "ServerLifecycleEvents",
      yield* Effect.serviceOption(ServerLifecycleEvents),
    );

    return yield* collectOperationalHealthFrom({
      eventStore,
      projectionStateRepository,
      providerService,
      lifecycleEvents,
    }).pipe(Effect.mapError((cause) => new OperationalHealthError({ cause })));
  }),
} satisfies OperationalHealthServiceShape);
