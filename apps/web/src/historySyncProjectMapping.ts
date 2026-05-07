import {
  type HistorySyncProjectMappingAction,
  type HistorySyncProjectMappingPlan,
  ProjectId,
} from "@t3tools/contracts";

export type HistorySyncMappingDraft =
  | { readonly action: "map-existing"; readonly localProjectId: string }
  | { readonly action: "map-folder"; readonly workspaceRoot: string; readonly title: string }
  | { readonly action: "skip" };

export function draftFromPlanCandidate(
  candidate: HistorySyncProjectMappingPlan["candidates"][number],
): HistorySyncMappingDraft {
  if (candidate.suggestedLocalProjectId) {
    return { action: "map-existing", localProjectId: candidate.suggestedLocalProjectId };
  }
  return {
    action: "map-folder",
    workspaceRoot: "",
    title: candidate.remoteTitle,
  };
}

export function buildHistorySyncProjectMappingActions(
  plan: HistorySyncProjectMappingPlan,
  draftsByRemoteProjectId: Readonly<Record<string, HistorySyncMappingDraft>>,
): HistorySyncProjectMappingAction[] {
  return plan.candidates
    .filter((candidate) => candidate.status === "unresolved")
    .map((candidate) => {
      const draft = draftsByRemoteProjectId[candidate.remoteProjectId];
      if (!draft) {
        return { remoteProjectId: candidate.remoteProjectId, action: "skip" as const };
      }
      if (draft.action === "map-existing") {
        return {
          remoteProjectId: candidate.remoteProjectId,
          action: "map-existing" as const,
          localProjectId: ProjectId.make(draft.localProjectId),
        };
      }
      if (draft.action === "skip") {
        return { remoteProjectId: candidate.remoteProjectId, action: "skip" as const };
      }
      if (!draft.workspaceRoot.trim()) {
        throw new Error(`Choose a local folder for ${candidate.remoteTitle}.`);
      }
      return {
        remoteProjectId: candidate.remoteProjectId,
        action: "map-folder" as const,
        workspaceRoot: draft.workspaceRoot.trim(),
        title: draft.title.trim() || candidate.remoteTitle,
      };
    });
}
