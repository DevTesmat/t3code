import { ProviderDriverKind, type DesktopBridge } from "@t3tools/contracts";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  countRunningThreads,
  isThreadRunning,
  startRunningThreadsStatePublisher,
} from "./runningThreadsState";
import { useStore } from "./store";
import type { Thread } from "./types";

function makeThreadState(
  overrides: Partial<Pick<Thread, "session" | "latestTurn">>,
): Pick<Thread, "session" | "latestTurn"> {
  return {
    session: null,
    latestTurn: null,
    ...overrides,
  };
}

function makeSession(
  overrides: Partial<NonNullable<Thread["session"]>>,
): NonNullable<Thread["session"]> {
  return {
    provider: ProviderDriverKind.make("codex"),
    status: "ready",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    orchestrationStatus: "idle",
    ...overrides,
  };
}

function makeLatestTurn(
  state: NonNullable<Thread["latestTurn"]>["state"],
): NonNullable<Thread["latestTurn"]> {
  return {
    turnId: "turn-1" as NonNullable<Thread["latestTurn"]>["turnId"],
    state,
    requestedAt: "2026-05-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    assistantMessageId: null,
  };
}

function getWindowForTest(): Window & typeof globalThis & { desktopBridge?: DesktopBridge } {
  return globalThis.window as Window & typeof globalThis & { desktopBridge?: DesktopBridge };
}

describe("runningThreadsState", () => {
  const initialState = useStore.getInitialState();

  beforeEach(() => {
    vi.stubGlobal("window", {});
    useStore.setState(initialState, true);
    Reflect.deleteProperty(getWindowForTest(), "desktopBridge");
  });

  afterEach(() => {
    Reflect.deleteProperty(getWindowForTest(), "desktopBridge");
    vi.unstubAllGlobals();
  });

  it("counts session.status running threads", () => {
    expect(isThreadRunning(makeThreadState({ session: makeSession({ status: "running" }) }))).toBe(
      true,
    );
  });

  it("counts orchestrationStatus running threads even when legacy status is not running", () => {
    expect(
      isThreadRunning(
        makeThreadState({
          session: makeSession({ status: "ready", orchestrationStatus: "running" }),
        }),
      ),
    ).toBe(true);
  });

  it("counts latestTurn.state running threads", () => {
    expect(isThreadRunning(makeThreadState({ latestTurn: makeLatestTurn("running") }))).toBe(true);
  });

  it("ignores idle, stopped, and closed threads", () => {
    expect(
      countRunningThreads([
        makeThreadState({ session: makeSession({ status: "ready", orchestrationStatus: "idle" }) }),
        makeThreadState({
          session: makeSession({ status: "closed", orchestrationStatus: "stopped" }),
        }),
        makeThreadState({ latestTurn: makeLatestTurn("completed") }),
      ]),
    ).toBe(0);
  });

  it("publishes the initial running count through the desktop bridge", () => {
    const setRunningThreadsState = vi.fn().mockResolvedValue(undefined);
    getWindowForTest().desktopBridge = {
      setRunningThreadsState,
    } as unknown as DesktopBridge;

    const stop = startRunningThreadsStatePublisher();
    stop();

    expect(setRunningThreadsState).toHaveBeenCalledOnce();
    expect(setRunningThreadsState).toHaveBeenCalledWith({
      count: 0,
      updatedAt: expect.any(String),
    });
  });
});
