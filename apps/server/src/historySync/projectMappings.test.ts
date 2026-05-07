import { describe, expect, test } from "vitest";

import type { ProjectCandidate } from "./planner.ts";
import { findProjectMappingSuggestion, type LocalProjectRow } from "./projectMappings.ts";

function remoteProject(workspaceRoot: string): ProjectCandidate {
  return {
    projectId: "remote-project",
    title: "Remote project",
    workspaceRoot,
    deleted: false,
    threadCount: 1,
  };
}

const localProjects: readonly LocalProjectRow[] = [
  {
    projectId: "local-exact",
    title: "Exact",
    workspaceRoot: "/Users/me/work/app",
  },
  {
    projectId: "local-other",
    title: "Other",
    workspaceRoot: "/Users/me/other/api",
  },
];

describe("history sync project mappings", () => {
  test("prefers exact workspace-root suggestions", () => {
    expect(
      findProjectMappingSuggestion(remoteProject("/Users/me/work/app"), localProjects),
    ).toEqual({
      project: localProjects[0],
      reason: "exact-path",
    });
  });

  test("suggests unique workspace basename matches without exact path", () => {
    expect(
      findProjectMappingSuggestion(remoteProject("/Volumes/remote/api"), localProjects),
    ).toEqual({
      project: localProjects[1],
      reason: "basename",
    });
  });

  test("does not suggest ambiguous basename matches", () => {
    expect(
      findProjectMappingSuggestion(remoteProject("/Volumes/remote/app"), [
        ...localProjects,
        {
          projectId: "local-duplicate",
          title: "Duplicate",
          workspaceRoot: "/tmp/app",
        },
      ]),
    ).toBeNull();
  });
});
