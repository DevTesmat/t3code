import {
  type DesktopBridge,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { getClientSettings as getClientSettingsType } from "./hooks/useSettings";
import {
  reconcileThreadNotificationEffects,
  resetThreadNotificationEffectsForTests,
} from "./threadNotificationEffects";
import { useUiStateStore } from "./uiStateStore";

const mockGetClientSettings = vi.hoisted(() => vi.fn<typeof getClientSettingsType>());

vi.mock("./hooks/useSettings", () => ({
  getClientSettings: mockGetClientSettings,
}));

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-1");
const threadKey = scopedThreadKey(scopeThreadRef(environmentId, threadId));

function makeDesktopBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    getAppBranding: () => null,
    getLocalEnvironmentBootstrap: () => null,
    getClientSettings: async () => null,
    setClientSettings: async () => undefined,
    getSavedEnvironmentRegistry: async () => [],
    setSavedEnvironmentRegistry: async () => undefined,
    getSavedEnvironmentSecret: async () => null,
    setSavedEnvironmentSecret: async () => true,
    removeSavedEnvironmentSecret: async () => undefined,
    getServerExposureState: async () => ({
      mode: "local-only",
      endpointUrl: null,
      advertisedHost: null,
    }),
    setServerExposureMode: async () => ({
      mode: "local-only",
      endpointUrl: null,
      advertisedHost: null,
    }),
    setRunningThreadsState: async () => undefined,
    pickFolder: async () => null,
    confirm: async () => true,
    setTheme: async () => undefined,
    showContextMenu: async () => null,
    openExternal: async () => true,
    playNotificationSound: async () => undefined,
    onMenuAction: () => () => undefined,
    getUpdateState: async () => {
      throw new Error("getUpdateState not implemented in test");
    },
    setUpdateChannel: async () => {
      throw new Error("setUpdateChannel not implemented in test");
    },
    checkForUpdate: async () => {
      throw new Error("checkForUpdate not implemented in test");
    },
    downloadUpdate: async () => {
      throw new Error("downloadUpdate not implemented in test");
    },
    installUpdate: async () => {
      throw new Error("installUpdate not implemented in test");
    },
    onUpdateState: () => () => undefined,
    ...overrides,
  };
}

function makeThread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Thread 1",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestPendingUserInputAt: null,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("reconcileThreadNotificationEffects", () => {
  const play = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    resetThreadNotificationEffectsForTests();
    useUiStateStore.setState({ threadLastVisitedAtById: {} });
    mockGetClientSettings.mockReturnValue({ notificationSoundsEnabled: true } as never);
    vi.stubGlobal("window", {});
    vi.stubGlobal(
      "Audio",
      vi.fn(function AudioMock() {
        return {
          currentTime: 0,
          play,
        };
      }),
    );
    vi.stubGlobal("btoa", (value: string) => Buffer.from(value, "binary").toString("base64"));
    play.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the native desktop notification sound in Electron and skips browser audio", () => {
    const playNotificationSound = vi.fn(() => Promise.resolve());
    const AudioMock = vi.fn(function AudioMock() {
      return {
        currentTime: 0,
        play,
      };
    });
    vi.stubGlobal("Audio", AudioMock);
    vi.stubGlobal("window", {
      desktopBridge: makeDesktopBridge({ playNotificationSound }),
    });
    const thread = makeThread({
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        requestedAt: "2026-03-09T10:00:00.000Z",
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: "2026-03-09T10:05:00.000Z",
        assistantMessageId: null,
      },
    });

    reconcileThreadNotificationEffects({ environmentId, threads: [thread] });
    reconcileThreadNotificationEffects({ environmentId, threads: [thread] });

    expect(playNotificationSound).toHaveBeenCalledTimes(1);
    expect(AudioMock).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it("builds a reusable generated wav instead of the old embedded stump sample", () => {
    const AudioMock = vi.fn(function AudioMock(src: string) {
      return {
        currentTime: 0,
        play,
        src,
      };
    });
    vi.stubGlobal("Audio", AudioMock);
    const thread = makeThread({
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        requestedAt: "2026-03-09T10:00:00.000Z",
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: "2026-03-09T10:05:00.000Z",
        assistantMessageId: null,
      },
    });

    reconcileThreadNotificationEffects({ environmentId, threads: [thread] });
    reconcileThreadNotificationEffects({ environmentId, threads: [thread] });

    expect(AudioMock).toHaveBeenCalledTimes(1);
    expect(AudioMock).toHaveBeenCalledWith(expect.stringMatching(/^data:audio\/wav;base64,/));
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("chimes once for a newly unseen completion", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        requestedAt: "2026-03-09T10:00:00.000Z",
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: "2026-03-09T10:05:00.000Z",
        assistantMessageId: null,
      },
    });

    reconcileThreadNotificationEffects({ environmentId, threads: [thread] });
    reconcileThreadNotificationEffects({ environmentId, threads: [thread] });

    expect(play).toHaveBeenCalledTimes(1);
  });

  it("does not chime for a completed timestamp while the session is still running", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        requestedAt: "2026-03-09T10:00:00.000Z",
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: "2026-03-09T10:05:00.000Z",
        assistantMessageId: null,
      },
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: "turn-1" as never,
        lastError: null,
        updatedAt: "2026-03-09T10:05:00.000Z",
      },
    });

    reconcileThreadNotificationEffects({ environmentId, threads: [thread] });

    expect(play).not.toHaveBeenCalled();
  });

  it("chimes once for a newly unseen pending input timestamp", () => {
    const thread = makeThread({
      hasPendingUserInput: true,
      latestPendingUserInputAt: "2026-03-09T10:06:00.000Z",
    });

    reconcileThreadNotificationEffects({ environmentId, threads: [thread] });
    reconcileThreadNotificationEffects({ environmentId, threads: [thread] });

    expect(play).toHaveBeenCalledTimes(1);
  });

  it("does not chime for initial already-seen snapshot state or plan ready", () => {
    useUiStateStore.setState({
      threadLastVisitedAtById: {
        [threadKey]: "2026-03-09T10:06:00.000Z",
      },
    });

    reconcileThreadNotificationEffects({
      environmentId,
      threads: [
        makeThread({
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          latestTurn: {
            turnId: "turn-1" as never,
            state: "completed",
            requestedAt: "2026-03-09T10:00:00.000Z",
            startedAt: "2026-03-09T10:00:00.000Z",
            completedAt: "2026-03-09T10:05:00.000Z",
            assistantMessageId: null,
          },
        }),
      ],
      suppressInitialChime: true,
    });

    expect(play).not.toHaveBeenCalled();
  });

  it("does not chime when notification sounds are disabled", () => {
    mockGetClientSettings.mockReturnValue({ notificationSoundsEnabled: false } as never);
    const playNotificationSound = vi.fn(() => Promise.resolve());
    vi.stubGlobal("window", {
      desktopBridge: makeDesktopBridge({ playNotificationSound }),
    });
    const thread = makeThread({
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        requestedAt: "2026-03-09T10:00:00.000Z",
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: "2026-03-09T10:05:00.000Z",
        assistantMessageId: null,
      },
    });

    reconcileThreadNotificationEffects({ environmentId, threads: [thread] });

    expect(play).not.toHaveBeenCalled();
    expect(playNotificationSound).not.toHaveBeenCalled();
  });
});
