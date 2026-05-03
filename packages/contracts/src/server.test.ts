import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { HistorySyncProjectMappingPlan, HistorySyncStatus, ServerProvider } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });
});

describe("HistorySyncStatus", () => {
  it("decodes needs-initial-sync status", () => {
    const parsed = Schema.decodeUnknownSync(HistorySyncStatus)({
      state: "needs-initial-sync",
      configured: true,
      lastSyncedAt: null,
    });

    expect(parsed.state).toBe("needs-initial-sync");
  });

  it("decodes needs-project-mapping status", () => {
    const parsed = Schema.decodeUnknownSync(HistorySyncStatus)({
      state: "needs-project-mapping",
      configured: true,
      remoteMaxSequence: 42,
      unresolvedProjectCount: 2,
      lastSyncedAt: null,
    });

    expect(parsed.state).toBe("needs-project-mapping");
  });

  it("decodes syncing progress", () => {
    const parsed = Schema.decodeUnknownSync(HistorySyncStatus)({
      state: "syncing",
      configured: true,
      startedAt: "2026-05-03T18:00:00.000Z",
      lastSyncedAt: null,
      progress: {
        phase: "projecting",
        label: "Projecting threads",
        current: 42,
        total: 100,
      },
    });

    expect(parsed.state).toBe("syncing");
    if (parsed.state !== "syncing") {
      throw new Error("Expected syncing status.");
    }
    expect(parsed.progress?.phase).toBe("projecting");
  });
});

describe("HistorySyncProjectMappingPlan", () => {
  it("decodes mapping candidates and local projects", () => {
    const parsed = Schema.decodeUnknownSync(HistorySyncProjectMappingPlan)({
      syncId: "client:42",
      remoteMaxSequence: 42,
      candidates: [
        {
          remoteProjectId: "remote-project",
          remoteTitle: "Remote Project",
          remoteWorkspaceRoot: "/Users/me/project",
          threadCount: 3,
          suggestedLocalProjectId: "local-project",
          suggestedLocalWorkspaceRoot: "C:\\Dev\\project",
          suggestionReason: "basename",
          status: "unresolved",
        },
      ],
      localProjects: [
        {
          projectId: "local-project",
          title: "Local Project",
          workspaceRoot: "C:\\Dev\\project",
        },
      ],
    });

    expect(parsed.candidates[0]?.suggestionReason).toBe("basename");
    expect(parsed.localProjects[0]?.projectId).toBe("local-project");
  });
});
