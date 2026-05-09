import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, test } from "vitest";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import type {
  HistorySyncEventRow,
  HistorySyncProjectMappingRow,
  ProjectCandidate,
} from "./planner.ts";
import {
  buildProjectMappingPlanFromEvents,
  filterValidProjectMappings,
  findProjectMappingSuggestion,
  getSyncId,
  readValidProjectMappings,
  writeProjectMapping,
  type LocalProjectRow,
} from "./projectMappings.ts";

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

const baseEvent = {
  occurredAt: "2026-05-01T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  actorKind: "system",
  metadataJson: "{}",
} as const;

function event(
  sequence: number,
  streamId: string,
  eventType: HistorySyncEventRow["eventType"],
  payload: Record<string, unknown>,
): HistorySyncEventRow {
  return {
    ...baseEvent,
    sequence,
    eventId: `${streamId}:${sequence}`,
    aggregateKind: eventType.startsWith("project.") ? "project" : "thread",
    streamId,
    streamVersion: sequence,
    eventType,
    payloadJson: JSON.stringify(payload),
  };
}

function projectCreated(sequence: number, projectId: string, workspaceRoot: string) {
  return event(sequence, projectId, "project.created", {
    projectId,
    title: projectId,
    workspaceRoot,
  });
}

function threadCreated(sequence: number, threadId: string, projectId: string) {
  return event(sequence, threadId, "thread.created", {
    threadId,
    projectId,
    title: threadId,
  });
}

function mapping(input: Partial<HistorySyncProjectMappingRow> = {}): HistorySyncProjectMappingRow {
  return {
    remoteProjectId: "remote-project",
    localProjectId: "local-exact",
    localWorkspaceRoot: "/Users/me/work/app",
    remoteWorkspaceRoot: "/remote/app",
    remoteTitle: "Remote",
    status: "mapped",
    createdAt: baseEvent.occurredAt,
    updatedAt: baseEvent.occurredAt,
    ...input,
  };
}

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

  test("keeps confirmed mappings durable even when local projections drift", () => {
    expect(
      filterValidProjectMappings(
        [
          mapping(),
          mapping({ remoteProjectId: "missing", localProjectId: "missing-local" }),
          mapping({ remoteProjectId: "changed", localWorkspaceRoot: "/old/root" }),
          mapping({
            remoteProjectId: "skipped",
            status: "skipped",
            localProjectId: "remote-skipped",
            localWorkspaceRoot: "/remote/skipped",
          }),
        ],
        localProjects,
      ).map((row) => row.remoteProjectId),
    ).toEqual(["remote-project", "missing", "changed", "skipped"]);
  });
});

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

function insertLocalProject(
  sql: SqlClient.SqlClient,
  input: {
    readonly projectId: string;
    readonly workspaceRoot: string;
    readonly deletedAt?: string | null;
  },
) {
  return sql`
    INSERT INTO projection_projects (
      project_id,
      title,
      workspace_root,
      scripts_json,
      created_at,
      updated_at,
      deleted_at
    )
    VALUES (
      ${input.projectId},
      ${input.projectId},
      ${input.workspaceRoot},
      '{}',
      ${baseEvent.occurredAt},
      ${baseEvent.occurredAt},
      ${input.deletedAt ?? null}
    )
  `;
}

layer("history sync project mapping repository", (it) => {
  it.effect("reads durable confirmed mappings even when projection rows are deleted", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* insertLocalProject(sql, {
        projectId: "local-valid",
        workspaceRoot: "/local/valid",
      });
      yield* insertLocalProject(sql, {
        projectId: "local-deleted",
        workspaceRoot: "/local/deleted",
        deletedAt: baseEvent.occurredAt,
      });
      yield* writeProjectMapping(sql, {
        remoteProjectId: "remote-valid",
        localProjectId: "local-valid",
        localWorkspaceRoot: "/local/valid",
        remoteWorkspaceRoot: "/remote/valid",
        remoteTitle: "Remote valid",
        status: "mapped",
        now: baseEvent.occurredAt,
      });
      yield* writeProjectMapping(sql, {
        remoteProjectId: "remote-deleted",
        localProjectId: "local-deleted",
        localWorkspaceRoot: "/local/deleted",
        remoteWorkspaceRoot: "/remote/deleted",
        remoteTitle: "Remote deleted",
        status: "mapped",
        now: baseEvent.occurredAt,
      });
      yield* writeProjectMapping(sql, {
        remoteProjectId: "remote-skipped",
        localProjectId: "remote-skipped",
        localWorkspaceRoot: "/remote/skipped",
        remoteWorkspaceRoot: "/remote/skipped",
        remoteTitle: "Remote skipped",
        status: "skipped",
        now: baseEvent.occurredAt,
      });

      assert.deepStrictEqual(
        (yield* readValidProjectMappings(sql)).map((row) => row.remoteProjectId),
        ["remote-deleted", "remote-skipped", "remote-valid"],
      );
    }),
  );

  it.effect("keeps saved mappings and leaves exact path matches as confirmation suggestions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* insertLocalProject(sql, {
        projectId: "local-new",
        workspaceRoot: "/remote/app",
      });
      yield* writeProjectMapping(sql, {
        remoteProjectId: "remote-project",
        localProjectId: "local-old",
        localWorkspaceRoot: "/old/app",
        remoteWorkspaceRoot: "/remote/app",
        remoteTitle: "Remote project",
        status: "mapped",
        now: baseEvent.occurredAt,
      });

      const plan = yield* buildProjectMappingPlanFromEvents(sql, {
        remoteEvents: [
          projectCreated(1, "remote-project", "/remote/app"),
          threadCreated(2, "thread-a", "remote-project"),
        ],
        remoteMaxSequence: 2,
      });

      assert.strictEqual(plan.candidates[0]?.suggestedLocalProjectId, "local-old");
      assert.strictEqual(plan.candidates[0]?.status, "mapped");
    }),
  );

  it.effect("keeps basename suggestions unresolved and does not auto-persist them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* insertLocalProject(sql, {
        projectId: "local-api",
        workspaceRoot: "/Users/me/api",
      });

      const plan = yield* buildProjectMappingPlanFromEvents(sql, {
        remoteEvents: [
          projectCreated(1, "remote-api", "/Volumes/remote/api"),
          threadCreated(2, "thread-api", "remote-api"),
        ],
        remoteMaxSequence: 2,
      });

      assert.strictEqual(plan.candidates[0]?.suggestedLocalProjectId, "local-api");
      assert.strictEqual(plan.candidates[0]?.suggestionReason, "basename");
      assert.strictEqual(plan.candidates[0]?.status, "unresolved");
      assert.strictEqual(
        (yield* readValidProjectMappings(sql)).some((row) => row.remoteProjectId === "remote-api"),
        false,
      );
    }),
  );

  it.effect("invalidates mapping apply sync id when local projects drift", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* insertLocalProject(sql, {
        projectId: "local-a",
        workspaceRoot: "/local/a",
      });
      const before = yield* getSyncId(sql, 7);
      yield* sql`
        UPDATE projection_projects
        SET workspace_root = '/local/renamed'
        WHERE project_id = 'local-a'
      `;
      const after = yield* getSyncId(sql, 7);

      assert.notStrictEqual(after, before);
    }),
  );
});
