import { Context, Data, Effect, Layer, Option } from "effect";

import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { WorkerHealthSnapshot } from "@t3tools/shared/WorkerHealth";
import {
  CheckpointReactor,
  type CheckpointReactorShape,
} from "./orchestration/Services/CheckpointReactor.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "./orchestration/Services/ProviderCommandReactor.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "./orchestration/Services/ProviderRuntimeIngestion.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "./orchestration/Services/ThreadDeletionReactor.ts";
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
import { ServerRuntimeStartup, type ServerRuntimeStartupShape } from "./serverRuntimeStartup.ts";
import { TerminalManager, type TerminalManagerShape } from "./terminal/Services/Manager.ts";
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
  readonly providerRuntimeIngestion: WorkerHealthSnapshot | null;
  readonly providerCommandReactor: WorkerHealthSnapshot | null;
  readonly checkpointReactor: WorkerHealthSnapshot | null;
  readonly threadDeletionReactor: WorkerHealthSnapshot | null;
  readonly terminalHistoryPersistence: WorkerHealthSnapshot | null;
  readonly startupCommandGate: WorkerHealthSnapshot | null;
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
  readonly providerRuntimeIngestion: Option.Option<ProviderRuntimeIngestionShape>;
  readonly providerCommandReactor: Option.Option<ProviderCommandReactorShape>;
  readonly checkpointReactor: Option.Option<CheckpointReactorShape>;
  readonly threadDeletionReactor: Option.Option<ThreadDeletionReactorShape>;
  readonly terminalManager: Option.Option<TerminalManagerShape>;
  readonly serverRuntimeStartup: Option.Option<ServerRuntimeStartupShape>;
}) =>
  Effect.gen(function* () {
    const [
      maxEventSequence,
      projectionStates,
      activeSessions,
      lifecycleSnapshot,
      providerRuntimeIngestion,
      providerCommandReactor,
      checkpointReactor,
      threadDeletionReactor,
      terminalHistoryPersistence,
      startupCommandGate,
    ] = yield* Effect.all([
      services.eventStore.getMaxSequence(),
      services.projectionStateRepository.listAll(),
      services.providerService.listSessions(),
      services.lifecycleEvents.snapshot,
      collectOptionalHealth(services.providerRuntimeIngestion, (service) => service.health),
      collectOptionalHealth(services.providerCommandReactor, (service) => service.health),
      collectOptionalHealth(services.checkpointReactor, (service) => service.health),
      collectOptionalHealth(services.threadDeletionReactor, (service) => service.health),
      collectOptionalHealth(
        services.terminalManager,
        (service) => service.historyPersistenceHealth,
      ),
      collectOptionalHealth(services.serverRuntimeStartup, (service) => service.commandQueueHealth),
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
        providerRuntimeIngestion,
        providerCommandReactor,
        checkpointReactor,
        threadDeletionReactor,
        terminalHistoryPersistence,
        startupCommandGate,
      },
    } satisfies OperationalHealthSnapshot;
  });

const collectOptionalHealth = <A>(
  service: Option.Option<A>,
  health: (service: A) => Effect.Effect<WorkerHealthSnapshot>,
) =>
  Option.match(service, {
    onNone: () => Effect.succeed(null),
    onSome: (value) => health(value).pipe(Effect.map((snapshot) => snapshot)),
  });

export const collectOperationalHealth = Effect.gen(function* () {
  const eventStore = yield* OrchestrationEventStore;
  const projectionStateRepository = yield* ProjectionStateRepository;
  const providerService = yield* ProviderService;
  const lifecycleEvents = yield* ServerLifecycleEvents;
  const providerRuntimeIngestion = yield* Effect.serviceOption(ProviderRuntimeIngestionService);
  const providerCommandReactor = yield* Effect.serviceOption(ProviderCommandReactor);
  const checkpointReactor = yield* Effect.serviceOption(CheckpointReactor);
  const threadDeletionReactor = yield* Effect.serviceOption(ThreadDeletionReactor);
  const terminalManager = yield* Effect.serviceOption(TerminalManager);
  const serverRuntimeStartup = yield* Effect.serviceOption(ServerRuntimeStartup);

  return yield* collectOperationalHealthFrom({
    eventStore,
    projectionStateRepository,
    providerService,
    lifecycleEvents,
    providerRuntimeIngestion,
    providerCommandReactor,
    checkpointReactor,
    threadDeletionReactor,
    terminalManager,
    serverRuntimeStartup,
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
    const providerRuntimeIngestion = yield* Effect.serviceOption(ProviderRuntimeIngestionService);
    const providerCommandReactor = yield* Effect.serviceOption(ProviderCommandReactor);
    const checkpointReactor = yield* Effect.serviceOption(CheckpointReactor);
    const threadDeletionReactor = yield* Effect.serviceOption(ThreadDeletionReactor);
    const terminalManager = yield* Effect.serviceOption(TerminalManager);
    const serverRuntimeStartup = yield* Effect.serviceOption(ServerRuntimeStartup);

    return yield* collectOperationalHealthFrom({
      eventStore,
      projectionStateRepository,
      providerService,
      lifecycleEvents,
      providerRuntimeIngestion,
      providerCommandReactor,
      checkpointReactor,
      threadDeletionReactor,
      terminalManager,
      serverRuntimeStartup,
    }).pipe(Effect.mapError((cause) => new OperationalHealthError({ cause })));
  }),
} satisfies OperationalHealthServiceShape);
