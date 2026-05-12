import { Effect, Layer, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { OrchestrationReadModel } from "@t3tools/contracts";
import { emptyWorkerHealthSnapshot } from "@t3tools/shared/WorkerHealth";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { ProjectSetupScriptRunner } from "../Services/ProjectSetupScriptRunner.ts";
import { ProjectSetupScriptRunnerLive } from "./ProjectSetupScriptRunner.ts";

const emptySnapshot = (
  scripts: OrchestrationReadModel["projects"][number]["scripts"],
): OrchestrationReadModel =>
  ({
    snapshotSequence: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    projects: [
      {
        id: "project-1",
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModelSelection: null,
        scripts,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      },
    ],
    threads: [],
    providerSessions: [],
    providerStatuses: [],
    pendingApprovals: [],
    latestTurnByThreadId: {},
  }) as unknown as OrchestrationReadModel;

const makeProjectionSnapshotQuery = (snapshot: OrchestrationReadModel) => ({
  getProjectShellById: (projectId: OrchestrationReadModel["projects"][number]["id"]) => {
    const project = snapshot.projects.find((entry) => entry.id === projectId) ?? null;
    return Effect.succeed(
      project === null
        ? Option.none()
        : Option.some({
            id: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
            repositoryIdentity: project.repositoryIdentity ?? null,
            defaultModelSelection: project.defaultModelSelection,
            scripts: project.scripts,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          }),
    );
  },
  getActiveProjectByWorkspaceRoot: (workspaceRoot: string) => {
    const project =
      snapshot.projects.find((entry) => entry.workspaceRoot === workspaceRoot) ?? null;
    return Effect.succeed(project === null ? Option.none() : Option.some(project));
  },
});

describe("ProjectSetupScriptRunner", () => {
  it("returns no-script when no setup script exists", async () => {
    const open = vi.fn();
    const write = vi.fn();
    const runner = await Effect.runPromise(
      Effect.service(ProjectSetupScriptRunner).pipe(
        Effect.provide(
          ProjectSetupScriptRunnerLive.pipe(
            Layer.provideMerge(
              Layer.mock(ProjectionSnapshotQuery)(makeProjectionSnapshotQuery(emptySnapshot([]))),
            ),
            Layer.provideMerge(
              Layer.succeed(TerminalManager, {
                open,
                write,
                resize: () => Effect.void,
                clear: () => Effect.void,
                restart: () => Effect.die(new Error("unused")),
                close: () => Effect.void,
                subscribe: () => Effect.succeed(() => undefined),
                historyPersistenceHealth: Effect.succeed(emptyWorkerHealthSnapshot()),
              }),
            ),
          ),
        ),
      ),
    );

    const result = await Effect.runPromise(
      runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      }),
    );

    expect(result).toEqual({ status: "no-script" });
    expect(open).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("opens the deterministic setup terminal with worktree env and writes the command", async () => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const write = vi.fn(() => Effect.void);
    const runner = await Effect.runPromise(
      Effect.service(ProjectSetupScriptRunner).pipe(
        Effect.provide(
          ProjectSetupScriptRunnerLive.pipe(
            Layer.provideMerge(
              Layer.mock(ProjectionSnapshotQuery)(
                makeProjectionSnapshotQuery(
                  emptySnapshot([
                    {
                      id: "setup",
                      name: "Setup",
                      command: "bun install",
                      icon: "configure",
                      runOnWorktreeCreate: true,
                    },
                  ]),
                ),
              ),
            ),
            Layer.provideMerge(
              Layer.succeed(TerminalManager, {
                open,
                write,
                resize: () => Effect.void,
                clear: () => Effect.void,
                restart: () => Effect.die(new Error("unused")),
                close: () => Effect.void,
                subscribe: () => Effect.succeed(() => undefined),
                historyPersistenceHealth: Effect.succeed(emptyWorkerHealthSnapshot()),
              }),
            ),
          ),
        ),
      ),
    );

    const result = await Effect.runPromise(
      runner.runForThread({
        threadId: "thread-1",
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
      }),
    );

    expect(result).toEqual({
      status: "started",
      scriptId: "setup",
      scriptName: "Setup",
      terminalId: "setup-setup",
      cwd: "/repo/worktrees/a",
    });
    expect(open).toHaveBeenCalledWith({
      threadId: "thread-1",
      terminalId: "setup-setup",
      cwd: "/repo/worktrees/a",
      worktreePath: "/repo/worktrees/a",
      env: {
        T3CODE_PROJECT_ROOT: "/repo/project",
        T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
      },
    });
    expect(write).toHaveBeenCalledWith({
      threadId: "thread-1",
      terminalId: "setup-setup",
      data: "bun install\r",
    });
  });
});
