import * as Crypto from "node:crypto";
import * as Path from "node:path";

import {
  HistorySyncConfigError,
  type HistorySyncProjectMappingAction,
  type HistorySyncProjectMappingCandidate,
  type HistorySyncProjectMappingLocalProject,
  type HistorySyncProjectMappingPlan,
  ProjectId,
} from "@t3tools/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { ensureClientId } from "./localRepository.ts";
import {
  collectProjectCandidates,
  type HistorySyncEventRow,
  type HistorySyncProjectMappingRow,
  type ProjectCandidate,
} from "./planner.ts";

export interface LocalProjectRow {
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function describeSyncFailure(error: unknown): string {
  const wrappedCause =
    typeof error === "object" && error !== null && "cause" in error
      ? (error as { readonly cause?: unknown }).cause
      : undefined;
  return describeUnknownError(wrappedCause ?? error) || "History sync failed.";
}

export function readProjectMappings(sql: SqlClient.SqlClient) {
  return sql<HistorySyncProjectMappingRow>`
    SELECT
      remote_project_id AS "remoteProjectId",
      local_project_id AS "localProjectId",
      local_workspace_root AS "localWorkspaceRoot",
      remote_workspace_root AS "remoteWorkspaceRoot",
      remote_title AS "remoteTitle",
      status,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM history_sync_project_mappings
    ORDER BY remote_project_id ASC
  `;
}

export function readLocalProjects(sql: SqlClient.SqlClient) {
  return sql<LocalProjectRow>`
    SELECT
      project_id AS "projectId",
      title,
      workspace_root AS "workspaceRoot"
    FROM projection_projects
    WHERE deleted_at IS NULL
    ORDER BY created_at ASC, project_id ASC
  `;
}

export function writeProjectMapping(
  sql: SqlClient.SqlClient,
  input: {
    readonly remoteProjectId: string;
    readonly localProjectId: string;
    readonly localWorkspaceRoot: string;
    readonly remoteWorkspaceRoot: string;
    readonly remoteTitle: string;
    readonly status: "mapped" | "skipped";
    readonly now: string;
  },
) {
  return sql`
    INSERT INTO history_sync_project_mappings (
      remote_project_id,
      local_project_id,
      local_workspace_root,
      remote_workspace_root,
      remote_title,
      status,
      created_at,
      updated_at
    )
    VALUES (
      ${input.remoteProjectId},
      ${input.localProjectId},
      ${input.localWorkspaceRoot},
      ${input.remoteWorkspaceRoot},
      ${input.remoteTitle},
      ${input.status},
      ${input.now},
      ${input.now}
    )
    ON CONFLICT (remote_project_id) DO UPDATE SET
      local_project_id = excluded.local_project_id,
      local_workspace_root = excluded.local_workspace_root,
      remote_workspace_root = excluded.remote_workspace_root,
      remote_title = excluded.remote_title,
      status = excluded.status,
      updated_at = excluded.updated_at
  `.pipe(
    Effect.asVoid,
    Effect.mapError(
      (cause) =>
        new HistorySyncConfigError({
          message: describeSyncFailure(cause),
        }),
    ),
  );
}

export function getSyncId(sql: SqlClient.SqlClient, remoteMaxSequence: number) {
  return ensureClientId(sql).pipe(Effect.map((clientId) => `${clientId}:${remoteMaxSequence}`));
}

export function findProjectMappingSuggestion(
  remoteProject: ProjectCandidate,
  localProjects: readonly LocalProjectRow[],
): {
  readonly project: LocalProjectRow;
  readonly reason: "exact-path" | "basename";
} | null {
  const exact = localProjects.find(
    (project) => project.workspaceRoot === remoteProject.workspaceRoot,
  );
  if (exact) return { project: exact, reason: "exact-path" };

  const remoteBasename = Path.basename(remoteProject.workspaceRoot.replace(/\\/g, "/"));
  const basenameMatches = localProjects.filter(
    (project) => Path.basename(project.workspaceRoot.replace(/\\/g, "/")) === remoteBasename,
  );
  if (basenameMatches.length === 1 && basenameMatches[0]) {
    return { project: basenameMatches[0], reason: "basename" };
  }

  return null;
}

export const buildProjectMappingPlanFromEvents = Effect.fn(
  "HistorySync.buildProjectMappingPlanFromEvents",
)(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly remoteEvents: readonly HistorySyncEventRow[];
    readonly remoteMaxSequence: number;
  },
) {
  const [mappings, localProjects, syncId] = yield* Effect.all([
    readProjectMappings(sql),
    readLocalProjects(sql),
    getSyncId(sql, input.remoteMaxSequence),
  ]);
  const mappingByRemote = new Map(mappings.map((mapping) => [mapping.remoteProjectId, mapping]));
  const activeRemoteProjects = collectProjectCandidates(input.remoteEvents).filter(
    (project) => project.threadCount > 0,
  );
  const candidates: HistorySyncProjectMappingCandidate[] = [];

  for (const remoteProject of activeRemoteProjects) {
    const saved = mappingByRemote.get(remoteProject.projectId);
    if (saved) {
      candidates.push({
        remoteProjectId: ProjectId.make(remoteProject.projectId),
        remoteTitle: remoteProject.title,
        remoteWorkspaceRoot: remoteProject.workspaceRoot,
        threadCount: remoteProject.threadCount,
        suggestedLocalProjectId: ProjectId.make(saved.localProjectId),
        suggestedLocalWorkspaceRoot: saved.localWorkspaceRoot,
        status: "mapped",
      });
      continue;
    }

    const suggestion = findProjectMappingSuggestion(remoteProject, localProjects);
    candidates.push({
      remoteProjectId: ProjectId.make(remoteProject.projectId),
      remoteTitle: remoteProject.title,
      remoteWorkspaceRoot: remoteProject.workspaceRoot,
      threadCount: remoteProject.threadCount,
      ...(suggestion
        ? {
            suggestedLocalProjectId: ProjectId.make(suggestion.project.projectId),
            suggestedLocalWorkspaceRoot: suggestion.project.workspaceRoot,
            suggestionReason: suggestion.reason,
          }
        : {}),
      status: suggestion?.reason === "exact-path" ? "mapped" : "unresolved",
    });
  }

  return {
    syncId,
    remoteMaxSequence: input.remoteMaxSequence,
    candidates,
    localProjects: localProjects.map(
      (project): HistorySyncProjectMappingLocalProject => ({
        projectId: ProjectId.make(project.projectId),
        title: project.title,
        workspaceRoot: project.workspaceRoot,
      }),
    ),
  } satisfies HistorySyncProjectMappingPlan;
});

export const autoPersistExactProjectMappings = Effect.fn(
  "HistorySync.autoPersistExactProjectMappings",
)(function* (sql: SqlClient.SqlClient, plan: HistorySyncProjectMappingPlan) {
  const now = new Date().toISOString();
  yield* Effect.forEach(
    plan.candidates,
    (candidate) => {
      if (
        candidate.status !== "mapped" ||
        candidate.suggestionReason !== "exact-path" ||
        !candidate.suggestedLocalProjectId ||
        !candidate.suggestedLocalWorkspaceRoot
      ) {
        return Effect.void;
      }
      return writeProjectMapping(sql, {
        remoteProjectId: candidate.remoteProjectId,
        localProjectId: candidate.suggestedLocalProjectId,
        localWorkspaceRoot: candidate.suggestedLocalWorkspaceRoot,
        remoteWorkspaceRoot: candidate.remoteWorkspaceRoot,
        remoteTitle: candidate.remoteTitle,
        status: "mapped",
        now,
      });
    },
    { concurrency: 1 },
  );
});

export function applyMappingAction(
  sql: SqlClient.SqlClient,
  input: {
    readonly action: HistorySyncProjectMappingAction;
    readonly remoteProject: ProjectCandidate;
    readonly localProjects: readonly LocalProjectRow[];
    readonly now: string;
  },
) {
  const action = input.action;
  if (action.action === "skip") {
    return writeProjectMapping(sql, {
      remoteProjectId: input.remoteProject.projectId,
      localProjectId: input.remoteProject.projectId,
      localWorkspaceRoot: input.remoteProject.workspaceRoot,
      remoteWorkspaceRoot: input.remoteProject.workspaceRoot,
      remoteTitle: input.remoteProject.title,
      status: "skipped",
      now: input.now,
    });
  }
  if (action.action === "map-existing") {
    const localProject = input.localProjects.find(
      (project) => project.projectId === action.localProjectId,
    );
    if (!localProject) {
      return Effect.fail(
        new HistorySyncConfigError({
          message: `Unknown local project '${action.localProjectId}'.`,
        }),
      );
    }
    return writeProjectMapping(sql, {
      remoteProjectId: input.remoteProject.projectId,
      localProjectId: localProject.projectId,
      localWorkspaceRoot: localProject.workspaceRoot,
      remoteWorkspaceRoot: input.remoteProject.workspaceRoot,
      remoteTitle: input.remoteProject.title,
      status: "mapped",
      now: input.now,
    });
  }
  const localProjectId = Crypto.randomUUID();
  return writeProjectMapping(sql, {
    remoteProjectId: input.remoteProject.projectId,
    localProjectId,
    localWorkspaceRoot: action.workspaceRoot,
    remoteWorkspaceRoot: input.remoteProject.workspaceRoot,
    remoteTitle: action.title ?? input.remoteProject.title,
    status: "mapped",
    now: input.now,
  });
}

export function applyMappingActions(
  sql: SqlClient.SqlClient,
  input: {
    readonly actions: readonly HistorySyncProjectMappingAction[];
    readonly remoteEvents: readonly HistorySyncEventRow[];
    readonly now: string;
  },
) {
  return Effect.gen(function* () {
    const remoteProjectById = new Map(
      collectProjectCandidates(input.remoteEvents).map((project) => [project.projectId, project]),
    );
    const localProjects = yield* readLocalProjects(sql);
    yield* Effect.forEach(
      input.actions,
      (action) => {
        const remoteProject = remoteProjectById.get(action.remoteProjectId);
        if (!remoteProject) {
          return Effect.fail(
            new HistorySyncConfigError({
              message: `Unknown remote project '${action.remoteProjectId}'.`,
            }),
          );
        }
        return applyMappingAction(sql, { action, remoteProject, localProjects, now: input.now });
      },
      { concurrency: 1 },
    );
  });
}
