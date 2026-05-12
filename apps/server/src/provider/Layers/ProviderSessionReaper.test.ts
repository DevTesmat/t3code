import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ThreadId,
  TurnId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Option, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderValidationError } from "../Errors.ts";
import { ProviderSessionReaper } from "../Services/ProviderSessionReaper.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeProviderSessionReaperLive } from "./ProviderSessionReaper.ts";

const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };

  return poll();
}

const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

function makeReadModel(
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly session: {
      readonly threadId: ThreadId;
      readonly status:
        | "starting"
        | "running"
        | "needs_resume"
        | "ready"
        | "interrupted"
        | "stopped"
        | "error";
      readonly providerName: "codex" | "claudeAgent";
      readonly runtimeMode: "approval-required" | "full-access" | "auto-accept-edits";
      readonly activeTurnId: TurnId | null;
      readonly lastError: string | null;
      readonly updatedAt: string;
    } | null;
  }>,
): OrchestrationReadModel {
  const now = new Date().toISOString();
  const projectId = ProjectId.make("project-provider-session-reaper");

  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: projectId,
        title: "Provider Reaper Project",
        workspaceRoot: "/tmp/provider-reaper-project",
        repositoryIdentity: null,
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: threads.map((thread) => ({
      id: thread.id,
      projectId,
      title: `Thread ${thread.id}`,
      modelSelection: defaultModelSelection,
      interactionMode: "default" as const,
      runtimeMode: "full-access" as const,
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      pinnedAt: null,
      archivedAt: null,
      latestTurn: null,
      totalWorkDurationMs: 0,
      messages: [],
      session: thread.session,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    })),
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
      pinnedAt: thread.pinnedAt ?? null,
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

describe("ProviderSessionReaper", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    ProviderSessionReaper | ProviderSessionRuntimeRepository,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  async function createHarness(input: {
    readonly readModel: ReturnType<typeof makeReadModel>;
    readonly stopSessionImplementation?: (input: {
      readonly threadId: ThreadId;
    }) => ReturnType<ProviderServiceShape["stopSession"]>;
  }) {
    const stoppedThreadIds = new Set<ThreadId>();
    const dispatched: OrchestrationCommand[] = [];
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(
      (request) =>
        (input.stopSessionImplementation
          ? input.stopSessionImplementation(request)
          : Effect.sync(() => {
              stoppedThreadIds.add(request.threadId);
            })) as ReturnType<ProviderServiceShape["stopSession"]>,
    );

    const providerService: ProviderServiceShape = {
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession,
      recoverSession: () => unsupported(),
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
      getInstanceInfo: (instanceId) => {
        const driverKind = ProviderDriverKind.make(String(instanceId));
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey: `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      streamEvents: Stream.empty,
    };

    const orchestrationEngine: OrchestrationEngineShape = {
      getReadModel: () => Effect.die("unused"),
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
    };

    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(runtimeRepositoryLayer),
    );
    const layer = makeProviderSessionReaperLive({
      inactivityThresholdMs: 1_000,
      sweepIntervalMs: 60_000,
    }).pipe(
      Layer.provideMerge(providerSessionDirectoryLayer),
      Layer.provideMerge(runtimeRepositoryLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getShellSnapshot: () => Effect.succeed(makeShellSnapshot(input.readModel)),
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    return { stopSession, stoppedThreadIds, dispatched };
  }

  it("reaps stale persisted sessions without active turns", async () => {
    const threadId = ThreadId.make("thread-reaper-stale");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-stale",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.stopSession.mock.calls.length === 1);

    expect(harness.stopSession.mock.calls[0]?.[0]).toEqual({ threadId });
    expect(harness.stoppedThreadIds.has(threadId)).toBe(true);
  });

  it("marks stale active-turn sessions as needing explicit resume", async () => {
    const threadId = ThreadId.make("thread-reaper-active-turn");
    const turnId = TurnId.make("turn-reaper-active");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-active-turn",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await waitFor(
      () =>
        harness.stopSession.mock.calls.length === 1 &&
        harness.dispatched.some(
          (command) =>
            command.type === "thread.session.set" && command.session.status === "needs_resume",
        ),
    );

    expect(harness.stopSession.mock.calls[0]?.[0]).toEqual({ threadId });
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
    const sessionSet = harness.dispatched.find((command) => command.type === "thread.session.set");
    expect(sessionSet?.type).toBe("thread.session.set");
    if (sessionSet?.type === "thread.session.set") {
      expect(sessionSet.session.status).toBe("needs_resume");
      expect(sessionSet.session.activeTurnId).toBeNull();
      expect(sessionSet.session.lastError).toBeNull();
    }
  });

  it("does not reap sessions that are still within the inactivity threshold", async () => {
    const threadId = ThreadId.make("thread-reaper-fresh");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-fresh",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("skips persisted sessions that are already marked stopped", async () => {
    const threadId = ThreadId.make("thread-reaper-stopped");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "stopped",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "stopped",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-stopped",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("continues reaping other sessions when one stop attempt fails", async () => {
    const failedThreadId = ThreadId.make("thread-reaper-stop-failure");
    const reapedThreadId = ThreadId.make("thread-reaper-stop-success");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: failedThreadId,
          session: {
            threadId: failedThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
        {
          id: reapedThreadId,
          session: {
            threadId: reapedThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      stopSessionImplementation: (request) =>
        request.threadId === failedThreadId
          ? Effect.fail(
              new ProviderValidationError({
                operation: "ProviderSessionReaper.test",
                issue: "simulated stop failure",
              }),
            )
          : Effect.void,
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId: failedThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-failure",
        },
        runtimePayload: null,
      }),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId: reapedThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:01:00.000Z",
        resumeCursor: {
          opaque: "resume-success",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.stopSession.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.map(([request]) => request.threadId)).toEqual([
      failedThreadId,
      reapedThreadId,
    ]);
  });

  it("continues reaping other sessions when one stop attempt defects", async () => {
    const defectThreadId = ThreadId.make("thread-reaper-stop-defect");
    const reapedThreadId = ThreadId.make("thread-reaper-stop-after-defect");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: defectThreadId,
          session: {
            threadId: defectThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
        {
          id: reapedThreadId,
          session: {
            threadId: reapedThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      stopSessionImplementation: (request) =>
        request.threadId === defectThreadId
          ? Effect.die(new Error("simulated stop defect"))
          : Effect.void,
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId: defectThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-defect",
        },
        runtimePayload: null,
      }),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId: reapedThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:01:00.000Z",
        resumeCursor: {
          opaque: "resume-after-defect",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.stopSession.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.map(([request]) => request.threadId)).toEqual([
      defectThreadId,
      reapedThreadId,
    ]);
  });
});
