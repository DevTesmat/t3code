import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  reconcileThreadNotificationEffects,
  resetThreadNotificationEffectsForTests,
} from "./threadNotificationEffects";
import { useUiStateStore } from "./uiStateStore";

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-1");
const threadKey = scopedThreadKey(scopeThreadRef(environmentId, threadId));

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
    vi.stubGlobal(
      "Audio",
      vi.fn(function AudioMock() {
        return {
          currentTime: 0,
          play,
        };
      }),
    );
    play.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
});
