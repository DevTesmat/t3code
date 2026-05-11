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
  EventId,
  MessageId,
  OrchestrationProposedPlanId,
  ProjectId,
  ThreadId,
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
