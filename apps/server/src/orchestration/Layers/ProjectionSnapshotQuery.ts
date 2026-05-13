import {
  CheckpointRef,
  ChatAttachment,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationProposedPlanId,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ProjectScript,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationProjectShell,
  type OrchestrationProject,
  type OrchestrationSession,
  type OrchestrationThreadDetailPageInfo,
  type OrchestrationThreadShell,
  ModelSelection,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { ProjectionCheckpoint } from "../../persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionState } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSession } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotCounts,
  type ProjectionThreadCheckpointContext,
  type ProjectionThreadCheckpointRevertContext,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const decodeShellSnapshot = Schema.decodeUnknownEffect(OrchestrationShellSnapshot);
const decodeThread = Schema.decodeUnknownEffect(OrchestrationThread);
const decodeMessages = Schema.decodeUnknownEffect(Schema.Array(OrchestrationMessage));
const decodeActivities = Schema.decodeUnknownEffect(Schema.Array(OrchestrationThreadActivity));
const decodeProposedPlans = Schema.decodeUnknownEffect(Schema.Array(OrchestrationProposedPlan));
const decodeCheckpoints = Schema.decodeUnknownEffect(Schema.Array(OrchestrationCheckpointSummary));
const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  }),
);
const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
  }),
);
const ProjectionThreadProposedPlanDbRowSchema = ProjectionThreadProposedPlan;
const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
  }),
);
const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession;
const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);
const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  turnId: TurnId,
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
});
const ProjectionThreadWorkDurationDbRowSchema = Schema.Struct({
  threadId: ThreadId,
  totalWorkDurationMs: NonNegativeInt,
});
const ProjectionThreadCheckpointProgressRowSchema = Schema.Struct({
  matchingCheckpointCount: Schema.Number,
  realCheckpointCount: Schema.Number,
  placeholderCheckpointTurnCount: Schema.NullOr(Schema.Number),
  maxCheckpointTurnCount: Schema.NullOr(Schema.Number),
});
const ProjectionThreadCheckpointRevertContextRowSchema = Schema.Struct({
  maxCheckpointTurnCount: Schema.NullOr(Schema.Number),
  targetCheckpointRef: Schema.NullOr(CheckpointRef),
});
const ProjectionThreadAssistantMessageContextRowSchema = Schema.Struct({
  assistantMessageCountForTurn: Schema.Number,
  streamingAssistantMessageCountForTurn: Schema.Number,
  projectedMessageId: Schema.NullOr(MessageId),
  projectedMessageTextLength: Schema.NullOr(Schema.Number),
});
const ProjectionStateDbRowSchema = ProjectionState;
const ProjectionCountsRowSchema = Schema.Struct({
  projectCount: Schema.Number,
  threadCount: Schema.Number,
});
const WorkspaceRootLookupInput = Schema.Struct({
  workspaceRoot: Schema.String,
});
const ProjectIdLookupInput = Schema.Struct({
  projectId: ProjectId,
});
const ThreadIdLookupInput = Schema.Struct({
  threadId: ThreadId,
});
const ThreadMessageLookupInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
const ThreadTurnLookupInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
const ThreadProposedPlanLookupInput = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});
const ThreadCheckpointProgressInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
const ThreadCheckpointRevertContextInput = Schema.Struct({
  threadId: ThreadId,
  targetTurnCount: NonNegativeInt,
});
const ThreadAssistantMessageContextInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  messageId: MessageId,
});
const ThreadDetailMessagePageInput = Schema.Struct({
  threadId: ThreadId,
  limit: PositiveInt,
});
const ThreadDetailResourcePageInput = Schema.Struct({
  threadId: ThreadId,
  limit: PositiveInt,
});
const ThreadDetailMessagePageBeforeInput = Schema.Struct({
  threadId: ThreadId,
  beforeMessageId: MessageId,
  limit: PositiveInt,
});
const ThreadDetailActivityPageBeforeInput = Schema.Struct({
  threadId: ThreadId,
  beforeActivityId: EventId,
  limit: PositiveInt,
});
const ThreadDetailProposedPlanPageBeforeInput = Schema.Struct({
  threadId: ThreadId,
  beforeProposedPlanId: OrchestrationProposedPlanId,
  limit: PositiveInt,
});
const ThreadDetailCheckpointPageBeforeInput = Schema.Struct({
  threadId: ThreadId,
  beforeCheckpointTurnCount: NonNegativeInt,
  limit: PositiveInt,
});
const ProjectionProjectLookupRowSchema = ProjectionProjectDbRowSchema;
const ProjectionThreadIdLookupRowSchema = Schema.Struct({
  threadId: ThreadId,
});
const ProjectionMessageIdLookupRowSchema = Schema.Struct({
  messageId: MessageId,
});
const ProjectionCheckpointRefLookupRowSchema = Schema.Struct({
  checkpointRef: CheckpointRef,
});
const ProjectionThreadUserMessageCountRowSchema = Schema.Struct({
  userMessageCount: NonNegativeInt,
});
const ProjectionThreadActivityPayloadDbRowSchema = Schema.Struct({
  payload: Schema.Unknown,
});
const ProjectionThreadCheckpointContextThreadRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
});

const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.projects,
  ORCHESTRATION_PROJECTOR_NAMES.threads,
  ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
  ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
  ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
  ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
] as const;

export const THREAD_DETAIL_INITIAL_MESSAGE_LIMIT = 500;
export const THREAD_DETAIL_INITIAL_ACTIVITY_LIMIT = 500;
export const THREAD_DETAIL_INITIAL_PROPOSED_PLAN_LIMIT = 500;
export const THREAD_DETAIL_INITIAL_CHECKPOINT_LIMIT = 500;
// Extra cap for resources needed to render the initial message window without a repair repaint.
export const THREAD_DETAIL_INITIAL_RESOURCE_WINDOW_LIMIT = 10_000;

function threadDetailResourceNeedsWindowBackfill(
  oldestResourceAt: string | null,
  targetStartAt: string | null,
  hasMoreBefore: boolean,
): boolean {
  return (
    hasMoreBefore &&
    oldestResourceAt !== null &&
    targetStartAt !== null &&
    oldestResourceAt > targetStartAt
  );
}

function maxIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }
  return left > right ? left : right;
}

function computeSnapshotSequence(
  stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
): number {
  if (stateRows.length === 0) {
    return 0;
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  );

  let minSequence = Number.POSITIVE_INFINITY;
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
    const sequence = sequenceByProjector.get(projector);
    if (sequence === undefined) {
      return 0;
    }
    if (sequence < minSequence) {
      minSequence = sequence;
    }
  }

  return Number.isFinite(minSequence) ? minSequence : 0;
}

function mapLatestTurn(
  row: Schema.Schema.Type<typeof ProjectionLatestTurnDbRowSchema>,
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

function mapThreadMessageRows(
  rows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>>,
): OrchestrationMessage[] {
  return rows.map((row) => {
    const message = {
      id: row.messageId,
      role: row.role,
      source: row.source ?? "user",
      text: row.text,
      turnId: row.turnId,
      streaming: row.isStreaming === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    if (row.attachments !== null) {
      return Object.assign(message, { attachments: row.attachments });
    }
    return message;
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function collectCollabReceiverThreadIdsFromPayloads(payloads: ReadonlyArray<unknown>): string[] {
  const ids = new Set<string>();
  for (const payloadValue of payloads) {
    const payload = asRecord(payloadValue);
    if (payload?.itemType !== "collab_agent_tool_call") {
      continue;
    }
    const data = asRecord(payload.data);
    const receiverThreadIds = Array.isArray(data?.receiverThreadIds)
      ? data.receiverThreadIds.filter((value): value is string => typeof value === "string")
      : [];
    for (const receiverThreadId of receiverThreadIds) {
      ids.add(receiverThreadId);
    }
  }
  return [...ids];
}

function mapThreadProposedPlanRows(
  rows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionThreadProposedPlanDbRowSchema>>,
): OrchestrationProposedPlan[] {
  return rows.map((row) => ({
    id: row.planId,
    turnId: row.turnId,
    planMarkdown: row.planMarkdown,
    implementedAt: row.implementedAt,
    implementationThreadId: row.implementationThreadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

function mapThreadActivityRows(
  rows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>>,
): OrchestrationThreadActivity[] {
  return rows.map((row) => {
    const activity = {
      id: row.activityId,
      tone: row.tone,
      kind: row.kind,
      summary: row.summary,
      payload: row.payload,
      turnId: row.turnId,
      createdAt: row.createdAt,
    };
    if (row.sequence !== null) {
      return Object.assign(activity, { sequence: row.sequence });
    }
    return activity;
  });
}

function mapCheckpointRows(
  rows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionCheckpointDbRowSchema>>,
): OrchestrationCheckpointSummary[] {
  return rows.map((row) => ({
    turnId: row.turnId,
    checkpointTurnCount: row.checkpointTurnCount,
    checkpointRef: row.checkpointRef,
    status: row.status,
    files: row.files,
    assistantMessageId: row.assistantMessageId,
    completedAt: row.completedAt,
  }));
}

function mapSessionRow(
  row: Schema.Schema.Type<typeof ProjectionThreadSessionDbRowSchema>,
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

function mapProjectShellRow(
  row: Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>,
  repositoryIdentity: OrchestrationProject["repositoryIdentity"],
): OrchestrationProjectShell {
  return {
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: row.defaultModelSelection,
    scripts: row.scripts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function buildWorkDurationByThread(
  rows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionThreadWorkDurationDbRowSchema>>,
): Map<string, number> {
  return new Map(rows.map((row) => [row.threadId, row.totalWorkDurationMs] as const));
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver;
  const repositoryIdentityResolutionConcurrency = 4;

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
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

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
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
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          pinned_at AS "pinnedAt",
          archived_at AS "archivedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          latest_pending_user_input_at AS "latestPendingUserInputAt",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const listThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          source,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        ORDER BY thread_id ASC, created_at ASC, message_id ASC
      `,
  });

  const listThreadProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        ORDER BY thread_id ASC, created_at ASC, plan_id ASC
      `,
  });

  const listThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        ORDER BY
          thread_id ASC,
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `,
  });

  const listCheckpointRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCheckpointDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE checkpoint_turn_count IS NOT NULL
        ORDER BY thread_id ASC, checkpoint_turn_count ASC
      `,
  });

  const getThreadCheckpointProgressRow = SqlSchema.findOne({
    Request: ThreadCheckpointProgressInput,
    Result: ProjectionThreadCheckpointProgressRowSchema,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT
          COUNT(CASE WHEN turn_id = ${turnId} THEN 1 END) AS "matchingCheckpointCount",
          COUNT(
            CASE
              WHEN turn_id = ${turnId}
                AND checkpoint_status != 'missing'
              THEN 1
            END
          ) AS "realCheckpointCount",
          MAX(
            CASE
              WHEN turn_id = ${turnId}
                AND checkpoint_status = 'missing'
              THEN checkpoint_turn_count
            END
          ) AS "placeholderCheckpointTurnCount",
          MAX(checkpoint_turn_count) AS "maxCheckpointTurnCount"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
      `,
  });

  const getThreadCheckpointRevertContextRow = SqlSchema.findOne({
    Request: ThreadCheckpointRevertContextInput,
    Result: ProjectionThreadCheckpointRevertContextRowSchema,
    execute: ({ threadId, targetTurnCount }) =>
      sql`
        SELECT
          MAX(checkpoint_turn_count) AS "maxCheckpointTurnCount",
          MAX(
            CASE
              WHEN checkpoint_turn_count = ${targetTurnCount}
              THEN checkpoint_ref
            END
          ) AS "targetCheckpointRef"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
      `,
  });

  const listStaleCheckpointRefsAfterTurnCount = SqlSchema.findAll({
    Request: ThreadCheckpointRevertContextInput,
    Result: ProjectionCheckpointRefLookupRowSchema,
    execute: ({ threadId, targetTurnCount }) =>
      sql`
        SELECT checkpoint_ref AS "checkpointRef"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
          AND checkpoint_turn_count > ${targetTurnCount}
        ORDER BY checkpoint_turn_count ASC, turn_id ASC
      `,
  });

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
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

  const listThreadWorkDurationRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadWorkDurationDbRowSchema,
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

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
      `,
  });

  const readProjectionCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionCountsRowSchema,
    execute: () =>
      sql`
        SELECT
          (SELECT COUNT(*) FROM projection_projects) AS "projectCount",
          (SELECT COUNT(*) FROM projection_threads) AS "threadCount"
      `,
  });

  const getActiveProjectRowByWorkspaceRoot = SqlSchema.findOneOption({
    Request: WorkspaceRootLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ workspaceRoot }) =>
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
        WHERE workspace_root = ${workspaceRoot}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, project_id ASC
        LIMIT 1
      `,
  });

  const getActiveProjectRowById = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ projectId }) =>
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
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getFirstActiveThreadIdByProject = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId"
        FROM projection_threads
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
        LIMIT 1
      `,
  });

  const getThreadCheckpointContextThreadRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadCheckpointContextThreadRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getActiveThreadRowById = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
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
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          pinned_at AS "pinnedAt",
          archived_at AS "archivedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          latest_pending_user_input_at AS "latestPendingUserInputAt",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const listThreadMessageRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          source,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const getThreadMessageRow = SqlSchema.findOneOption({
    Request: ThreadMessageLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, messageId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          source,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND message_id = ${messageId}
      `,
  });

  const countThreadUserMessages = SqlSchema.findOne({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadUserMessageCountRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT COUNT(*) AS "userMessageCount"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND role = 'user'
      `,
  });

  const getThreadAssistantMessageContextRow = SqlSchema.findOne({
    Request: ThreadAssistantMessageContextInput,
    Result: ProjectionThreadAssistantMessageContextRowSchema,
    execute: ({ threadId, turnId, messageId }) =>
      sql`
        SELECT
          COUNT(
            CASE
              WHEN ${turnId} IS NOT NULL
                AND turn_id = ${turnId}
                AND role = 'assistant'
              THEN 1
            END
          ) AS "assistantMessageCountForTurn",
          COUNT(
            CASE
              WHEN ${turnId} IS NOT NULL
                AND turn_id = ${turnId}
                AND role = 'assistant'
                AND is_streaming = 1
              THEN 1
            END
          ) AS "streamingAssistantMessageCountForTurn",
          MAX(CASE WHEN message_id = ${messageId} THEN message_id END) AS "projectedMessageId",
          MAX(CASE WHEN message_id = ${messageId} THEN LENGTH(text) END) AS "projectedMessageTextLength"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND (
            message_id = ${messageId}
            OR (
              ${turnId} IS NOT NULL
              AND turn_id = ${turnId}
              AND role = 'assistant'
            )
          )
      `,
  });

  const getLatestAssistantMessageIdForTurnRow = SqlSchema.findOneOption({
    Request: ThreadTurnLookupInput,
    Result: ProjectionMessageIdLookupRowSchema,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT message_id AS "messageId"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
          AND role = 'assistant'
        ORDER BY created_at DESC, message_id DESC
        LIMIT 1
      `,
  });

  const listLatestThreadMessageRowsByThread = SqlSchema.findAll({
    Request: ThreadDetailMessagePageInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, limit }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          source,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM (
          SELECT
            message_id,
            thread_id,
            turn_id,
            role,
            source,
            text,
            attachments_json,
            is_streaming,
            created_at,
            updated_at
          FROM projection_thread_messages
          WHERE thread_id = ${threadId}
          ORDER BY created_at DESC, message_id DESC
          LIMIT ${limit}
        )
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const listThreadMessageRowsBeforeMessage = SqlSchema.findAll({
    Request: ThreadDetailMessagePageBeforeInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, beforeMessageId, limit }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          source,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM (
          SELECT
            message_id,
            thread_id,
            turn_id,
            role,
            source,
            text,
            attachments_json,
            is_streaming,
            created_at,
            updated_at
          FROM projection_thread_messages
          WHERE thread_id = ${threadId}
            AND (
              created_at < (
                SELECT created_at
                FROM projection_thread_messages
                WHERE thread_id = ${threadId}
                  AND message_id = ${beforeMessageId}
                LIMIT 1
              )
              OR (
                created_at = (
                  SELECT created_at
                  FROM projection_thread_messages
                  WHERE thread_id = ${threadId}
                    AND message_id = ${beforeMessageId}
                  LIMIT 1
                )
                AND message_id < ${beforeMessageId}
              )
            )
          ORDER BY created_at DESC, message_id DESC
          LIMIT ${limit}
        )
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const listThreadActivityRowsBeforeActivity = SqlSchema.findAll({
    Request: ThreadDetailActivityPageBeforeInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, beforeActivityId, limit }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM (
          SELECT
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND kind NOT LIKE 'subagent.%'
            AND kind NOT IN ('task.started', 'context-window.updated')
            AND summary <> 'Checkpoint captured'
            AND (
              CASE WHEN sequence IS NULL THEN 0 ELSE 1 END < (
                SELECT CASE WHEN sequence IS NULL THEN 0 ELSE 1 END
                FROM projection_thread_activities
                WHERE thread_id = ${threadId}
                  AND activity_id = ${beforeActivityId}
                LIMIT 1
              )
              OR (
                CASE WHEN sequence IS NULL THEN 0 ELSE 1 END = (
                  SELECT CASE WHEN sequence IS NULL THEN 0 ELSE 1 END
                  FROM projection_thread_activities
                  WHERE thread_id = ${threadId}
                    AND activity_id = ${beforeActivityId}
                  LIMIT 1
                )
                AND COALESCE(sequence, -1) < (
                  SELECT COALESCE(sequence, -1)
                  FROM projection_thread_activities
                  WHERE thread_id = ${threadId}
                    AND activity_id = ${beforeActivityId}
                  LIMIT 1
                )
              )
              OR (
                CASE WHEN sequence IS NULL THEN 0 ELSE 1 END = (
                  SELECT CASE WHEN sequence IS NULL THEN 0 ELSE 1 END
                  FROM projection_thread_activities
                  WHERE thread_id = ${threadId}
                    AND activity_id = ${beforeActivityId}
                  LIMIT 1
                )
                AND COALESCE(sequence, -1) = (
                  SELECT COALESCE(sequence, -1)
                  FROM projection_thread_activities
                  WHERE thread_id = ${threadId}
                    AND activity_id = ${beforeActivityId}
                  LIMIT 1
                )
                AND (
                  created_at < (
                    SELECT created_at
                    FROM projection_thread_activities
                    WHERE thread_id = ${threadId}
                      AND activity_id = ${beforeActivityId}
                    LIMIT 1
                  )
                  OR (
                    created_at = (
                      SELECT created_at
                      FROM projection_thread_activities
                      WHERE thread_id = ${threadId}
                        AND activity_id = ${beforeActivityId}
                      LIMIT 1
                    )
                    AND activity_id < ${beforeActivityId}
                  )
                )
              )
            )
          ORDER BY
            CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
            sequence DESC,
            created_at DESC,
            activity_id DESC
          LIMIT ${limit}
        )
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listThreadProposedPlanRowsBeforePlan = SqlSchema.findAll({
    Request: ThreadDetailProposedPlanPageBeforeInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId, beforeProposedPlanId, limit }) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM (
          SELECT
            plan_id,
            thread_id,
            turn_id,
            plan_markdown,
            implemented_at,
            implementation_thread_id,
            created_at,
            updated_at
          FROM projection_thread_proposed_plans
          WHERE thread_id = ${threadId}
            AND (
              created_at < (
                SELECT created_at
                FROM projection_thread_proposed_plans
                WHERE thread_id = ${threadId}
                  AND plan_id = ${beforeProposedPlanId}
                LIMIT 1
              )
              OR (
                created_at = (
                  SELECT created_at
                  FROM projection_thread_proposed_plans
                  WHERE thread_id = ${threadId}
                    AND plan_id = ${beforeProposedPlanId}
                  LIMIT 1
                )
                AND plan_id < ${beforeProposedPlanId}
              )
            )
          ORDER BY created_at DESC, plan_id DESC
          LIMIT ${limit}
        )
        ORDER BY created_at ASC, plan_id ASC
      `,
  });

  const listCheckpointRowsBeforeTurnCount = SqlSchema.findAll({
    Request: ThreadDetailCheckpointPageBeforeInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId, beforeCheckpointTurnCount, limit }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM (
          SELECT
            thread_id,
            turn_id,
            checkpoint_turn_count,
            checkpoint_ref,
            checkpoint_status,
            checkpoint_files_json,
            assistant_message_id,
            completed_at
          FROM projection_turns
          WHERE thread_id = ${threadId}
            AND checkpoint_turn_count IS NOT NULL
            AND checkpoint_turn_count < ${beforeCheckpointTurnCount}
          ORDER BY checkpoint_turn_count DESC
          LIMIT ${limit}
        )
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  const listThreadProposedPlanRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, plan_id ASC
      `,
  });

  const getThreadProposedPlanRow = SqlSchema.findOneOption({
    Request: ThreadProposedPlanLookupInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId, planId }) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
          AND plan_id = ${planId}
      `,
  });

  const listLatestThreadProposedPlanRowsByThread = SqlSchema.findAll({
    Request: ThreadDetailResourcePageInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId, limit }) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM (
          SELECT
            plan_id,
            thread_id,
            turn_id,
            plan_markdown,
            implemented_at,
            implementation_thread_id,
            created_at,
            updated_at
          FROM projection_thread_proposed_plans
          WHERE thread_id = ${threadId}
          ORDER BY created_at DESC, plan_id DESC
          LIMIT ${limit}
        )
        ORDER BY created_at ASC, plan_id ASC
      `,
  });

  const listThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listThreadCollabActivityPayloadRows = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityPayloadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT payload_json AS "payload"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND payload_json LIKE '%collab_agent_tool_call%'
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listLatestThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadDetailResourcePageInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, limit }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM (
          SELECT
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND kind NOT LIKE 'subagent.%'
            AND kind NOT IN ('task.started', 'context-window.updated')
            AND summary <> 'Checkpoint captured'
          ORDER BY
            CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
            sequence DESC,
            created_at DESC,
            activity_id DESC
          LIMIT ${limit}
        )
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const getThreadSessionRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: ({ threadId }) =>
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
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const getLatestTurnRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getThreadWorkDurationRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadWorkDurationDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          ${threadId} AS "threadId",
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
        WHERE thread_id = ${threadId}
      `,
  });

  const listCheckpointRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  const listLatestCheckpointRowsByThread = SqlSchema.findAll({
    Request: ThreadDetailResourcePageInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId, limit }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM (
          SELECT
            thread_id,
            turn_id,
            checkpoint_turn_count,
            checkpoint_ref,
            checkpoint_status,
            checkpoint_files_json,
            assistant_message_id,
            completed_at
          FROM projection_turns
          WHERE thread_id = ${threadId}
            AND checkpoint_turn_count IS NOT NULL
          ORDER BY checkpoint_turn_count DESC
          LIMIT ${limit}
        )
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  const extendActivityRowsToMessageWindow = (input: {
    readonly threadId: ThreadId;
    readonly rows: readonly Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>[];
    readonly targetStartAt: string | null;
    readonly hasMoreBefore: boolean;
  }) =>
    Effect.gen(function* () {
      const olderChunks: Array<Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>[]> =
        [];
      let rowCount = input.rows.length;
      let firstRow = input.rows[0] ?? null;
      let hasMoreBefore = input.hasMoreBefore;
      while (
        rowCount < THREAD_DETAIL_INITIAL_RESOURCE_WINDOW_LIMIT &&
        threadDetailResourceNeedsWindowBackfill(
          firstRow?.createdAt ?? null,
          input.targetStartAt,
          hasMoreBefore,
        )
      ) {
        const beforeActivityId = firstRow?.activityId;
        if (!beforeActivityId) break;
        const remaining = THREAD_DETAIL_INITIAL_RESOURCE_WINDOW_LIMIT - rowCount;
        const fetchLimit = Math.min(THREAD_DETAIL_INITIAL_ACTIVITY_LIMIT, remaining) + 1;
        const pageRows = yield* listThreadActivityRowsBeforeActivity({
          threadId: input.threadId,
          beforeActivityId,
          limit: fetchLimit,
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listOlderActivities:query",
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listOlderActivities:decodeRows",
            ),
          ),
        );
        hasMoreBefore = pageRows.length > fetchLimit - 1;
        const visibleRows = hasMoreBefore ? pageRows.slice(1) : pageRows;
        if (visibleRows.length === 0) break;
        olderChunks.push(visibleRows);
        rowCount += visibleRows.length;
        firstRow = visibleRows[0] ?? firstRow;
      }

      const rows =
        olderChunks.length === 0
          ? [...input.rows]
          : olderChunks
              .toReversed()
              .flatMap((chunk) => chunk)
              .concat(input.rows);
      return {
        rows,
        hasMoreBefore:
          hasMoreBefore ||
          threadDetailResourceNeedsWindowBackfill(
            rows[0]?.createdAt ?? null,
            input.targetStartAt,
            rows.length >= THREAD_DETAIL_INITIAL_RESOURCE_WINDOW_LIMIT,
          ),
      };
    });

  const extendProposedPlanRowsToMessageWindow = (input: {
    readonly threadId: ThreadId;
    readonly rows: readonly Schema.Schema.Type<typeof ProjectionThreadProposedPlanDbRowSchema>[];
    readonly targetStartAt: string | null;
    readonly hasMoreBefore: boolean;
  }) =>
    Effect.gen(function* () {
      const olderChunks: Array<
        Schema.Schema.Type<typeof ProjectionThreadProposedPlanDbRowSchema>[]
      > = [];
      let rowCount = input.rows.length;
      let firstRow = input.rows[0] ?? null;
      let hasMoreBefore = input.hasMoreBefore;
      while (
        rowCount < THREAD_DETAIL_INITIAL_RESOURCE_WINDOW_LIMIT &&
        threadDetailResourceNeedsWindowBackfill(
          firstRow?.createdAt ?? null,
          input.targetStartAt,
          hasMoreBefore,
        )
      ) {
        const beforeProposedPlanId = firstRow?.planId;
        if (!beforeProposedPlanId) break;
        const remaining = THREAD_DETAIL_INITIAL_RESOURCE_WINDOW_LIMIT - rowCount;
        const fetchLimit = Math.min(THREAD_DETAIL_INITIAL_PROPOSED_PLAN_LIMIT, remaining) + 1;
        const pageRows = yield* listThreadProposedPlanRowsBeforePlan({
          threadId: input.threadId,
          beforeProposedPlanId,
          limit: fetchLimit,
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listOlderPlans:query",
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listOlderPlans:decodeRows",
            ),
          ),
        );
        hasMoreBefore = pageRows.length > fetchLimit - 1;
        const visibleRows = hasMoreBefore ? pageRows.slice(1) : pageRows;
        if (visibleRows.length === 0) break;
        olderChunks.push(visibleRows);
        rowCount += visibleRows.length;
        firstRow = visibleRows[0] ?? firstRow;
      }

      const rows =
        olderChunks.length === 0
          ? [...input.rows]
          : olderChunks
              .toReversed()
              .flatMap((chunk) => chunk)
              .concat(input.rows);
      return {
        rows,
        hasMoreBefore:
          hasMoreBefore ||
          threadDetailResourceNeedsWindowBackfill(
            rows[0]?.createdAt ?? null,
            input.targetStartAt,
            rows.length >= THREAD_DETAIL_INITIAL_RESOURCE_WINDOW_LIMIT,
          ),
      };
    });

  const extendCheckpointRowsToMessageWindow = (input: {
    readonly threadId: ThreadId;
    readonly rows: readonly Schema.Schema.Type<typeof ProjectionCheckpointDbRowSchema>[];
    readonly targetStartAt: string | null;
    readonly hasMoreBefore: boolean;
  }) =>
    Effect.gen(function* () {
      const olderChunks: Array<Schema.Schema.Type<typeof ProjectionCheckpointDbRowSchema>[]> = [];
      let rowCount = input.rows.length;
      let firstRow = input.rows[0] ?? null;
      let hasMoreBefore = input.hasMoreBefore;
      while (
        rowCount < THREAD_DETAIL_INITIAL_RESOURCE_WINDOW_LIMIT &&
        threadDetailResourceNeedsWindowBackfill(
          firstRow?.completedAt ?? null,
          input.targetStartAt,
          hasMoreBefore,
        )
      ) {
        const beforeCheckpointTurnCount = firstRow?.checkpointTurnCount;
        if (beforeCheckpointTurnCount === undefined) break;
        const remaining = THREAD_DETAIL_INITIAL_RESOURCE_WINDOW_LIMIT - rowCount;
        const fetchLimit = Math.min(THREAD_DETAIL_INITIAL_CHECKPOINT_LIMIT, remaining) + 1;
        const pageRows = yield* listCheckpointRowsBeforeTurnCount({
          threadId: input.threadId,
          beforeCheckpointTurnCount,
          limit: fetchLimit,
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listOlderCheckpoints:query",
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listOlderCheckpoints:decodeRows",
            ),
          ),
        );
        hasMoreBefore = pageRows.length > fetchLimit - 1;
        const visibleRows = hasMoreBefore ? pageRows.slice(1) : pageRows;
        if (visibleRows.length === 0) break;
        olderChunks.push(visibleRows);
        rowCount += visibleRows.length;
        firstRow = visibleRows[0] ?? firstRow;
      }

      const rows =
        olderChunks.length === 0
          ? [...input.rows]
          : olderChunks
              .toReversed()
              .flatMap((chunk) => chunk)
              .concat(input.rows);
      return {
        rows,
        hasMoreBefore:
          hasMoreBefore ||
          threadDetailResourceNeedsWindowBackfill(
            rows[0]?.completedAt ?? null,
            input.targetStartAt,
            rows.length >= THREAD_DETAIL_INITIAL_RESOURCE_WINDOW_LIMIT,
          ),
      };
    });

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listThreadMessageRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:decodeRows",
              ),
            ),
          ),
          listThreadProposedPlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:decodeRows",
              ),
            ),
          ),
          listThreadActivityRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:decodeRows",
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listCheckpointRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query",
                "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows",
              ),
            ),
          ),
          listLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listThreadWorkDurationRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadWorkDurations:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadWorkDurations:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            messageRows,
            proposedPlanRows,
            activityRows,
            sessionRows,
            checkpointRows,
            latestTurnRows,
            workDurationRows,
            stateRows,
          ]) =>
            Effect.gen(function* () {
              const messagesByThread = new Map<string, Array<OrchestrationMessage>>();
              const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
              const activitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>();
              const checkpointsByThread = new Map<string, Array<OrchestrationCheckpointSummary>>();
              const sessionsByThread = new Map<string, OrchestrationSession>();
              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();
              const workDurationByThread = buildWorkDurationByThread(workDurationRows);

              let updatedAt: string | null = null;

              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              for (const row of messageRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadMessages = messagesByThread.get(row.threadId) ?? [];
                threadMessages.push({
                  id: row.messageId,
                  role: row.role,
                  source: row.source ?? "user",
                  text: row.text,
                  ...(row.attachments !== null ? { attachments: row.attachments } : {}),
                  turnId: row.turnId,
                  streaming: row.isStreaming === 1,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                messagesByThread.set(row.threadId, threadMessages);
              }

              for (const row of proposedPlanRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
                threadProposedPlans.push({
                  id: row.planId,
                  turnId: row.turnId,
                  planMarkdown: row.planMarkdown,
                  implementedAt: row.implementedAt,
                  implementationThreadId: row.implementationThreadId,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                proposedPlansByThread.set(row.threadId, threadProposedPlans);
              }

              for (const row of activityRows) {
                updatedAt = maxIso(updatedAt, row.createdAt);
                const threadActivities = activitiesByThread.get(row.threadId) ?? [];
                threadActivities.push({
                  id: row.activityId,
                  tone: row.tone,
                  kind: row.kind,
                  summary: row.summary,
                  payload: row.payload,
                  turnId: row.turnId,
                  ...(row.sequence !== null ? { sequence: row.sequence } : {}),
                  createdAt: row.createdAt,
                });
                activitiesByThread.set(row.threadId, threadActivities);
              }

              for (const row of checkpointRows) {
                updatedAt = maxIso(updatedAt, row.completedAt);
                const threadCheckpoints = checkpointsByThread.get(row.threadId) ?? [];
                threadCheckpoints.push({
                  turnId: row.turnId,
                  checkpointTurnCount: row.checkpointTurnCount,
                  checkpointRef: row.checkpointRef,
                  status: row.status,
                  files: row.files,
                  assistantMessageId: row.assistantMessageId,
                  completedAt: row.completedAt,
                });
                checkpointsByThread.set(row.threadId, threadCheckpoints);
              }

              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
                if (latestTurnByThread.has(row.threadId)) {
                  continue;
                }
                latestTurnByThread.set(row.threadId, {
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
                });
              }

              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                sessionsByThread.set(row.threadId, {
                  threadId: row.threadId,
                  status: row.status,
                  providerName: row.providerName,
                  ...(row.providerInstanceId !== null
                    ? { providerInstanceId: row.providerInstanceId }
                    : {}),
                  runtimeMode: row.runtimeMode,
                  activeTurnId: row.activeTurnId,
                  lastError: row.lastError,
                  updatedAt: row.updatedAt,
                });
              }

              const repositoryIdentities = new Map(
                yield* Effect.forEach(
                  projectRows,
                  (row) =>
                    repositoryIdentityResolver
                      .resolve(row.workspaceRoot)
                      .pipe(Effect.map((identity) => [row.projectId, identity] as const)),
                  { concurrency: repositoryIdentityResolutionConcurrency },
                ),
              );
              const activeThreadProjectIds = new Set(
                threadRows.filter((row) => row.deletedAt === null).map((row) => row.projectId),
              );

              const projects: ReadonlyArray<OrchestrationProject> = projectRows.map((row) => ({
                id: row.projectId,
                title: row.title,
                workspaceRoot: row.workspaceRoot,
                repositoryIdentity: repositoryIdentities.get(row.projectId) ?? null,
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
                messages: messagesByThread.get(row.threadId) ?? [],
                proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                activities: activitiesByThread.get(row.threadId) ?? [],
                checkpoints: checkpointsByThread.get(row.threadId) ?? [],
                session: sessionsByThread.get(row.threadId) ?? null,
              }));

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects,
                threads,
                updatedAt: updatedAt ?? new Date(0).toISOString(),
              };

              return yield* decodeReadModel(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError("ProjectionSnapshotQuery.getSnapshot:decodeReadModel"),
                ),
              );
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getSnapshot:query")(error);
        }),
      );

  const getShellSnapshot: ProjectionSnapshotQueryShape["getShellSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listThreadWorkDurationRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadWorkDurations:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadWorkDurations:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([projectRows, threadRows, sessionRows, latestTurnRows, workDurationRows, stateRows]) =>
            Effect.gen(function* () {
              let updatedAt: string | null = null;
              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const repositoryIdentities = new Map(
                yield* Effect.forEach(
                  projectRows,
                  (row) =>
                    repositoryIdentityResolver
                      .resolve(row.workspaceRoot)
                      .pipe(Effect.map((identity) => [row.projectId, identity] as const)),
                  { concurrency: repositoryIdentityResolutionConcurrency },
                ),
              );
              const latestTurnByThread = new Map(
                latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
              );
              const sessionByThread = new Map(
                sessionRows.map((row) => [row.threadId, mapSessionRow(row)] as const),
              );
              const workDurationByThread = buildWorkDurationByThread(workDurationRows);
              const activeThreadProjectIds = new Set(
                threadRows.filter((row) => row.deletedAt === null).map((row) => row.projectId),
              );

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects: projectRows
                  .filter(
                    (row) => row.deletedAt === null || activeThreadProjectIds.has(row.projectId),
                  )
                  .map((row) =>
                    mapProjectShellRow(
                      activeThreadProjectIds.has(row.projectId) ? { ...row, deletedAt: null } : row,
                      repositoryIdentities.get(row.projectId) ?? null,
                    ),
                  ),
                threads: threadRows
                  .filter((row) => row.deletedAt === null)
                  .map(
                    (row): OrchestrationThreadShell => ({
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
                      session: sessionByThread.get(row.threadId) ?? null,
                      latestUserMessageAt: row.latestUserMessageAt,
                      hasPendingApprovals: row.pendingApprovalCount > 0,
                      hasPendingUserInput: row.pendingUserInputCount > 0,
                      latestPendingUserInputAt: row.latestPendingUserInputAt,
                      hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                    }),
                  ),
                updatedAt: updatedAt ?? new Date(0).toISOString(),
              };

              return yield* decodeShellSnapshot(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:decodeShellSnapshot",
                  ),
                ),
              );
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getShellSnapshot:query")(error);
        }),
      );

  const getSnapshotSequence: ProjectionSnapshotQueryShape["getSnapshotSequence"] = () =>
    listProjectionStateRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getSnapshotSequence:listProjectionState:query",
          "ProjectionSnapshotQuery.getSnapshotSequence:listProjectionState:decodeRows",
        ),
      ),
      Effect.map(computeSnapshotSequence),
    );

  const getCounts: ProjectionSnapshotQueryShape["getCounts"] = () =>
    readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getCounts:query",
          "ProjectionSnapshotQuery.getCounts:decodeRow",
        ),
      ),
      Effect.map(
        (row): ProjectionSnapshotCounts => ({
          projectCount: row.projectCount,
          threadCount: row.threadCount,
        }),
      ),
    );

  const getActiveProjectByWorkspaceRoot: ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"] =
    (workspaceRoot) =>
      getActiveProjectRowByWorkspaceRoot({ workspaceRoot }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query",
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeRow",
          ),
        ),
        Effect.flatMap((option) =>
          Option.isNone(option)
            ? Effect.succeed(Option.none<OrchestrationProject>())
            : repositoryIdentityResolver.resolve(option.value.workspaceRoot).pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some({
                    id: option.value.projectId,
                    title: option.value.title,
                    workspaceRoot: option.value.workspaceRoot,
                    repositoryIdentity,
                    defaultModelSelection: option.value.defaultModelSelection,
                    scripts: option.value.scripts,
                    createdAt: option.value.createdAt,
                    updatedAt: option.value.updatedAt,
                    deletedAt: option.value.deletedAt,
                  } satisfies OrchestrationProject),
                ),
              ),
        ),
      );

  const getProjectShellById: ProjectionSnapshotQueryShape["getProjectShellById"] = (projectId) =>
    getActiveProjectRowById({ projectId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getProjectShellById:query",
          "ProjectionSnapshotQuery.getProjectShellById:decodeRow",
        ),
      ),
      Effect.flatMap((option) =>
        Option.isNone(option)
          ? Effect.succeed(Option.none<OrchestrationProjectShell>())
          : repositoryIdentityResolver
              .resolve(option.value.workspaceRoot)
              .pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some(mapProjectShellRow(option.value, repositoryIdentity)),
                ),
              ),
      ),
    );

  const getFirstActiveThreadIdByProjectId: ProjectionSnapshotQueryShape["getFirstActiveThreadIdByProjectId"] =
    (projectId) =>
      getFirstActiveThreadIdByProject({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:query",
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:decodeRow",
          ),
        ),
        Effect.map(Option.map((row) => row.threadId)),
      );

  const getThreadTurnStartContext: ProjectionSnapshotQueryShape["getThreadTurnStartContext"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const [messageRow, countRow] = yield* Effect.all([
        getThreadMessageRow(input).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadTurnStartContext:getMessage:query",
              "ProjectionSnapshotQuery.getThreadTurnStartContext:getMessage:decodeRow",
            ),
          ),
        ),
        countThreadUserMessages({ threadId: input.threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadTurnStartContext:countUserMessages:query",
              "ProjectionSnapshotQuery.getThreadTurnStartContext:countUserMessages:decodeRow",
            ),
          ),
        ),
      ]);

      const userMessage =
        Option.isSome(messageRow) && messageRow.value.role === "user"
          ? yield* decodeMessages(mapThreadMessageRows([messageRow.value])).pipe(
              Effect.map((messages) => messages[0] ?? null),
              Effect.mapError(
                toPersistenceDecodeError(
                  "ProjectionSnapshotQuery.getThreadTurnStartContext:decodeMessage",
                ),
              ),
            )
          : null;

      return {
        threadId: input.threadId,
        userMessage,
        userMessageCount: countRow.userMessageCount,
      };
    });

  const getThreadCollabReceiverThreadIds: ProjectionSnapshotQueryShape["getThreadCollabReceiverThreadIds"] =
    (threadId) =>
      listThreadCollabActivityPayloadRows({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCollabReceiverThreadIds:listActivities:query",
            "ProjectionSnapshotQuery.getThreadCollabReceiverThreadIds:listActivities:decodeRows",
          ),
        ),
        Effect.map((rows) =>
          collectCollabReceiverThreadIdsFromPayloads(rows.map((row) => row.payload)),
        ),
      );

  const getThreadProposedPlanById: ProjectionSnapshotQueryShape["getThreadProposedPlanById"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const row = yield* getThreadProposedPlanRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadProposedPlanById:query",
            "ProjectionSnapshotQuery.getThreadProposedPlanById:decodeRow",
          ),
        ),
      );
      if (Option.isNone(row)) {
        return Option.none();
      }
      const proposedPlans = yield* decodeProposedPlans(mapThreadProposedPlanRows([row.value])).pipe(
        Effect.mapError(
          toPersistenceDecodeError("ProjectionSnapshotQuery.getThreadProposedPlanById:decodePlan"),
        ),
      );
      const proposedPlan = proposedPlans[0] ?? null;
      return proposedPlan === null ? Option.none() : Option.some(proposedPlan);
    });

  const getThreadCheckpointProgress: ProjectionSnapshotQueryShape["getThreadCheckpointProgress"] = (
    input,
  ) =>
    getThreadCheckpointProgressRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getThreadCheckpointProgress:query",
          "ProjectionSnapshotQuery.getThreadCheckpointProgress:decodeRow",
        ),
      ),
      Effect.map((row) => ({
        threadId: input.threadId,
        turnId: input.turnId,
        hasCheckpointForTurn: row.matchingCheckpointCount > 0,
        hasRealCheckpointForTurn: row.realCheckpointCount > 0,
        placeholderCheckpointTurnCount: row.placeholderCheckpointTurnCount,
        maxCheckpointTurnCount: Math.max(0, row.maxCheckpointTurnCount ?? 0),
        nextCheckpointTurnCount: Math.max(0, row.maxCheckpointTurnCount ?? 0) + 1,
      })),
    );

  const getThreadCheckpointRevertContext: ProjectionSnapshotQueryShape["getThreadCheckpointRevertContext"] =
    (input) =>
      Effect.gen(function* () {
        const threadRow = yield* getActiveThreadRowById({ threadId: input.threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadCheckpointRevertContext:getThread:query",
              "ProjectionSnapshotQuery.getThreadCheckpointRevertContext:getThread:decodeRow",
            ),
          ),
        );
        if (Option.isNone(threadRow)) {
          return Option.none<ProjectionThreadCheckpointRevertContext>();
        }

        const [contextRow, staleRows] = yield* Effect.all([
          getThreadCheckpointRevertContextRow(input).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadCheckpointRevertContext:getContext:query",
                "ProjectionSnapshotQuery.getThreadCheckpointRevertContext:getContext:decodeRow",
              ),
            ),
          ),
          listStaleCheckpointRefsAfterTurnCount(input).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadCheckpointRevertContext:listStaleRefs:query",
                "ProjectionSnapshotQuery.getThreadCheckpointRevertContext:listStaleRefs:decodeRows",
              ),
            ),
          ),
        ]);

        return Option.some({
          threadId: input.threadId,
          targetTurnCount: input.targetTurnCount,
          currentTurnCount: Math.max(0, contextRow.maxCheckpointTurnCount ?? 0),
          targetCheckpointRef: contextRow.targetCheckpointRef,
          staleCheckpointRefs: staleRows.map((row) => row.checkpointRef),
        });
      });

  const getThreadAssistantMessageContext: ProjectionSnapshotQueryShape["getThreadAssistantMessageContext"] =
    (input) =>
      getThreadAssistantMessageContextRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadAssistantMessageContext:query",
            "ProjectionSnapshotQuery.getThreadAssistantMessageContext:decodeRow",
          ),
        ),
        Effect.map((row) => ({
          threadId: input.threadId,
          turnId: input.turnId,
          messageId: input.messageId,
          hasAssistantMessagesForTurn: row.assistantMessageCountForTurn > 0,
          hasStreamingAssistantMessagesForTurn: row.streamingAssistantMessageCountForTurn > 0,
          projectedMessage:
            row.projectedMessageId === null
              ? null
              : {
                  messageId: row.projectedMessageId,
                  textLength: Math.max(0, row.projectedMessageTextLength ?? 0),
                },
        })),
      );

  const getLatestAssistantMessageIdForTurn: ProjectionSnapshotQueryShape["getLatestAssistantMessageIdForTurn"] =
    (input) =>
      getLatestAssistantMessageIdForTurnRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getLatestAssistantMessageIdForTurn:query",
            "ProjectionSnapshotQuery.getLatestAssistantMessageIdForTurn:decodeRow",
          ),
        ),
        Effect.map(Option.map((row) => row.messageId)),
      );

  const getThreadCheckpointContext: ProjectionSnapshotQueryShape["getThreadCheckpointContext"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const threadRow = yield* getThreadCheckpointContextThreadRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:decodeRow",
          ),
        ),
      );
      if (Option.isNone(threadRow)) {
        return Option.none<ProjectionThreadCheckpointContext>();
      }

      const checkpointRows = yield* listCheckpointRowsByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:decodeRows",
          ),
        ),
      );

      return Option.some({
        threadId: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        workspaceRoot: threadRow.value.workspaceRoot,
        worktreePath: threadRow.value.worktreePath,
        checkpoints: checkpointRows.map(
          (row): OrchestrationCheckpointSummary => ({
            turnId: row.turnId,
            checkpointTurnCount: row.checkpointTurnCount,
            checkpointRef: row.checkpointRef,
            status: row.status,
            files: row.files,
            assistantMessageId: row.assistantMessageId,
            completedAt: row.completedAt,
          }),
        ),
      });
    });

  const getThreadShellById: ProjectionSnapshotQueryShape["getThreadShellById"] = (threadId) =>
    Effect.gen(function* () {
      const [threadRow, latestTurnRow, workDurationRow, sessionRow] = yield* Effect.all([
        getActiveThreadRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getThread:query",
              "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeRow",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadWorkDurationRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getThreadWorkDuration:query",
              "ProjectionSnapshotQuery.getThreadShellById:getThreadWorkDuration:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getSession:query",
              "ProjectionSnapshotQuery.getThreadShellById:getSession:decodeRow",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThreadShell>();
      }

      return Option.some({
        id: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        title: threadRow.value.title,
        modelSelection: threadRow.value.modelSelection,
        runtimeMode: threadRow.value.runtimeMode,
        interactionMode: threadRow.value.interactionMode,
        branch: threadRow.value.branch,
        worktreePath: threadRow.value.worktreePath,
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        totalWorkDurationMs: Option.isSome(workDurationRow)
          ? workDurationRow.value.totalWorkDurationMs
          : 0,
        createdAt: threadRow.value.createdAt,
        updatedAt: threadRow.value.updatedAt,
        pinnedAt: threadRow.value.pinnedAt,
        archivedAt: threadRow.value.archivedAt,
        session: Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null,
        latestUserMessageAt: threadRow.value.latestUserMessageAt,
        hasPendingApprovals: threadRow.value.pendingApprovalCount > 0,
        hasPendingUserInput: threadRow.value.pendingUserInputCount > 0,
        latestPendingUserInputAt: threadRow.value.latestPendingUserInputAt,
        hasActionableProposedPlan: threadRow.value.hasActionableProposedPlan > 0,
      } satisfies OrchestrationThreadShell);
    });

  const getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"] = (threadId) =>
    Effect.gen(function* () {
      const [
        threadRow,
        messageRows,
        proposedPlanRows,
        activityRows,
        checkpointRows,
        latestTurnRow,
        workDurationRow,
        sessionRow,
      ] = yield* Effect.all([
        getActiveThreadRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getThread:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getThread:decodeRow",
            ),
          ),
        ),
        listThreadMessageRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:decodeRows",
            ),
          ),
        ),
        listThreadProposedPlanRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:decodeRows",
            ),
          ),
        ),
        listThreadActivityRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listActivities:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listActivities:decodeRows",
            ),
          ),
        ),
        listCheckpointRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:decodeRows",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadWorkDurationRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getThreadWorkDuration:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getThreadWorkDuration:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:decodeRow",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThread>();
      }

      const thread = {
        id: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        title: threadRow.value.title,
        modelSelection: threadRow.value.modelSelection,
        runtimeMode: threadRow.value.runtimeMode,
        interactionMode: threadRow.value.interactionMode,
        branch: threadRow.value.branch,
        worktreePath: threadRow.value.worktreePath,
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        totalWorkDurationMs: Option.isSome(workDurationRow)
          ? workDurationRow.value.totalWorkDurationMs
          : 0,
        createdAt: threadRow.value.createdAt,
        updatedAt: threadRow.value.updatedAt,
        pinnedAt: threadRow.value.pinnedAt,
        archivedAt: threadRow.value.archivedAt,
        deletedAt: null,
        messages: messageRows.map((row) => {
          const message = {
            id: row.messageId,
            role: row.role,
            source: row.source ?? "user",
            text: row.text,
            turnId: row.turnId,
            streaming: row.isStreaming === 1,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
          if (row.attachments !== null) {
            return Object.assign(message, { attachments: row.attachments });
          }
          return message;
        }),
        proposedPlans: proposedPlanRows.map((row) => ({
          id: row.planId,
          turnId: row.turnId,
          planMarkdown: row.planMarkdown,
          implementedAt: row.implementedAt,
          implementationThreadId: row.implementationThreadId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
        activities: activityRows.map((row) => {
          const activity = {
            id: row.activityId,
            tone: row.tone,
            kind: row.kind,
            summary: row.summary,
            payload: row.payload,
            turnId: row.turnId,
            createdAt: row.createdAt,
          };
          if (row.sequence !== null) {
            return Object.assign(activity, { sequence: row.sequence });
          }
          return activity;
        }),
        checkpoints: checkpointRows.map((row) => ({
          turnId: row.turnId,
          checkpointTurnCount: row.checkpointTurnCount,
          checkpointRef: row.checkpointRef,
          status: row.status,
          files: row.files,
          assistantMessageId: row.assistantMessageId,
          completedAt: row.completedAt,
        })),
        session: Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null,
      };

      return Option.some(
        yield* decodeThread(thread).pipe(
          Effect.mapError(
            toPersistenceDecodeError("ProjectionSnapshotQuery.getThreadDetailById:decodeThread"),
          ),
        ),
      );
    });

  const getThreadDetailSnapshotById: ProjectionSnapshotQueryShape["getThreadDetailSnapshotById"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const messageLimit = THREAD_DETAIL_INITIAL_MESSAGE_LIMIT;
      const activityLimit = THREAD_DETAIL_INITIAL_ACTIVITY_LIMIT;
      const proposedPlanLimit = THREAD_DETAIL_INITIAL_PROPOSED_PLAN_LIMIT;
      const checkpointLimit = THREAD_DETAIL_INITIAL_CHECKPOINT_LIMIT;
      const [
        threadRow,
        messageRows,
        proposedPlanRows,
        activityRows,
        checkpointRows,
        latestTurnRow,
        workDurationRow,
        sessionRow,
      ] = yield* Effect.all([
        getActiveThreadRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:getThread:query",
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:getThread:decodeRow",
            ),
          ),
        ),
        listLatestThreadMessageRowsByThread({ threadId, limit: messageLimit + 1 }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listMessages:query",
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listMessages:decodeRows",
            ),
          ),
        ),
        listLatestThreadProposedPlanRowsByThread({
          threadId,
          limit: proposedPlanLimit + 1,
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listPlans:query",
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listPlans:decodeRows",
            ),
          ),
        ),
        listLatestThreadActivityRowsByThread({ threadId, limit: activityLimit + 1 }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listActivities:query",
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listActivities:decodeRows",
            ),
          ),
        ),
        listLatestCheckpointRowsByThread({ threadId, limit: checkpointLimit + 1 }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listCheckpoints:query",
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listCheckpoints:decodeRows",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadWorkDurationRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:getThreadWorkDuration:query",
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:getThreadWorkDuration:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:getSession:query",
              "ProjectionSnapshotQuery.getThreadDetailSnapshotById:getSession:decodeRow",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none<{
          readonly thread: OrchestrationThread;
          readonly pageInfo: OrchestrationThreadDetailPageInfo;
        }>();
      }

      const hasMoreMessagesBefore = messageRows.length > messageLimit;
      const visibleMessageRows = hasMoreMessagesBefore ? messageRows.slice(1) : messageRows;
      const hasMoreProposedPlansBefore = proposedPlanRows.length > proposedPlanLimit;
      const visibleProposedPlanRows = hasMoreProposedPlansBefore
        ? proposedPlanRows.slice(1)
        : proposedPlanRows;
      const hasMoreActivitiesBefore = activityRows.length > activityLimit;
      const visibleActivityRows = hasMoreActivitiesBefore ? activityRows.slice(1) : activityRows;
      const hasMoreCheckpointsBefore = checkpointRows.length > checkpointLimit;
      const visibleCheckpointRows = hasMoreCheckpointsBefore
        ? checkpointRows.slice(1)
        : checkpointRows;
      const oldestVisibleMessageAt = visibleMessageRows[0]?.createdAt ?? null;
      const [coherentActivityWindow, coherentProposedPlanWindow, coherentCheckpointWindow] =
        yield* Effect.all([
          extendActivityRowsToMessageWindow({
            threadId,
            rows: visibleActivityRows,
            targetStartAt: oldestVisibleMessageAt,
            hasMoreBefore: hasMoreActivitiesBefore,
          }),
          extendProposedPlanRowsToMessageWindow({
            threadId,
            rows: visibleProposedPlanRows,
            targetStartAt: oldestVisibleMessageAt,
            hasMoreBefore: hasMoreProposedPlansBefore,
          }),
          extendCheckpointRowsToMessageWindow({
            threadId,
            rows: visibleCheckpointRows,
            targetStartAt: oldestVisibleMessageAt,
            hasMoreBefore: hasMoreCheckpointsBefore,
          }),
        ]);
      const thread = {
        id: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        title: threadRow.value.title,
        modelSelection: threadRow.value.modelSelection,
        runtimeMode: threadRow.value.runtimeMode,
        interactionMode: threadRow.value.interactionMode,
        branch: threadRow.value.branch,
        worktreePath: threadRow.value.worktreePath,
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        totalWorkDurationMs: Option.isSome(workDurationRow)
          ? workDurationRow.value.totalWorkDurationMs
          : 0,
        createdAt: threadRow.value.createdAt,
        updatedAt: threadRow.value.updatedAt,
        pinnedAt: threadRow.value.pinnedAt,
        archivedAt: threadRow.value.archivedAt,
        deletedAt: null,
        messages: mapThreadMessageRows(visibleMessageRows),
        proposedPlans: coherentProposedPlanWindow.rows.map((row) => ({
          id: row.planId,
          turnId: row.turnId,
          planMarkdown: row.planMarkdown,
          implementedAt: row.implementedAt,
          implementationThreadId: row.implementationThreadId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
        activities: coherentActivityWindow.rows.map((row) => {
          const activity = {
            id: row.activityId,
            tone: row.tone,
            kind: row.kind,
            summary: row.summary,
            payload: row.payload,
            turnId: row.turnId,
            createdAt: row.createdAt,
          };
          if (row.sequence !== null) {
            return Object.assign(activity, { sequence: row.sequence });
          }
          return activity;
        }),
        checkpoints: coherentCheckpointWindow.rows.map((row) => ({
          turnId: row.turnId,
          checkpointTurnCount: row.checkpointTurnCount,
          checkpointRef: row.checkpointRef,
          status: row.status,
          files: row.files,
          assistantMessageId: row.assistantMessageId,
          completedAt: row.completedAt,
        })),
        session: Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null,
      };

      const decodedThread = yield* decodeThread(thread).pipe(
        Effect.mapError(
          toPersistenceDecodeError(
            "ProjectionSnapshotQuery.getThreadDetailSnapshotById:decodeThread",
          ),
        ),
      );

      return Option.some({
        thread: decodedThread,
        pageInfo: {
          messages: {
            limit: messageLimit,
            included: visibleMessageRows.length,
            hasMoreBefore: hasMoreMessagesBefore,
          },
          activities: {
            limit: THREAD_DETAIL_INITIAL_RESOURCE_WINDOW_LIMIT,
            included: coherentActivityWindow.rows.length,
            hasMoreBefore: coherentActivityWindow.hasMoreBefore,
          },
          proposedPlans: {
            limit: THREAD_DETAIL_INITIAL_RESOURCE_WINDOW_LIMIT,
            included: coherentProposedPlanWindow.rows.length,
            hasMoreBefore: coherentProposedPlanWindow.hasMoreBefore,
          },
          checkpoints: {
            limit: THREAD_DETAIL_INITIAL_RESOURCE_WINDOW_LIMIT,
            included: coherentCheckpointWindow.rows.length,
            hasMoreBefore: coherentCheckpointWindow.hasMoreBefore,
          },
        },
      });
    });

  const getThreadMessagesPageBefore: ProjectionSnapshotQueryShape["getThreadMessagesPageBefore"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const [threadRow, messageRows] = yield* Effect.all([
        getActiveThreadRowById({ threadId: input.threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadMessagesPageBefore:getThread:query",
              "ProjectionSnapshotQuery.getThreadMessagesPageBefore:getThread:decodeRow",
            ),
          ),
        ),
        listThreadMessageRowsBeforeMessage({
          threadId: input.threadId,
          beforeMessageId: input.beforeMessageId,
          limit: input.limit + 1,
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadMessagesPageBefore:listMessages:query",
              "ProjectionSnapshotQuery.getThreadMessagesPageBefore:listMessages:decodeRows",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none();
      }

      const hasMoreBefore = messageRows.length > input.limit;
      const visibleMessageRows = hasMoreBefore ? messageRows.slice(1) : messageRows;
      const messages = yield* decodeMessages(mapThreadMessageRows(visibleMessageRows)).pipe(
        Effect.mapError(
          toPersistenceDecodeError(
            "ProjectionSnapshotQuery.getThreadMessagesPageBefore:decodeMessages",
          ),
        ),
      );

      return Option.some({
        threadId: input.threadId,
        messages,
        pageInfo: {
          limit: input.limit,
          included: visibleMessageRows.length,
          hasMoreBefore,
        },
      });
    });

  const getThreadActivitiesPageBefore: ProjectionSnapshotQueryShape["getThreadActivitiesPageBefore"] =
    (input) =>
      Effect.gen(function* () {
        const [threadRow, activityRows] = yield* Effect.all([
          getActiveThreadRowById({ threadId: input.threadId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadActivitiesPageBefore:getThread:query",
                "ProjectionSnapshotQuery.getThreadActivitiesPageBefore:getThread:decodeRow",
              ),
            ),
          ),
          listThreadActivityRowsBeforeActivity({
            threadId: input.threadId,
            beforeActivityId: input.beforeActivityId,
            limit: input.limit + 1,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadActivitiesPageBefore:listActivities:query",
                "ProjectionSnapshotQuery.getThreadActivitiesPageBefore:listActivities:decodeRows",
              ),
            ),
          ),
        ]);

        if (Option.isNone(threadRow)) {
          return Option.none();
        }

        const hasMoreBefore = activityRows.length > input.limit;
        const visibleActivityRows = hasMoreBefore ? activityRows.slice(1) : activityRows;
        const activities = yield* decodeActivities(mapThreadActivityRows(visibleActivityRows)).pipe(
          Effect.mapError(
            toPersistenceDecodeError(
              "ProjectionSnapshotQuery.getThreadActivitiesPageBefore:decodeActivities",
            ),
          ),
        );

        return Option.some({
          threadId: input.threadId,
          activities,
          pageInfo: {
            limit: input.limit,
            included: visibleActivityRows.length,
            hasMoreBefore,
          },
        });
      });

  const getThreadProposedPlansPageBefore: ProjectionSnapshotQueryShape["getThreadProposedPlansPageBefore"] =
    (input) =>
      Effect.gen(function* () {
        const [threadRow, proposedPlanRows] = yield* Effect.all([
          getActiveThreadRowById({ threadId: input.threadId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadProposedPlansPageBefore:getThread:query",
                "ProjectionSnapshotQuery.getThreadProposedPlansPageBefore:getThread:decodeRow",
              ),
            ),
          ),
          listThreadProposedPlanRowsBeforePlan({
            threadId: input.threadId,
            beforeProposedPlanId: input.beforeProposedPlanId,
            limit: input.limit + 1,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadProposedPlansPageBefore:listPlans:query",
                "ProjectionSnapshotQuery.getThreadProposedPlansPageBefore:listPlans:decodeRows",
              ),
            ),
          ),
        ]);

        if (Option.isNone(threadRow)) {
          return Option.none();
        }

        const hasMoreBefore = proposedPlanRows.length > input.limit;
        const visibleProposedPlanRows = hasMoreBefore
          ? proposedPlanRows.slice(1)
          : proposedPlanRows;
        const proposedPlans = yield* decodeProposedPlans(
          mapThreadProposedPlanRows(visibleProposedPlanRows),
        ).pipe(
          Effect.mapError(
            toPersistenceDecodeError(
              "ProjectionSnapshotQuery.getThreadProposedPlansPageBefore:decodePlans",
            ),
          ),
        );

        return Option.some({
          threadId: input.threadId,
          proposedPlans,
          pageInfo: {
            limit: input.limit,
            included: visibleProposedPlanRows.length,
            hasMoreBefore,
          },
        });
      });

  const getThreadCheckpointsPageBefore: ProjectionSnapshotQueryShape["getThreadCheckpointsPageBefore"] =
    (input) =>
      Effect.gen(function* () {
        const [threadRow, checkpointRows] = yield* Effect.all([
          getActiveThreadRowById({ threadId: input.threadId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadCheckpointsPageBefore:getThread:query",
                "ProjectionSnapshotQuery.getThreadCheckpointsPageBefore:getThread:decodeRow",
              ),
            ),
          ),
          listCheckpointRowsBeforeTurnCount({
            threadId: input.threadId,
            beforeCheckpointTurnCount: input.beforeCheckpointTurnCount,
            limit: input.limit + 1,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadCheckpointsPageBefore:listCheckpoints:query",
                "ProjectionSnapshotQuery.getThreadCheckpointsPageBefore:listCheckpoints:decodeRows",
              ),
            ),
          ),
        ]);

        if (Option.isNone(threadRow)) {
          return Option.none();
        }

        const hasMoreBefore = checkpointRows.length > input.limit;
        const visibleCheckpointRows = hasMoreBefore ? checkpointRows.slice(1) : checkpointRows;
        const checkpoints = yield* decodeCheckpoints(mapCheckpointRows(visibleCheckpointRows)).pipe(
          Effect.mapError(
            toPersistenceDecodeError(
              "ProjectionSnapshotQuery.getThreadCheckpointsPageBefore:decodeCheckpoints",
            ),
          ),
        );

        return Option.some({
          threadId: input.threadId,
          checkpoints,
          pageInfo: {
            limit: input.limit,
            included: visibleCheckpointRows.length,
            hasMoreBefore,
          },
        });
      });

  return {
    getSnapshot,
    getShellSnapshot,
    getSnapshotSequence,
    getCounts,
    getActiveProjectByWorkspaceRoot,
    getProjectShellById,
    getFirstActiveThreadIdByProjectId,
    getThreadTurnStartContext,
    getThreadCollabReceiverThreadIds,
    getThreadProposedPlanById,
    getThreadCheckpointProgress,
    getThreadCheckpointRevertContext,
    getThreadAssistantMessageContext,
    getLatestAssistantMessageIdForTurn,
    getThreadCheckpointContext,
    getThreadShellById,
    getThreadDetailById,
    getThreadDetailSnapshotById,
    getThreadMessagesPageBefore,
    getThreadActivitiesPageBefore,
    getThreadProposedPlansPageBefore,
    getThreadCheckpointsPageBefore,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
);
