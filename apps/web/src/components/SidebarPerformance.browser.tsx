import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  getSidebarThreadIdsToPrewarm,
  getVisibleSidebarThreadIds,
  getVisibleThreadsForProject,
  sortProjectsForSidebar,
} from "./Sidebar.logic";

describe("Sidebar browser performance scenarios", () => {
  it("keeps large sidebar project/thread derivation within budget", () => {
    const environmentId = EnvironmentId.make("environment-local");
    const projects = Array.from({ length: 400 }, (_, index) => ({
      id: ProjectId.make(`project-${index}`),
      name: `Project ${String(index).padStart(3, "0")}`,
      createdAt: `2026-04-${String((index % 28) + 1).padStart(2, "0")}T10:00:00.000Z`,
      updatedAt: `2026-05-${String((index % 8) + 1).padStart(2, "0")}T10:00:00.000Z`,
    }));
    const threads = Array.from({ length: 8_000 }, (_, index) => {
      const project = projects[index % projects.length]!;
      return {
        id: ThreadId.make(`thread-${index}`),
        environmentId,
        projectId: project.id,
        createdAt: `2026-04-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
        updatedAt: `2026-05-${String((index % 8) + 1).padStart(2, "0")}T12:00:00.000Z`,
        latestUserMessageAt: `2026-05-${String((index % 8) + 1).padStart(2, "0")}T12:01:00.000Z`,
        pinnedAt: index % 97 === 0 ? "2026-05-08T12:00:00.000Z" : null,
      };
    });

    const startedAt = performance.now();
    const sortedProjects = sortProjectsForSidebar(projects, threads, "updated_at");
    const visibleProjects = sortedProjects.slice(0, 40).map((project) => {
      const projectThreads = threads.filter((thread) => thread.projectId === project.id);
      const visible = getVisibleThreadsForProject({
        threads: projectThreads,
        activeThreadId: projectThreads.at(-1)?.id,
        visibleUnpinnedLimit: 6,
      });
      return {
        shouldShowThreadPanel: true,
        renderedThreadIds: visible.visibleThreads.map((thread) => thread.id),
      };
    });
    const visibleThreadIds = getVisibleSidebarThreadIds(visibleProjects);
    const prewarmedThreadIds = getSidebarThreadIdsToPrewarm(visibleThreadIds);
    const durationMs = performance.now() - startedAt;

    expect(sortedProjects).toHaveLength(projects.length);
    expect(visibleThreadIds.length).toBeGreaterThan(0);
    expect(prewarmedThreadIds).toHaveLength(10);
    expect(
      durationMs,
      `large sidebar derivation exceeded browser perf budget: ${durationMs.toFixed(1)}ms`,
    ).toBeLessThan(500);
  });
});
