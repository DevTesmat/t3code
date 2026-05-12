import type {
  OrchestrationLatestTurn,
  OrchestrationProject,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationSession,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  IsoDateTime,
  MessageId,
  ModelSelection,
  NonNegativeInt,
  OrchestrationCommand,
  OrchestrationReadModel as OrchestrationReadModelSchema,
  OrchestrationProposedPlanId,
  ProjectId as ProjectIdSchema,
  ProjectScript,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId as ThreadIdSchema,
  TurnId,
} from "@t3tools/contracts";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Metric,
  Option,
  PubSub,
  Queue,
  Schema,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";

interface CommandEnvelope {
  command: OrchestrationCommand;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}

const ORCHESTRATION_COMMAND_QUEUE_CAPACITY = 2_000;
const ORCHESTRATION_EVENT_PUBSUB_CAPACITY = 10_000;

const decodeDecisionReadModel = Schema.decodeUnknownEffect(OrchestrationReadModelSchema);
const DecisionProjectRow = Schema.Struct({
  projectId: ProjectIdSchema,
  title: Schema.String,
  workspaceRoot: Schema.String,
  defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
  scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
const DecisionThreadRow = Schema.Struct({
  threadId: ThreadIdSchema,
  projectId: ProjectIdSchema,
  title: Schema.String,
  modelSelection: Schema.fromJsonString(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: Schema.Literals(["default", "plan"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  pinnedAt: Schema.NullOr(IsoDateTime),
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});
const DecisionThreadSessionRow = Schema.Struct({
  threadId: ThreadIdSchema,
  status: Schema.Literals([
    "idle",
    "starting",
    "running",
    "needs_resume",
    "ready",
    "interrupted",
    "stopped",
    "error",
  ]),
  providerName: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  runtimeMode: RuntimeMode,
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
const DecisionLatestTurnRow = Schema.Struct({
  threadId: ThreadIdSchema,
  turnId: TurnId,
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadIdSchema),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
});
const DecisionThreadWorkDurationRow = Schema.Struct({
  threadId: ThreadIdSchema,
  totalWorkDurationMs: NonNegativeInt,
});

function maxIso(left: string | null, right: string | null): string | null {
  if (right === null) {
    return left;
  }
  if (left === null || right > left) {
    return right;
  }
  return left;
}

function compactDecisionReadModel(readModel: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...readModel,
    threads: readModel.threads.map((thread) => ({
      ...thread,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    })),
  };
}

function mapLatestTurn(
  row: Schema.Schema.Type<typeof DecisionLatestTurnRow>,
): OrchestrationLatestTurn {
  return {
    turnId: row.turnId,
    state:
      row.state === "error"
        ? "error"
        : row.state === "needs_resume"
          ? "needs_resume"
          : row.state === "interrupted"
            ? "interrupted"
            : row.state === "completed"
              ? "completed"
              : "running",
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    assistantMessageId: row.assistantMessageId,
    ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
      ? {
          sourceProposedPlan: {
            threadId: row.sourceProposedPlanThreadId,
            planId: row.sourceProposedPlanId,
          },
        }
      : {}),
  };
}

function mapSession(
  row: Schema.Schema.Type<typeof DecisionThreadSessionRow>,
): OrchestrationSession {
  return {
    threadId: row.threadId,
    status: row.status,
    providerName: row.providerName,
    ...(row.providerInstanceId !== null ? { providerInstanceId: row.providerInstanceId } : {}),
    runtimeMode: row.runtimeMode,
    activeTurnId: row.activeTurnId,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const listDecisionProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DecisionProjectRow,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });
  const listDecisionThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DecisionThreadRow,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          pinned_at AS "pinnedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  });
  const listDecisionThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DecisionThreadSessionRow,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `,
  });
  const listDecisionLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DecisionLatestTurnRow,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          assistant_message_id AS "assistantMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_turns
        WHERE turn_id IS NOT NULL
        ORDER BY thread_id ASC, requested_at DESC, turn_id DESC
      `,
  });
  const listDecisionThreadWorkDurationRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DecisionThreadWorkDurationRow,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          CAST(
            COALESCE(
              SUM(
                CASE
                  WHEN turn_id IS NOT NULL AND work_duration_ms IS NOT NULL
                  THEN work_duration_ms
                  WHEN turn_id IS NOT NULL
                    AND started_at IS NOT NULL
                    AND completed_at IS NOT NULL
                    AND julianday(completed_at) >= julianday(started_at)
                  THEN ROUND((julianday(completed_at) - julianday(started_at)) * 86400000)
                  ELSE 0
                END
              ),
              0
            ) AS INTEGER
          ) AS "totalWorkDurationMs"
        FROM projection_turns
        GROUP BY thread_id
        ORDER BY thread_id ASC
      `,
  });

  const loadDecisionReadModel = (): Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  > =>
    sql
      .withTransaction(
        Effect.all([
          listDecisionProjectRows(undefined).pipe(
            Effect.mapError((error) =>
              Schema.isSchemaError(error)
                ? toPersistenceDecodeError(
                    "OrchestrationEngine.loadDecisionReadModel:listProjects:decodeRows",
                  )(error)
                : toPersistenceSqlError(
                    "OrchestrationEngine.loadDecisionReadModel:listProjects:query",
                  )(error),
            ),
          ),
          listDecisionThreadRows(undefined).pipe(
            Effect.mapError((error) =>
              Schema.isSchemaError(error)
                ? toPersistenceDecodeError(
                    "OrchestrationEngine.loadDecisionReadModel:listThreads:decodeRows",
                  )(error)
                : toPersistenceSqlError(
                    "OrchestrationEngine.loadDecisionReadModel:listThreads:query",
                  )(error),
            ),
          ),
          listDecisionThreadSessionRows(undefined).pipe(
            Effect.mapError((error) =>
              Schema.isSchemaError(error)
                ? toPersistenceDecodeError(
                    "OrchestrationEngine.loadDecisionReadModel:listSessions:decodeRows",
                  )(error)
                : toPersistenceSqlError(
                    "OrchestrationEngine.loadDecisionReadModel:listSessions:query",
                  )(error),
            ),
          ),
          listDecisionLatestTurnRows(undefined).pipe(
            Effect.mapError((error) =>
              Schema.isSchemaError(error)
                ? toPersistenceDecodeError(
                    "OrchestrationEngine.loadDecisionReadModel:listLatestTurns:decodeRows",
                  )(error)
                : toPersistenceSqlError(
                    "OrchestrationEngine.loadDecisionReadModel:listLatestTurns:query",
                  )(error),
            ),
          ),
          listDecisionThreadWorkDurationRows(undefined).pipe(
            Effect.mapError((error) =>
              Schema.isSchemaError(error)
                ? toPersistenceDecodeError(
                    "OrchestrationEngine.loadDecisionReadModel:listWorkDurations:decodeRows",
                  )(error)
                : toPersistenceSqlError(
                    "OrchestrationEngine.loadDecisionReadModel:listWorkDurations:query",
                  )(error),
            ),
          ),
          projectionSnapshotQuery.getSnapshotSequence(),
        ]),
      )
      .pipe(
        Effect.catchTag("SqlError", (sqlError) =>
          Effect.fail(
            toPersistenceSqlError("OrchestrationEngine.loadDecisionReadModel:transaction")(
              sqlError,
            ),
          ),
        ),
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            sessionRows,
            latestTurnRows,
            workDurationRows,
            snapshotSequence,
          ]) => {
            const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();
            const sessionByThread = new Map<string, OrchestrationSession>();
            const workDurationByThread = new Map(
              workDurationRows.map((row) => [row.threadId, row.totalWorkDurationMs] as const),
            );
            let updatedAt: string | null = null;

            for (const row of projectRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }
            for (const row of threadRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }
            for (const row of latestTurnRows) {
              updatedAt = maxIso(updatedAt, row.requestedAt);
              updatedAt = maxIso(updatedAt, row.startedAt);
              updatedAt = maxIso(updatedAt, row.completedAt);
              if (!latestTurnByThread.has(row.threadId)) {
                latestTurnByThread.set(row.threadId, mapLatestTurn(row));
              }
            }
            for (const row of sessionRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
              sessionByThread.set(row.threadId, mapSession(row));
            }

            const activeThreadProjectIds = new Set(
              threadRows.filter((row) => row.deletedAt === null).map((row) => row.projectId),
            );
            const projects: ReadonlyArray<OrchestrationProject> = projectRows.map((row) => ({
              id: row.projectId,
              title: row.title,
              workspaceRoot: row.workspaceRoot,
              repositoryIdentity: null,
              defaultModelSelection: row.defaultModelSelection,
              scripts: row.scripts,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              deletedAt:
                row.deletedAt !== null && activeThreadProjectIds.has(row.projectId)
                  ? null
                  : row.deletedAt,
            }));
            const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) => ({
              id: row.threadId,
              projectId: row.projectId,
              title: row.title,
              modelSelection: row.modelSelection,
              runtimeMode: row.runtimeMode,
              interactionMode: row.interactionMode,
              branch: row.branch,
              worktreePath: row.worktreePath,
              latestTurn: latestTurnByThread.get(row.threadId) ?? null,
              totalWorkDurationMs: workDurationByThread.get(row.threadId) ?? 0,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              pinnedAt: row.pinnedAt,
              archivedAt: row.archivedAt,
              deletedAt: row.deletedAt,
              messages: [],
              proposedPlans: [],
              activities: [],
              checkpoints: [],
              session: sessionByThread.get(row.threadId) ?? null,
            }));

            return decodeDecisionReadModel({
              snapshotSequence,
              projects,
              threads,
              updatedAt: updatedAt ?? new Date(0).toISOString(),
            }).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  "OrchestrationEngine.loadDecisionReadModel:decodeReadModel",
                ),
              ),
            );
          },
        ),
        Effect.map(compactDecisionReadModel),
      );

  let readModel = createEmptyReadModel(new Date().toISOString());

  const commandQueue = yield* Queue.bounded<CommandEnvelope>(ORCHESTRATION_COMMAND_QUEUE_CAPACITY);
  const eventPubSub = yield* PubSub.bounded<OrchestrationEvent>(
    ORCHESTRATION_EVENT_PUBSUB_CAPACITY,
  );

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = readModel.snapshotSequence;
    const processingStartedAtMs = Date.now();
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      let nextReadModel = readModel;
      for (const persistedEvent of persistedEvents) {
        nextReadModel = compactDecisionReadModel(
          yield* projectEvent(nextReadModel, persistedEvent),
        );
      }
      readModel = nextReadModel;

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          if (existingReceipt.value.status === "accepted") {
            return {
              sequence: existingReceipt.value.resultSequence,
            };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        const eventBase = yield* decideOrchestrationCommand({
          command: envelope.command,
          readModel,
          lookups: {
            getThreadProposedPlanById: (input) =>
              projectionSnapshotQuery.getThreadProposedPlanById(input).pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationCommandInvariantError({
                      commandType: envelope.command.type,
                      detail: `Failed to load proposed plan '${input.planId}' for thread '${input.threadId}': ${String(cause)}`,
                    }),
                ),
              ),
          },
        });
        const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const committedEvents: OrchestrationEvent[] = [];
              let nextReadModel = readModel;

              for (const nextEvent of eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                nextReadModel = compactDecisionReadModel(
                  yield* projectEvent(nextReadModel, savedEvent),
                );
                yield* projectionPipeline.projectEvent(savedEvent);
                committedEvents.push(savedEvent);
              }

              const lastSavedEvent = committedEvents.at(-1) ?? null;
              if (lastSavedEvent === null) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command produced no events.",
                });
              }

              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: lastSavedEvent.aggregateKind,
                aggregateId: lastSavedEvent.aggregateId,
                acceptedAt: lastSavedEvent.occurredAt,
                resultSequence: lastSavedEvent.sequence,
                status: "accepted",
                error: null,
              });

              return {
                committedEvents,
                lastSequence: lastSavedEvent.sequence,
                nextReadModel,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        readModel = committedCommand.nextReadModel;
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          yield* PubSub.publish(eventPubSub, event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, Date.now() - envelope.startedAtMs)),
            );
          }
        }
        return { sequence: committedCommand.lastSequence };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, Date.now() - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (!Schema.is(OrchestrationCommandPreviouslyRejectedError)(error)) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: readModel.snapshotSequence,
                  }),
                ),
              ),
            );

            if (Schema.is(OrchestrationCommandInvariantError)(error)) {
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: new Date().toISOString(),
                  resultSequence: readModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  yield* projectionPipeline.bootstrap;
  readModel = yield* loadDecisionReadModel();

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  yield* Effect.forkScoped(worker);
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: readModel.snapshotSequence }),
  );

  const getReadModel: OrchestrationEngineShape["getReadModel"] = () =>
    projectionSnapshotQuery.getSnapshot().pipe(Effect.orDie);

  const reloadFromStorage = () =>
    Effect.gen(function* () {
      yield* projectionPipeline.bootstrap;
      readModel = yield* loadDecisionReadModel();
      return yield* projectionSnapshotQuery.getSnapshot();
    });

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive, limit) =>
    eventStore.readFromSequence(fromSequenceExclusive, limit);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, { command, result, startedAtMs: Date.now() });
      return yield* Deferred.await(result);
    });

  return {
    getReadModel,
    reloadFromStorage,
    readEvents,
    dispatch,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
);
