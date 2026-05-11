/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailPageInfo,
  OrchestrationThreadDetailResourcePageInfo,
  OrchestrationThreadShell,
  CheckpointRef,
  EventId,
  MessageId,
  OrchestrationProposedPlanId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Option } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface ProjectionThreadCheckpointContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

export interface ProjectionThreadDetailSnapshot {
  readonly thread: OrchestrationThread;
  readonly pageInfo: OrchestrationThreadDetailPageInfo;
}

export interface ProjectionThreadMessagesPage {
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly pageInfo: OrchestrationThreadDetailResourcePageInfo;
}

export interface ProjectionThreadActivitiesPage {
  readonly threadId: ThreadId;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly pageInfo: OrchestrationThreadDetailResourcePageInfo;
}

export interface ProjectionThreadProposedPlansPage {
  readonly threadId: ThreadId;
  readonly proposedPlans: ReadonlyArray<OrchestrationProposedPlan>;
  readonly pageInfo: OrchestrationThreadDetailResourcePageInfo;
}

export interface ProjectionThreadCheckpointsPage {
  readonly threadId: ThreadId;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
  readonly pageInfo: OrchestrationThreadDetailResourcePageInfo;
}

export interface ProjectionThreadTurnStartContext {
  readonly threadId: ThreadId;
  readonly userMessage: OrchestrationMessage | null;
  readonly userMessageCount: number;
}

export interface ProjectionThreadCheckpointProgress {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly hasCheckpointForTurn: boolean;
  readonly hasRealCheckpointForTurn: boolean;
  readonly placeholderCheckpointTurnCount: number | null;
  readonly maxCheckpointTurnCount: number;
  readonly nextCheckpointTurnCount: number;
}

export interface ProjectionThreadCheckpointRevertContext {
  readonly threadId: ThreadId;
  readonly targetTurnCount: number;
  readonly currentTurnCount: number;
  readonly targetCheckpointRef: CheckpointRef | null;
  readonly staleCheckpointRefs: ReadonlyArray<CheckpointRef>;
}

export interface ProjectionThreadAssistantMessageContext {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly messageId: MessageId;
  readonly hasAssistantMessagesForTurn: boolean;
  readonly hasStreamingAssistantMessagesForTurn: boolean;
  readonly projectedMessage: {
    readonly messageId: MessageId;
    readonly textLength: number;
  } | null;
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read the latest orchestration shell snapshot.
   *
   * Returns only projects and thread shell summaries so clients can bootstrap
   * lightweight navigation state without hydrating every thread body.
   */
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest projection snapshot sequence without hydrating shell or
   * thread detail rows.
   */
  readonly getSnapshotSequence: () => Effect.Effect<number, ProjectionRepositoryError>;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /**
   * Read the active project for an exact workspace root match.
   */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

  /**
   * Read a single active project shell row by id.
   */
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a project.
   */
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read the bounded message context needed to start a provider turn.
   */
  readonly getThreadTurnStartContext: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<ProjectionThreadTurnStartContext, ProjectionRepositoryError>;

  /**
   * Read receiver thread ids from persisted collaboration activity payloads for
   * a single thread.
   */
  readonly getThreadCollabReceiverThreadIds: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<string>, ProjectionRepositoryError>;

  /**
   * Read one proposed plan for source-plan validation without hydrating the
   * source thread body.
   */
  readonly getThreadProposedPlanById: (input: {
    readonly threadId: ThreadId;
    readonly planId: OrchestrationProposedPlanId;
  }) => Effect.Effect<Option.Option<OrchestrationProposedPlan>, ProjectionRepositoryError>;

  /**
   * Read bounded checkpoint progress for provider diff placeholder decisions.
   */
  readonly getThreadCheckpointProgress: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) => Effect.Effect<ProjectionThreadCheckpointProgress, ProjectionRepositoryError>;

  /**
   * Read bounded checkpoint refs needed to revert a thread without hydrating
   * the full checkpoint history.
   */
  readonly getThreadCheckpointRevertContext: (input: {
    readonly threadId: ThreadId;
    readonly targetTurnCount: number;
  }) => Effect.Effect<
    Option.Option<ProjectionThreadCheckpointRevertContext>,
    ProjectionRepositoryError
  >;

  /**
   * Read bounded assistant-message state for provider completion decisions.
   */
  readonly getThreadAssistantMessageContext: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly messageId: MessageId;
  }) => Effect.Effect<ProjectionThreadAssistantMessageContext, ProjectionRepositoryError>;

  /**
   * Read the latest assistant message id for one turn without hydrating the
   * thread message body.
   */
  readonly getLatestAssistantMessageIdForTurn: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) => Effect.Effect<Option.Option<MessageId>, ProjectionRepositoryError>;

  /**
   * Read the checkpoint context needed to resolve a single thread diff.
   */
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;

  /**
   * Read a single active thread shell row by id.
   */
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id.
   */
  readonly getThreadDetailById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id with bounded resource
   * metadata for subscription snapshots.
   */
  readonly getThreadDetailSnapshotById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadDetailSnapshot>, ProjectionRepositoryError>;

  /**
   * Read the message page immediately before an already loaded message id.
   */
  readonly getThreadMessagesPageBefore: (input: {
    readonly threadId: ThreadId;
    readonly beforeMessageId: MessageId;
    readonly limit: number;
  }) => Effect.Effect<Option.Option<ProjectionThreadMessagesPage>, ProjectionRepositoryError>;

  readonly getThreadActivitiesPageBefore: (input: {
    readonly threadId: ThreadId;
    readonly beforeActivityId: EventId;
    readonly limit: number;
  }) => Effect.Effect<Option.Option<ProjectionThreadActivitiesPage>, ProjectionRepositoryError>;

  readonly getThreadProposedPlansPageBefore: (input: {
    readonly threadId: ThreadId;
    readonly beforeProposedPlanId: OrchestrationProposedPlanId;
    readonly limit: number;
  }) => Effect.Effect<Option.Option<ProjectionThreadProposedPlansPage>, ProjectionRepositoryError>;

  readonly getThreadCheckpointsPageBefore: (input: {
    readonly threadId: ThreadId;
    readonly beforeCheckpointTurnCount: number;
    readonly limit: number;
  }) => Effect.Effect<Option.Option<ProjectionThreadCheckpointsPage>, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("t3/orchestration/Services/ProjectionSnapshotQuery") {}
