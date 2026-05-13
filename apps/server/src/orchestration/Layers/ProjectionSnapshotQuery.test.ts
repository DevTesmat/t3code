import {
  CheckpointRef,
  EventId,
  MessageId,
  OrchestrationProposedPlanId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  OrchestrationProjectionSnapshotQueryLive,
  THREAD_DETAIL_INITIAL_ACTIVITY_LIMIT,
  THREAD_DETAIL_INITIAL_CHECKPOINT_LIMIT,
  THREAD_DETAIL_INITIAL_MESSAGE_LIMIT,
  THREAD_DETAIL_INITIAL_PROPOSED_PLAN_LIMIT,
  THREAD_DETAIL_INITIAL_RESOURCE_WINDOW_LIMIT,
} from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProposedPlanId = (value: string): OrchestrationProposedPlanId =>
  OrchestrationProposedPlanId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("hydrates read model from projection tables and computes snapshot sequence", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-1',
          '2026-02-24T00:00:04.000Z',
          1,
          0,
          0,
          '2026-02-24T00:00:02.000Z',
          '2026-02-24T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-1',
          'thread-1',
          'turn-1',
          'assistant',
          'hello from projection',
          0,
          '2026-02-24T00:00:04.000Z',
          '2026-02-24T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES (
          'plan-1',
          'thread-1',
          'turn-1',
          '# Ship it',
          '2026-02-24T00:00:05.500Z',
          'thread-2',
          '2026-02-24T00:00:05.000Z',
          '2026-02-24T00:00:05.500Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES (
          'activity-1',
          'thread-1',
          'turn-1',
          'info',
          'runtime.note',
          'provider started',
          '{"stage":"start"}',
          '2026-02-24T00:00:06.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-1',
          'running',
          'codex',
          'provider-session-1',
          'provider-thread-1',
          'approval-required',
          'turn-1',
          NULL,
          '2026-02-24T00:00:07.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-1',
          'turn-1',
          NULL,
          'thread-1',
          'plan-1',
          'message-1',
          'completed',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          1,
          'checkpoint-1',
          'ready',
          '[{"path":"README.md","kind":"modified","additions":2,"deletions":1}]'
        )
      `;

      let sequence = 5;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:09.000Z'
          )
        `;
        sequence += 1;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();

      assert.equal(snapshot.snapshotSequence, 5);
      assert.equal(snapshot.updatedAt, "2026-02-24T00:00:09.000Z");
      assert.deepEqual(snapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
          deletedAt: null,
        },
      ]);
      assert.deepEqual(snapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          totalWorkDurationMs: 0,
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          pinnedAt: null,
          archivedAt: null,
          deletedAt: null,
          messages: [
            {
              id: asMessageId("message-1"),
              role: "assistant",
              source: "user",
              text: "hello from projection",
              turnId: asTurnId("turn-1"),
              streaming: false,
              createdAt: "2026-02-24T00:00:04.000Z",
              updatedAt: "2026-02-24T00:00:05.000Z",
            },
          ],
          proposedPlans: [
            {
              id: "plan-1",
              turnId: asTurnId("turn-1"),
              planMarkdown: "# Ship it",
              implementedAt: "2026-02-24T00:00:05.500Z",
              implementationThreadId: ThreadId.make("thread-2"),
              createdAt: "2026-02-24T00:00:05.000Z",
              updatedAt: "2026-02-24T00:00:05.500Z",
            },
          ],
          activities: [
            {
              id: asEventId("activity-1"),
              tone: "info",
              kind: "runtime.note",
              summary: "provider started",
              payload: { stage: "start" },
              turnId: asTurnId("turn-1"),
              createdAt: "2026-02-24T00:00:06.000Z",
            },
          ],
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-1"),
              status: "ready",
              files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
              assistantMessageId: asMessageId("message-1"),
              completedAt: "2026-02-24T00:00:08.000Z",
            },
          ],
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
        },
      ]);

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.snapshotSequence, 5);
      assert.equal(yield* snapshotQuery.getSnapshotSequence(), 5);
      assert.deepEqual(shellSnapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
        },
      ]);
      assert.deepEqual(shellSnapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          totalWorkDurationMs: 0,
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          pinnedAt: null,
          archivedAt: null,
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
          latestUserMessageAt: "2026-02-24T00:00:04.000Z",
          hasPendingApprovals: true,
          hasPendingUserInput: false,
          latestPendingUserInputAt: null,
          hasActionableProposedPlan: false,
        },
      ]);

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value, snapshot.threads[0]);
      }

      const proposedPlan = yield* snapshotQuery.getThreadProposedPlanById({
        threadId: ThreadId.make("thread-1"),
        planId: asProposedPlanId("plan-1"),
      });
      assert.equal(proposedPlan._tag, "Some");
      if (proposedPlan._tag === "Some") {
        assert.deepEqual(proposedPlan.value, snapshot.threads[0]?.proposedPlans[0]);
      }

      const turnStartContext = yield* snapshotQuery.getThreadTurnStartContext({
        threadId: ThreadId.make("thread-1"),
        messageId: MessageId.make("message-1"),
      });
      assert.equal(turnStartContext.userMessage, null);
      assert.equal(turnStartContext.userMessageCount, 0);
      assert.deepEqual(
        yield* snapshotQuery.getThreadCollabReceiverThreadIds(ThreadId.make("thread-1")),
        [],
      );
      assert.deepEqual(
        yield* snapshotQuery.getThreadCheckpointProgress({
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
        }),
        {
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
          hasCheckpointForTurn: true,
          hasRealCheckpointForTurn: true,
          placeholderCheckpointTurnCount: null,
          maxCheckpointTurnCount: 1,
          nextCheckpointTurnCount: 2,
        },
      );
      assert.deepEqual(
        yield* snapshotQuery.getThreadCheckpointProgress({
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-2"),
        }),
        {
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-2"),
          hasCheckpointForTurn: false,
          hasRealCheckpointForTurn: false,
          placeholderCheckpointTurnCount: null,
          maxCheckpointTurnCount: 1,
          nextCheckpointTurnCount: 2,
        },
      );
      assert.deepEqual(
        yield* snapshotQuery.getThreadAssistantMessageContext({
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
          messageId: asMessageId("message-1"),
        }),
        {
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
          messageId: asMessageId("message-1"),
          hasAssistantMessagesForTurn: true,
          hasStreamingAssistantMessagesForTurn: false,
          projectedMessage: {
            messageId: asMessageId("message-1"),
            textLength: "hello from projection".length,
          },
        },
      );
      assert.deepEqual(
        yield* snapshotQuery.getLatestAssistantMessageIdForTurn({
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
        }),
        Option.some(asMessageId("message-1")),
      );
    }),
  );

  it.effect("sums completed thread work duration and ignores invalid turn rows", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-work',
          'Work Project',
          '/tmp/project-work',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-03-02T00:00:00.000Z',
          '2026-03-02T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-work',
          'project-work',
          'Work Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-error',
          '2026-03-02T00:00:00.000Z',
          '2026-03-02T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-work',
            'turn-completed',
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:00.000Z',
            '2026-03-02T00:00:00.000Z',
            '2026-03-02T00:00:04.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-work',
            'turn-interrupted',
            NULL,
            NULL,
            'interrupted',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:08.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-work',
            'turn-error',
            NULL,
            NULL,
            'error',
            '2026-03-02T00:00:09.000Z',
            '2026-03-02T00:00:09.000Z',
            '2026-03-02T00:00:11.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-work',
            'turn-invalid',
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:12.000Z',
            '2026-03-02T00:00:13.000Z',
            '2026-03-02T00:00:12.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-work',
            NULL,
            'message-pending',
            NULL,
            'pending',
            '2026-03-02T00:00:14.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-work"));

      assert.equal(snapshot.threads[0]?.totalWorkDurationMs, 9_000);
      assert.equal(shellSnapshot.threads[0]?.totalWorkDurationMs, 9_000);
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.equal(threadDetail.value.totalWorkDurationMs, 9_000);
      }
    }),
  );

  it.effect(
    "reads targeted project, thread, and count queries without hydrating the full snapshot",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_turns`;

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-active',
            'Active Project',
            '/tmp/workspace',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:01.000Z',
            NULL
          ),
          (
            'project-deleted',
            'Deleted Project',
            '/tmp/deleted',
            NULL,
            '[]',
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:03.000Z',
            '2026-03-01T00:00:04.000Z'
          )
      `;

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-first',
            'project-active',
            'First Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:05.000Z',
            '2026-03-01T00:00:06.000Z',
            NULL,
            NULL
          ),
          (
            'thread-second',
            'project-active',
            'Second Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:07.000Z',
            '2026-03-01T00:00:08.000Z',
            NULL,
            NULL
          ),
          (
            'thread-deleted',
            'project-active',
            'Deleted Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:09.000Z',
            '2026-03-01T00:00:10.000Z',
            NULL,
            '2026-03-01T00:00:11.000Z'
          )
      `;

        const counts = yield* snapshotQuery.getCounts();
        assert.deepEqual(counts, {
          projectCount: 2,
          threadCount: 3,
        });

        const project = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/workspace");
        assert.equal(project._tag, "Some");
        if (project._tag === "Some") {
          assert.equal(project.value.id, asProjectId("project-active"));
        }

        const missingProject = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/missing");
        assert.equal(missingProject._tag, "None");

        const firstThreadId = yield* snapshotQuery.getFirstActiveThreadIdByProjectId(
          asProjectId("project-active"),
        );
        assert.equal(firstThreadId._tag, "Some");
        if (firstThreadId._tag === "Some") {
          assert.equal(firstThreadId.value, ThreadId.make("thread-first"));
        }
      }),
  );

  it.effect("reads single-thread checkpoint context without hydrating unrelated threads", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-context',
          'Context Project',
          '/tmp/context-workspace',
          NULL,
          '[]',
          '2026-03-02T00:00:00.000Z',
          '2026-03-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-context',
          'project-context',
          'Context Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          'feature/perf',
          '/tmp/context-worktree',
          NULL,
          '2026-03-02T00:00:02.000Z',
          '2026-03-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-context',
            'turn-1',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            1,
            'checkpoint-a',
            'ready',
            '[]'
          ),
          (
            'thread-context',
            'turn-2',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            2,
            'checkpoint-b',
            'ready',
            '[]'
          )
      `;

      const context = yield* snapshotQuery.getThreadCheckpointContext(
        ThreadId.make("thread-context"),
      );
      assert.equal(context._tag, "Some");
      if (context._tag === "Some") {
        assert.deepEqual(context.value, {
          threadId: ThreadId.make("thread-context"),
          projectId: asProjectId("project-context"),
          workspaceRoot: "/tmp/context-workspace",
          worktreePath: "/tmp/context-worktree",
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-a"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:04.000Z",
            },
            {
              turnId: asTurnId("turn-2"),
              checkpointTurnCount: 2,
              checkpointRef: asCheckpointRef("checkpoint-b"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:05.000Z",
            },
          ],
        });
      }

      const revertContext = yield* snapshotQuery.getThreadCheckpointRevertContext({
        threadId: ThreadId.make("thread-context"),
        targetTurnCount: 1,
      });
      assert.equal(revertContext._tag, "Some");
      if (revertContext._tag === "Some") {
        assert.deepEqual(revertContext.value, {
          threadId: ThreadId.make("thread-context"),
          targetTurnCount: 1,
          currentTurnCount: 2,
          targetCheckpointRef: asCheckpointRef("checkpoint-a"),
          staleCheckpointRefs: [asCheckpointRef("checkpoint-b")],
        });
      }

      const baselineRevertContext = yield* snapshotQuery.getThreadCheckpointRevertContext({
        threadId: ThreadId.make("thread-context"),
        targetTurnCount: 0,
      });
      assert.equal(baselineRevertContext._tag, "Some");
      if (baselineRevertContext._tag === "Some") {
        assert.deepEqual(baselineRevertContext.value, {
          threadId: ThreadId.make("thread-context"),
          targetTurnCount: 0,
          currentTurnCount: 2,
          targetCheckpointRef: null,
          staleCheckpointRefs: [asCheckpointRef("checkpoint-a"), asCheckpointRef("checkpoint-b")],
        });
      }
    }),
  );

  it.effect("keeps thread detail activity ordering consistent with shell snapshot ordering", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-01T00:00:00.000Z',
          '2026-04-01T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-01T00:00:02.000Z',
          '2026-04-01T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-unsequenced',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'unsequenced first',
            '{"source":"unsequenced"}',
            NULL,
            '2026-04-01T00:00:06.000Z'
          ),
          (
            'activity-sequence-2',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence two',
            '{"source":"sequence-2"}',
            2,
            '2026-04-01T00:00:04.000Z'
          ),
          (
            'activity-sequence-1',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence one',
            '{"source":"sequence-1"}',
            1,
            '2026-04-01T00:00:05.000Z'
          )
      `;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));

      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value.activities, snapshot.threads[0]?.activities ?? []);
      }

      assert.deepEqual(snapshot.threads[0]?.activities ?? [], [
        {
          id: asEventId("activity-unsequenced"),
          tone: "info",
          kind: "runtime.note",
          summary: "unsequenced first",
          payload: { source: "unsequenced" },
          turnId: null,
          createdAt: "2026-04-01T00:00:06.000Z",
        },
        {
          id: asEventId("activity-sequence-1"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence one",
          payload: { source: "sequence-1" },
          turnId: null,
          sequence: 1,
          createdAt: "2026-04-01T00:00:05.000Z",
        },
        {
          id: asEventId("activity-sequence-2"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence two",
          payload: { source: "sequence-2" },
          turnId: null,
          sequence: 2,
          createdAt: "2026-04-01T00:00:04.000Z",
        },
      ]);
    }),
  );

  it.effect("bounds subscription thread detail snapshots to the latest messages", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-01T00:00:00.000Z',
          '2026-04-01T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-01T00:00:00.000Z',
          '2026-04-01T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        WITH RECURSIVE counter(value) AS (
          SELECT 0
          UNION ALL
          SELECT value + 1 FROM counter WHERE value < ${THREAD_DETAIL_INITIAL_MESSAGE_LIMIT + 9}
        )
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        SELECT
          printf('message-%04d', value),
          'thread-1',
          NULL,
          'user',
          printf('message %04d', value),
          0,
          printf('2026-04-01T00:%02d:%02d.000Z', value / 60, value % 60),
          printf('2026-04-01T00:%02d:%02d.000Z', value / 60, value % 60)
        FROM counter
      `;

      yield* sql`
        WITH RECURSIVE counter(value) AS (
          SELECT 0
          UNION ALL
          SELECT value + 1 FROM counter WHERE value < ${THREAD_DETAIL_INITIAL_ACTIVITY_LIMIT + 9}
        )
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        SELECT
          printf('activity-%04d', value),
          'thread-1',
          NULL,
          'info',
          'test.activity',
          printf('activity %04d', value),
          '{}',
          value,
          printf('2026-04-01T01:%02d:%02d.000Z', value / 60, value % 60)
        FROM counter
      `;

      yield* sql`
        WITH RECURSIVE counter(value) AS (
          SELECT 0
          UNION ALL
          SELECT value + 1 FROM counter WHERE value < ${
            THREAD_DETAIL_INITIAL_PROPOSED_PLAN_LIMIT + 9
          }
        )
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        SELECT
          printf('plan-%04d', value),
          'thread-1',
          NULL,
          printf('plan %04d', value),
          NULL,
          NULL,
          printf('2026-04-01T02:%02d:%02d.000Z', value / 60, value % 60),
          printf('2026-04-01T02:%02d:%02d.000Z', value / 60, value % 60)
        FROM counter
      `;

      yield* sql`
        WITH RECURSIVE counter(value) AS (
          SELECT 0
          UNION ALL
          SELECT value + 1 FROM counter WHERE value < ${THREAD_DETAIL_INITIAL_CHECKPOINT_LIMIT + 9}
        )
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        SELECT
          'thread-1',
          printf('turn-%04d', value),
          NULL,
          NULL,
          'completed',
          printf('2026-04-01T03:%02d:%02d.000Z', value / 60, value % 60),
          printf('2026-04-01T03:%02d:%02d.000Z', value / 60, value % 60),
          printf('2026-04-01T03:%02d:%02d.000Z', value / 60, value % 60),
          value,
          printf('checkpoint-%04d', value),
          'ready',
          '[]'
        FROM counter
      `;

      const fullDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      const subscriptionSnapshot = yield* snapshotQuery.getThreadDetailSnapshotById(
        ThreadId.make("thread-1"),
      );

      assert.equal(fullDetail._tag, "Some");
      assert.equal(subscriptionSnapshot._tag, "Some");
      if (fullDetail._tag === "Some" && subscriptionSnapshot._tag === "Some") {
        assert.equal(fullDetail.value.messages.length, THREAD_DETAIL_INITIAL_MESSAGE_LIMIT + 10);
        assert.equal(fullDetail.value.activities.length, THREAD_DETAIL_INITIAL_ACTIVITY_LIMIT + 10);
        assert.equal(
          fullDetail.value.proposedPlans.length,
          THREAD_DETAIL_INITIAL_PROPOSED_PLAN_LIMIT + 10,
        );
        assert.equal(
          fullDetail.value.checkpoints.length,
          THREAD_DETAIL_INITIAL_CHECKPOINT_LIMIT + 10,
        );
        assert.equal(
          subscriptionSnapshot.value.thread.messages.length,
          THREAD_DETAIL_INITIAL_MESSAGE_LIMIT,
        );
        assert.equal(
          subscriptionSnapshot.value.thread.messages[0]?.id,
          asMessageId("message-0010"),
        );
        assert.equal(
          subscriptionSnapshot.value.thread.messages.at(-1)?.id,
          asMessageId("message-0509"),
        );
        assert.deepEqual(subscriptionSnapshot.value.pageInfo.messages, {
          limit: THREAD_DETAIL_INITIAL_MESSAGE_LIMIT,
          included: THREAD_DETAIL_INITIAL_MESSAGE_LIMIT,
          hasMoreBefore: true,
        });
        assert.equal(
          subscriptionSnapshot.value.thread.activities.length,
          THREAD_DETAIL_INITIAL_ACTIVITY_LIMIT + 10,
        );
        assert.equal(
          subscriptionSnapshot.value.thread.activities[0]?.id,
          asEventId("activity-0000"),
        );
        assert.equal(
          subscriptionSnapshot.value.thread.activities.at(-1)?.id,
          asEventId("activity-0509"),
        );
        assert.deepEqual(subscriptionSnapshot.value.pageInfo.activities, {
          limit: THREAD_DETAIL_INITIAL_RESOURCE_WINDOW_LIMIT,
          included: THREAD_DETAIL_INITIAL_ACTIVITY_LIMIT + 10,
          hasMoreBefore: false,
        });
        assert.equal(
          subscriptionSnapshot.value.thread.proposedPlans.length,
          THREAD_DETAIL_INITIAL_PROPOSED_PLAN_LIMIT + 10,
        );
        assert.equal(subscriptionSnapshot.value.thread.proposedPlans[0]?.id, "plan-0000");
        assert.equal(subscriptionSnapshot.value.thread.proposedPlans.at(-1)?.id, "plan-0509");
        assert.deepEqual(subscriptionSnapshot.value.pageInfo.proposedPlans, {
          limit: THREAD_DETAIL_INITIAL_RESOURCE_WINDOW_LIMIT,
          included: THREAD_DETAIL_INITIAL_PROPOSED_PLAN_LIMIT + 10,
          hasMoreBefore: false,
        });
        assert.equal(
          subscriptionSnapshot.value.thread.checkpoints.length,
          THREAD_DETAIL_INITIAL_CHECKPOINT_LIMIT + 10,
        );
        assert.equal(
          subscriptionSnapshot.value.thread.checkpoints[0]?.checkpointRef,
          asCheckpointRef("checkpoint-0000"),
        );
        assert.equal(
          subscriptionSnapshot.value.thread.checkpoints.at(-1)?.checkpointRef,
          asCheckpointRef("checkpoint-0509"),
        );
        assert.deepEqual(subscriptionSnapshot.value.pageInfo.checkpoints, {
          limit: THREAD_DETAIL_INITIAL_RESOURCE_WINDOW_LIMIT,
          included: THREAD_DETAIL_INITIAL_CHECKPOINT_LIMIT + 10,
          hasMoreBefore: false,
        });

        const olderPage = yield* snapshotQuery.getThreadMessagesPageBefore({
          threadId: ThreadId.make("thread-1"),
          beforeMessageId: asMessageId("message-0010"),
          limit: 6,
        });
        assert.equal(olderPage._tag, "Some");
        if (olderPage._tag === "Some") {
          assert.deepEqual(
            olderPage.value.messages.map((message) => message.id),
            [
              asMessageId("message-0004"),
              asMessageId("message-0005"),
              asMessageId("message-0006"),
              asMessageId("message-0007"),
              asMessageId("message-0008"),
              asMessageId("message-0009"),
            ],
          );
          assert.deepEqual(olderPage.value.pageInfo, {
            limit: 6,
            included: 6,
            hasMoreBefore: true,
          });
        }

        const olderActivitiesPage = yield* snapshotQuery.getThreadActivitiesPageBefore({
          threadId: ThreadId.make("thread-1"),
          beforeActivityId: asEventId("activity-0000"),
          limit: 6,
        });
        assert.equal(olderActivitiesPage._tag, "Some");
        if (olderActivitiesPage._tag === "Some") {
          assert.deepEqual(olderActivitiesPage.value.activities, []);
          assert.deepEqual(olderActivitiesPage.value.pageInfo, {
            limit: 6,
            included: 0,
            hasMoreBefore: false,
          });
        }

        const olderProposedPlansPage = yield* snapshotQuery.getThreadProposedPlansPageBefore({
          threadId: ThreadId.make("thread-1"),
          beforeProposedPlanId: "plan-0000",
          limit: 6,
        });
        assert.equal(olderProposedPlansPage._tag, "Some");
        if (olderProposedPlansPage._tag === "Some") {
          assert.deepEqual(olderProposedPlansPage.value.proposedPlans, []);
          assert.deepEqual(olderProposedPlansPage.value.pageInfo, {
            limit: 6,
            included: 0,
            hasMoreBefore: false,
          });
        }

        const olderCheckpointsPage = yield* snapshotQuery.getThreadCheckpointsPageBefore({
          threadId: ThreadId.make("thread-1"),
          beforeCheckpointTurnCount: 0,
          limit: 6,
        });
        assert.equal(olderCheckpointsPage._tag, "Some");
        if (olderCheckpointsPage._tag === "Some") {
          assert.deepEqual(olderCheckpointsPage.value.checkpoints, []);
          assert.deepEqual(olderCheckpointsPage.value.pageInfo, {
            limit: 6,
            included: 0,
            hasMoreBefore: false,
          });
        }
      }
    }),
  );

  it.effect("does not expose hidden subagent activity as older main thread history", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_activities`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-01T00:00:00.000Z',
          '2026-04-01T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-01T00:00:00.000Z',
          '2026-04-01T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        WITH RECURSIVE counter(value) AS (
          SELECT 0
          UNION ALL
          SELECT value + 1 FROM counter WHERE value < ${THREAD_DETAIL_INITIAL_ACTIVITY_LIMIT + 20}
        )
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        SELECT
          printf('subagent-activity-%04d', value),
          'thread-1',
          NULL,
          'tool',
          'subagent.content.delta',
          'Subagent content delta',
          '{}',
          value,
          printf('2026-04-01T01:%02d:%02d.000Z', value / 60, value % 60)
        FROM counter
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'visible-activity-1',
            'thread-1',
            NULL,
            'tool',
            'tool.started',
            'Ran command',
            '{}',
            2000,
            '2026-04-01T02:00:00.000Z'
          ),
          (
            'visible-activity-2',
            'thread-1',
            NULL,
            'tool',
            'tool.completed',
            'Ran command',
            '{}',
            2001,
            '2026-04-01T02:00:01.000Z'
          )
      `;

      const subscriptionSnapshot = yield* snapshotQuery.getThreadDetailSnapshotById(
        ThreadId.make("thread-1"),
      );

      assert.equal(subscriptionSnapshot._tag, "Some");
      if (subscriptionSnapshot._tag === "Some") {
        assert.deepEqual(
          subscriptionSnapshot.value.thread.activities.map((activity) => activity.id),
          [asEventId("visible-activity-1"), asEventId("visible-activity-2")],
        );
        assert.deepEqual(subscriptionSnapshot.value.pageInfo.activities, {
          limit: THREAD_DETAIL_INITIAL_RESOURCE_WINDOW_LIMIT,
          included: 2,
          hasMoreBefore: false,
        });
      }
    }),
  );

  it.effect("uses projection_threads.latest_turn_id for targeted thread latest turn queries", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-02T00:00:00.000Z',
          '2026-04-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          '2026-04-02T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-02T00:00:02.000Z',
          '2026-04-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-02T00:00:05.000Z',
            '2026-04-02T00:00:06.000Z',
            '2026-04-02T00:00:20.000Z',
            5,
            'checkpoint-5',
            'ready',
            '[]'
          ),
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-02T00:00:30.000Z',
            '2026-04-02T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      const threadShell = yield* snapshotQuery.getThreadShellById(ThreadId.make("thread-1"));
      assert.equal(threadShell._tag, "Some");
      if (threadShell._tag === "Some") {
        assert.equal(threadShell.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(threadShell.value.latestTurn?.state, "running");
        assert.equal(threadShell.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.equal(threadDetail.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(threadDetail.value.latestTurn?.state, "running");
        assert.equal(threadDetail.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }
    }),
  );
});
