import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type ProviderSession,
} from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderSessionRecovery } from "../Services/ProviderSessionRecovery.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  PROVIDER_SESSION_RECOVERY_RESTART_MESSAGE,
  ProviderSessionRecoveryLive,
} from "./ProviderSessionRecovery.ts";
import { ProviderValidationError } from "../Errors.ts";

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

function makeHarness(input: {
  readonly recoverSession: ProviderServiceShape["recoverSession"];
  readonly readModel: OrchestrationReadModel;
}) {
  const dispatched: OrchestrationCommand[] = [];
  const providerService: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    recoverSession: input.recoverSession,
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
    getReadModel: () => Effect.succeed(input.readModel),
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
  );

  return { layer, dispatched };
}

describe("ProviderSessionRecovery", () => {
  it("keeps stale running threads running when provider recovery succeeds", async () => {
    const threadId = ThreadId.make("thread-recovery-success");
    const turnId = TurnId.make("turn-recovery-success");
    const recoverSession = vi.fn<ProviderServiceShape["recoverSession"]>((requestThreadId) =>
      Effect.succeed({
        provider: codexDriver,
        providerInstanceId: codexInstanceId,
        status: "ready",
        runtimeMode: "full-access",
        threadId: requestThreadId,
        createdAt: now,
        updatedAt: now,
      } satisfies ProviderSession),
    );
    const harness = makeHarness({
      recoverSession,
      readModel: makeReadModel({ threadId, turnId }),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const recovery = yield* ProviderSessionRecovery;
        yield* recovery.recoverStaleRunningThreads();
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(recoverSession).toHaveBeenCalledTimes(1);
    expect(harness.dispatched).toHaveLength(1);
    const command = harness.dispatched[0];
    expect(command?.type).toBe("thread.session.set");
    if (command?.type === "thread.session.set") {
      expect(command.session.status).toBe("running");
      expect(command.session.activeTurnId).toBe(turnId);
      expect(command.session.lastError).toBeNull();
    }
  });

  it("marks stale running threads interrupted when provider recovery fails", async () => {
    const threadId = ThreadId.make("thread-recovery-failed");
    const turnId = TurnId.make("turn-recovery-failed");
    const recoverSession = vi.fn<ProviderServiceShape["recoverSession"]>(() =>
      Effect.fail(
        new ProviderValidationError({
          operation: "ProviderSessionRecovery.test",
          issue: "missing resume cursor",
        }),
      ),
    );
    const harness = makeHarness({
      recoverSession,
      readModel: makeReadModel({ threadId, turnId }),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const recovery = yield* ProviderSessionRecovery;
        yield* recovery.recoverStaleRunningThreads();
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(recoverSession).toHaveBeenCalledTimes(1);
    expect(harness.dispatched).toHaveLength(1);
    const command = harness.dispatched[0];
    expect(command?.type).toBe("thread.session.set");
    if (command?.type === "thread.session.set") {
      expect(command.session.status).toBe("interrupted");
      expect(command.session.activeTurnId).toBeNull();
      expect(command.session.lastError).toBe(PROVIDER_SESSION_RECOVERY_RESTART_MESSAGE);
    }
  });
});
