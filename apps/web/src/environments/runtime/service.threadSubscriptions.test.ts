import { QueryClient } from "@tanstack/react-query";
import {
  CommandId,
  EnvironmentId,
  EventId,
  type OrchestrationEvent,
  ProjectId,
  ProviderItemId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSubscribeThread = vi.fn();
const mockThreadUnsubscribe = vi.fn();
const mockCreateEnvironmentConnection = vi.fn();
const mockCreateWsRpcClient = vi.fn();
const mockWaitForSavedEnvironmentRegistryHydration = vi.fn();
const mockListSavedEnvironmentRecords = vi.fn();
const mockSavedEnvironmentRegistrySubscribe = vi.fn();

function MockWsTransport() {
  return undefined;
}

vi.mock("../primary", () => ({
  getPrimaryKnownEnvironment: vi.fn(() => ({
    id: "env-1",
    label: "Primary environment",
    source: "window-origin",
    target: {
      httpBaseUrl: "http://127.0.0.1:3000/",
      wsBaseUrl: "ws://127.0.0.1:3000/",
    },
    environmentId: EnvironmentId.make("env-1"),
  })),
}));

vi.mock("./catalog", () => ({
  getSavedEnvironmentRecord: vi.fn(),
  hasSavedEnvironmentRegistryHydrated: vi.fn(() => true),
  listSavedEnvironmentRecords: mockListSavedEnvironmentRecords,
  persistSavedEnvironmentRecord: vi.fn(),
  readSavedEnvironmentBearerToken: vi.fn(),
  removeSavedEnvironmentBearerToken: vi.fn(),
  useSavedEnvironmentRegistryStore: {
    subscribe: mockSavedEnvironmentRegistrySubscribe,
    getState: () => ({
      upsert: vi.fn(),
      remove: vi.fn(),
      markConnected: vi.fn(),
    }),
  },
  useSavedEnvironmentRuntimeStore: {
    getState: () => ({
      ensure: vi.fn(),
      patch: vi.fn(),
      clear: vi.fn(),
    }),
  },
  waitForSavedEnvironmentRegistryHydration: mockWaitForSavedEnvironmentRegistryHydration,
  writeSavedEnvironmentBearerToken: vi.fn(),
}));

vi.mock("./connection", () => ({
  createEnvironmentConnection: mockCreateEnvironmentConnection,
}));

vi.mock("../../rpc/wsRpcClient", () => ({
  createWsRpcClient: mockCreateWsRpcClient,
}));

vi.mock("../../rpc/wsTransport", () => ({
  WsTransport: MockWsTransport,
}));

function makeThreadShellSnapshot(params: {
  readonly threadId: ThreadId;
  readonly sessionStatus?:
    | "idle"
    | "starting"
    | "running"
    | "ready"
    | "interrupted"
    | "stopped"
    | "error";
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly hasActionableProposedPlan?: boolean;
}): OrchestrationShellSnapshot {
  const projectId = ProjectId.make("project-1");
  const turnId = TurnId.make("turn-1");

  return {
    snapshotSequence: 1,
    projects: [],
    updatedAt: "2026-04-13T00:00:00.000Z",
    threads: [
      {
        id: params.threadId,
        projectId,
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn:
          params.sessionStatus === "running"
            ? {
                turnId,
                state: "running",
                requestedAt: "2026-04-13T00:00:00.000Z",
                startedAt: "2026-04-13T00:00:01.000Z",
                completedAt: null,
                assistantMessageId: null,
              }
            : null,
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
        archivedAt: null,
        session: params.sessionStatus
          ? {
              threadId: params.threadId,
              status: params.sessionStatus,
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: params.sessionStatus === "running" ? turnId : null,
              lastError: null,
              updatedAt: "2026-04-13T00:00:00.000Z",
            }
          : null,
        latestUserMessageAt: null,
        hasPendingApprovals: params.hasPendingApprovals ?? false,
        hasPendingUserInput: params.hasPendingUserInput ?? false,
        latestPendingUserInputAt: params.hasPendingUserInput ? "2026-04-13T00:00:00.000Z" : null,
        hasActionableProposedPlan: params.hasActionableProposedPlan ?? false,
      },
    ],
  };
}

function makeThreadDetail(params: {
  readonly threadId: ThreadId;
  readonly activities?: OrchestrationThread["activities"];
}): OrchestrationThread {
  const projectId = ProjectId.make("project-1");
  return {
    id: params.threadId,
    projectId,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    totalWorkDurationMs: 0,
    createdAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
    pinnedAt: null,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: params.activities ?? [],
    checkpoints: [],
    session: null,
  };
}

function makeActivityEvent(params: {
  readonly sequence: number;
  readonly threadId: ThreadId;
  readonly activityId: string;
  readonly summary?: string;
}): OrchestrationEvent {
  const occurredAt = `2026-04-13T00:00:${String(params.sequence).padStart(2, "0")}.000Z`;
  return {
    sequence: params.sequence,
    eventId: EventId.make(`event-${params.sequence}`),
    aggregateKind: "thread",
    aggregateId: params.threadId,
    occurredAt,
    commandId: CommandId.make(`command-${params.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.activity-appended",
    payload: {
      threadId: params.threadId,
      activity: {
        id: EventId.make(params.activityId),
        tone: "tool",
        kind: "tool.started",
        summary: params.summary ?? "Ran command started",
        payload: {
          itemType: "command_execution",
          detail: "bun lint",
          data: {
            toolCallId: "tool-1",
          },
        },
        turnId: null,
        createdAt: occurredAt,
      },
    },
  };
}

function emitThreadItem(item: OrchestrationThreadStreamItem): void {
  const callback = mockSubscribeThread.mock.calls[0]?.[1] as
    | ((next: OrchestrationThreadStreamItem) => void)
    | undefined;
  expect(callback).toBeDefined();
  callback?.(item);
}

describe("retainThreadDetailSubscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();

    mockThreadUnsubscribe.mockImplementation(() => undefined);
    mockSubscribeThread.mockImplementation(() => mockThreadUnsubscribe);
    mockCreateWsRpcClient.mockReturnValue({
      orchestration: {
        subscribeThread: mockSubscribeThread,
      },
    });
    mockCreateEnvironmentConnection.mockImplementation((input) => ({
      kind: input.kind,
      environmentId: input.knownEnvironment.environmentId,
      knownEnvironment: input.knownEnvironment,
      client: input.client,
      ensureBootstrapped: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    }));
    mockSavedEnvironmentRegistrySubscribe.mockReturnValue(() => undefined);
    mockWaitForSavedEnvironmentRegistryHydration.mockResolvedValue(undefined);
    mockListSavedEnvironmentRecords.mockReturnValue([]);
  });

  afterEach(async () => {
    const { resetEnvironmentServiceForTests } = await import("./service");
    await resetEnvironmentServiceForTests();
    vi.useRealTimers();
  });

  it("keeps thread detail subscriptions warm across releases until idle eviction", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-1");

    const releaseFirst = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    const releaseSecond = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseSecond();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(28 * 60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps non-idle thread detail subscriptions attached until the thread becomes idle", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "ready",
        hasPendingApprovals: true,
      }),
      environmentId,
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 2,
        thread: makeThreadShellSnapshot({
          threadId,
          sessionStatus: "idle",
        }).threads[0]!,
      },
      environmentId,
    );

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("allows a larger idle cache before capacity eviction starts", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");

    for (let index = 0; index < 12; index += 1) {
      const release = retainThreadDetailSubscription(
        environmentId,
        ThreadId.make(`thread-${index + 1}`),
      );
      release();
    }

    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("disposes cached thread detail subscriptions when the environment service resets", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-2");

    const release = retainThreadDetailSubscription(environmentId, threadId);
    release();

    await resetEnvironmentServiceForTests();
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
  });

  it("hydrates an initially empty thread detail from the subscription snapshot", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-snapshot-hydrate");

    const release = retainThreadDetailSubscription(environmentId, threadId);
    emitThreadItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 10,
        thread: makeThreadDetail({
          threadId,
          activities: [
            {
              id: EventId.make("activity-from-snapshot"),
              tone: "tool",
              kind: "tool.started",
              summary: "Snapshot tool",
              payload: {},
              turnId: null,
              createdAt: "2026-04-13T00:00:10.000Z",
            },
          ],
        }),
      },
    });

    const thread = selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId));
    expect(thread?.activities.map((activity) => activity.id)).toEqual(["activity-from-snapshot"]);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("preserves live tool activities when an older detail snapshot arrives", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-stale-snapshot");

    const release = retainThreadDetailSubscription(environmentId, threadId);
    emitThreadItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 10,
        thread: makeThreadDetail({ threadId }),
      },
    });
    emitThreadItem({
      kind: "event",
      event: makeActivityEvent({
        sequence: 11,
        threadId,
        activityId: "live-tool",
      }),
    });
    emitThreadItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 10,
        thread: makeThreadDetail({ threadId }),
      },
    });

    const thread = selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId));
    expect(thread?.activities.map((activity) => activity.id)).toEqual(["live-tool"]);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("accepts a newer detail snapshot after live thread detail events", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-newer-snapshot");

    const release = retainThreadDetailSubscription(environmentId, threadId);
    emitThreadItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 10,
        thread: makeThreadDetail({ threadId }),
      },
    });
    emitThreadItem({
      kind: "event",
      event: makeActivityEvent({
        sequence: 11,
        threadId,
        activityId: "live-tool",
      }),
    });
    emitThreadItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 12,
        thread: makeThreadDetail({
          threadId,
          activities: [
            {
              id: EventId.make("snapshot-tool"),
              tone: "tool",
              kind: "tool.completed",
              summary: "Snapshot completed tool",
              payload: {},
              turnId: null,
              createdAt: "2026-04-13T00:00:12.000Z",
            },
          ],
        }),
      },
    });

    const thread = selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId));
    expect(thread?.activities.map((activity) => activity.id)).toEqual(["snapshot-tool"]);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("routes command output stream items into the live output envelope", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    const { readLiveCommandOutputSnapshot } = await import("~/liveCommandOutput");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-output-delta");

    const release = retainThreadDetailSubscription(environmentId, threadId);
    emitThreadItem({
      kind: "command-output-delta",
      delta: {
        threadId,
        turnId: TurnId.make("turn-1"),
        toolCallId: ProviderItemId.make("tool-1"),
        chunkId: EventId.make("chunk-1"),
        createdAt: "2026-04-13T00:00:11.000Z",
        delta: "line 1\n",
      },
    });

    expect(
      readLiveCommandOutputSnapshot({
        environmentId,
        threadId,
        toolCallId: "tool-1",
      }).text,
    ).toBe("line 1\n");

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("ignores duplicate and older live thread detail events", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-live-monotonic");

    const release = retainThreadDetailSubscription(environmentId, threadId);
    emitThreadItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 10,
        thread: makeThreadDetail({ threadId }),
      },
    });
    emitThreadItem({
      kind: "event",
      event: makeActivityEvent({
        sequence: 12,
        threadId,
        activityId: "newer-tool",
      }),
    });
    emitThreadItem({
      kind: "event",
      event: makeActivityEvent({
        sequence: 12,
        threadId,
        activityId: "duplicate-sequence-tool",
      }),
    });
    emitThreadItem({
      kind: "event",
      event: makeActivityEvent({
        sequence: 11,
        threadId,
        activityId: "older-tool",
      }),
    });

    const thread = selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId));
    expect(thread?.activities.map((activity) => activity.id)).toEqual(["newer-tool"]);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("still applies a stale first snapshot when live events arrived before thread hydration", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-event-before-snapshot");

    const release = retainThreadDetailSubscription(environmentId, threadId);
    emitThreadItem({
      kind: "event",
      event: makeActivityEvent({
        sequence: 11,
        threadId,
        activityId: "event-before-snapshot",
      }),
    });
    emitThreadItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 10,
        thread: makeThreadDetail({
          threadId,
          activities: [
            {
              id: EventId.make("snapshot-hydrates-thread"),
              tone: "tool",
              kind: "tool.started",
              summary: "Snapshot hydrates thread",
              payload: {},
              turnId: null,
              createdAt: "2026-04-13T00:00:10.000Z",
            },
          ],
        }),
      },
    });

    const thread = selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId));
    expect(thread?.activities.map((activity) => activity.id)).toEqual(["snapshot-hydrates-thread"]);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });
});
