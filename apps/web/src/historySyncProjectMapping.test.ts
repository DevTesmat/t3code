import { describe, expect, it } from "vitest";

import {
  buildHistorySyncProjectMappingActions,
  draftFromPlanCandidate,
} from "./historySyncProjectMapping";
import { ProjectId, type HistorySyncProjectMappingPlan } from "@t3tools/contracts";

const basePlan: HistorySyncProjectMappingPlan = {
  syncId: "client:10",
  remoteMaxSequence: 10,
  localProjects: [
    {
      projectId: ProjectId.make("local-project"),
      title: "Local",
      workspaceRoot: "C:\\Dev\\Project",
    },
  ],
  candidates: [
    {
      remoteProjectId: ProjectId.make("remote-project"),
      remoteTitle: "Remote",
      remoteWorkspaceRoot: "/Users/me/Project",
      threadCount: 2,
      suggestedLocalProjectId: ProjectId.make("local-project"),
      suggestedLocalWorkspaceRoot: "C:\\Dev\\Project",
      suggestionReason: "basename",
      status: "unresolved",
    },
  ],
};

describe("history sync project mapping wizard logic", () => {
  it("defaults suggested candidates to existing-project mapping", () => {
    expect(draftFromPlanCandidate(basePlan.candidates[0]!)).toEqual({
      action: "map-existing",
      localProjectId: "local-project",
    });
  });

  it("builds map-folder actions for selected folders", () => {
    expect(
      buildHistorySyncProjectMappingActions(basePlan, {
        "remote-project": {
          action: "map-folder",
          workspaceRoot: " C:\\Dev\\Project ",
          title: " ",
        },
      }),
    ).toEqual([
      {
        remoteProjectId: "remote-project",
        action: "map-folder",
        workspaceRoot: "C:\\Dev\\Project",
        title: "Remote",
      },
    ]);
  });

  it("throws when a folder mapping has no folder", () => {
    expect(() =>
      buildHistorySyncProjectMappingActions(basePlan, {
        "remote-project": { action: "map-folder", workspaceRoot: "", title: "" },
      }),
    ).toThrow("Choose a local folder for Remote.");
  });
});
