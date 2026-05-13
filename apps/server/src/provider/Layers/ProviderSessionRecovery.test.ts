import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionRecovery } from "../Services/ProviderSessionRecovery.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import { ProviderSessionRecoveryLive } from "./ProviderSessionRecovery.ts";

const codexInstanceId = ProviderInstanceId.make("codex");
const codexDriver = ProviderDriverKind.make("codex");
const projectId = ProjectId.make("project-recovery");
const now = "2026-05-08T10:00:00.000Z";

const defaultModelSelection = {
  instanceId: codexInstanceId,
  model: "gpt-5-codex",
} as const;

const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

function makeReadModel(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: projectId,
        title: "Recovery Project",
        workspaceRoot: "/tmp/recovery-project",
        repositoryIdentity: null,
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: input.threadId,
        projectId,
        title: "Recovery Thread",
        modelSelection: defaultModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        pinnedAt: null,
        latestTurn: {
          turnId: input.turnId,
          state: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          assistantMessageId: null,
        },
        messages: [],
        session: {
          threadId: input.threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: codexInstanceId,
          runtimeMode: "full-access",
          activeTurnId: input.turnId,
          lastError: null,
          updatedAt: now,
        },
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
        totalWorkDurationMs: 0,
      },
    ],
  };
}

function makeShellSnapshot(readModel: OrchestrationReadModel): OrchestrationShellSnapshot {
  return {
    snapshotSequence: readModel.snapshotSequence,
    updatedAt: readModel.updatedAt,
    projects: readModel.projects.map((project) => ({
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      repositoryIdentity: project.repositoryIdentity ?? null,
      defaultModelSelection: project.defaultModelSelection,
      scripts: project.scripts,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    })),
    threads: readModel.threads.map((thread) => ({
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      latestTurn: thread.latestTurn,
      totalWorkDurationMs: thread.totalWorkDurationMs ?? 0,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      pinnedAt: thread.pinnedAt,
      archivedAt: thread.archivedAt,
      session: thread.session,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      latestPendingUserInputAt: null,
      hasActionableProposedPlan: false,
    })),
  };
}

function makeHarness(input: { readonly readModel: OrchestrationReadModel }) {
  const dispatched: OrchestrationCommand[] = [];
  const providerService: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    steerTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    recoverSession: () => unsupported(),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: codexDriver,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: codexDriver,
          continuationKey: `codex:instance:${instanceId}`,
        },
      }),
    rollbackConversation: () => unsupported(),
    streamEvents: Stream.empty,
  };
  const orchestrationEngine: OrchestrationEngineShape = {
    getReadModel: () => Effect.die("unused"),
    reloadFromStorage: () => Effect.succeed(input.readModel),
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
    streamDomainEvents: Stream.empty,
  };

  const layer = ProviderSessionRecoveryLive.pipe(
    Layer.provide(Layer.succeed(ProviderService, providerService)),
    Layer.provide(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () => Effect.succeed(makeShellSnapshot(input.readModel)),
      }),
    ),
  );

  return { layer, dispatched };
}

describe("ProviderSessionRecovery", () => {
  it("marks stale running threads as needing explicit user resume", async () => {
    const threadId = ThreadId.make("thread-recovery-failed");
    const turnId = TurnId.make("turn-recovery-failed");
    const harness = makeHarness({
      readModel: makeReadModel({ threadId, turnId }),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const recovery = yield* ProviderSessionRecovery;
        yield* recovery.recoverStaleRunningThreads();
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(harness.dispatched).toHaveLength(1);
    const command = harness.dispatched[0];
    expect(command?.type).toBe("thread.session.set");
    if (command?.type === "thread.session.set") {
      expect(command.session.status).toBe("needs_resume");
      expect(command.session.activeTurnId).toBeNull();
      expect(command.session.lastError).toBeNull();
    }
  });
});
