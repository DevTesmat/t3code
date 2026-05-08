#!/usr/bin/env bun

import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

export type PerformanceLoadScenarioName =
  | "long-provider-stream"
  | "terminal-output-flood"
  | "many-active-sessions"
  | "reconnecting-websocket-clients"
  | "large-thread-timeline-diff";

export interface PerformanceLoadScenarioDefinition {
  readonly name: PerformanceLoadScenarioName;
  readonly description: string;
  readonly budget: {
    readonly maxDurationMs: number;
    readonly maxHeapDeltaMb: number;
  };
  readonly run: () => PerformanceLoadScenarioStats;
}

export interface PerformanceLoadScenarioStats {
  readonly operations: number;
  readonly checksum: number;
  readonly details: Record<string, number>;
}

export interface PerformanceLoadScenarioResult {
  readonly name: PerformanceLoadScenarioName;
  readonly description: string;
  readonly durationMs: number;
  readonly heapDeltaMb: number;
  readonly budget: PerformanceLoadScenarioDefinition["budget"];
  readonly passed: boolean;
  readonly stats: PerformanceLoadScenarioStats;
}

export interface PerformanceLoadOptions {
  readonly scenario: PerformanceLoadScenarioName | "all";
  readonly json: boolean;
  readonly enforce: boolean;
}

const mb = 1024 * 1024;

function updateChecksum(current: number, value: string | number): number {
  const input = typeof value === "number" ? String(value) : value;
  let next = current;
  for (let index = 0; index < input.length; index += 1) {
    next = (next * 31 + input.charCodeAt(index)) >>> 0;
  }
  return next;
}

function runLongProviderStream(): PerformanceLoadScenarioStats {
  const eventCount = 50_000;
  let checksum = 0;
  let assistantChars = 0;
  let progressEvents = 0;
  let itemCompletions = 0;

  for (let index = 0; index < eventCount; index += 1) {
    const turnId = Math.floor(index / 2_500);
    if (index % 2_500 === 0) {
      checksum = updateChecksum(checksum, `turn.started:${turnId}`);
    } else if (index % 2_500 === 2_499) {
      itemCompletions += 1;
      checksum = updateChecksum(checksum, `turn.completed:${turnId}`);
    } else if (index % 25 === 0) {
      progressEvents += 1;
      checksum = updateChecksum(checksum, index);
    } else {
      const delta = `delta-${turnId}-${index % 97}`;
      assistantChars += delta.length;
      checksum = updateChecksum(checksum, delta);
    }
  }

  return {
    operations: eventCount,
    checksum,
    details: {
      assistantChars,
      progressEvents,
      itemCompletions,
    },
  };
}

function runTerminalOutputFlood(): PerformanceLoadScenarioStats {
  const chunkCount = 12_000;
  const retainedLineLimit = 2_000;
  const retainedLines: string[] = [];
  let checksum = 0;
  let bytesSeen = 0;
  let droppedLines = 0;

  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = `line-${String(index).padStart(5, "0")} ${"x".repeat(180)}\n`;
    bytesSeen += chunk.length;
    const line = chunk.slice(0, -1);
    retainedLines.push(line);
    checksum = updateChecksum(checksum, line);
    if (retainedLines.length > retainedLineLimit) {
      retainedLines.shift();
      droppedLines += 1;
    }
  }

  return {
    operations: chunkCount,
    checksum,
    details: {
      bytesSeen,
      retainedLines: retainedLines.length,
      droppedLines,
    },
  };
}

function runManyActiveSessions(): PerformanceLoadScenarioStats {
  const sessionCount = 2_000;
  const turnsPerSession = 12;
  const sessions = new Map<
    string,
    {
      activeTurnId: string | null;
      completedTurns: number;
      lastSequence: number;
    }
  >();
  let checksum = 0;

  for (let index = 0; index < sessionCount; index += 1) {
    sessions.set(`thread-${index}`, {
      activeTurnId: null,
      completedTurns: 0,
      lastSequence: 0,
    });
  }

  for (let turn = 0; turn < turnsPerSession; turn += 1) {
    for (const [threadId, session] of sessions) {
      const activeTurnId = `${threadId}:turn-${turn}`;
      session.activeTurnId = activeTurnId;
      session.lastSequence += 1;
      checksum = updateChecksum(checksum, activeTurnId);
      session.completedTurns += 1;
      session.activeTurnId = null;
      session.lastSequence += 1;
    }
  }

  return {
    operations: sessionCount * turnsPerSession * 2,
    checksum,
    details: {
      sessionCount,
      totalCompletedTurns: [...sessions.values()].reduce(
        (total, session) => total + session.completedTurns,
        0,
      ),
      maxSequence: Math.max(...[...sessions.values()].map((session) => session.lastSequence)),
    },
  };
}

function runReconnectingWebSocketClients(): PerformanceLoadScenarioStats {
  const clientCount = 750;
  const subscriptionsPerClient = 4;
  const sharedSnapshotKeys = ["shell", "thread:alpha", "thread:beta", "thread:gamma"] as const;
  const inFlightByKey = new Map<string, number>();
  let loadCount = 0;
  let checksum = 0;

  for (let client = 0; client < clientCount; client += 1) {
    for (let subscription = 0; subscription < subscriptionsPerClient; subscription += 1) {
      const key = sharedSnapshotKeys[subscription % sharedSnapshotKeys.length] ?? "shell";
      if (!inFlightByKey.has(key)) {
        loadCount += 1;
        inFlightByKey.set(key, loadCount);
      }
      checksum = updateChecksum(checksum, `${client}:${key}:${inFlightByKey.get(key)}`);
    }
  }

  return {
    operations: clientCount * subscriptionsPerClient,
    checksum,
    details: {
      clientCount,
      subscriptions: clientCount * subscriptionsPerClient,
      coalescedSnapshotLoads: loadCount,
    },
  };
}

function runLargeThreadTimelineAndDiff(): PerformanceLoadScenarioStats {
  const messageCount = 4_000;
  const activityCount = 8_000;
  const diffHunkCount = 1_200;
  let checksum = 0;
  let visibleTimelineEntries = 0;
  let changedFiles = 0;

  for (let index = 0; index < messageCount; index += 1) {
    const role = index % 3 === 0 ? "user" : "assistant";
    checksum = updateChecksum(checksum, `${role}:message-${index}`);
    if (index >= messageCount - 80) {
      visibleTimelineEntries += 1;
    }
  }

  for (let index = 0; index < activityCount; index += 1) {
    checksum = updateChecksum(checksum, `activity:${index % 17}:${index}`);
    if (index >= activityCount - 160) {
      visibleTimelineEntries += 1;
    }
  }

  for (let index = 0; index < diffHunkCount; index += 1) {
    const fileIndex = index % 240;
    if (index < 240) {
      changedFiles += 1;
    }
    checksum = updateChecksum(checksum, `file-${fileIndex}.ts:+${index % 23}-${index % 11}`);
  }

  return {
    operations: messageCount + activityCount + diffHunkCount,
    checksum,
    details: {
      messageCount,
      activityCount,
      diffHunkCount,
      changedFiles,
      visibleTimelineEntries,
    },
  };
}

export function getPerformanceLoadScenarios(): ReadonlyArray<PerformanceLoadScenarioDefinition> {
  return [
    {
      name: "long-provider-stream",
      description: "High-volume provider runtime event stream with lifecycle and delta events.",
      budget: { maxDurationMs: 1_500, maxHeapDeltaMb: 96 },
      run: runLongProviderStream,
    },
    {
      name: "terminal-output-flood",
      description: "Large terminal output stream with retained transcript trimming.",
      budget: { maxDurationMs: 1_500, maxHeapDeltaMb: 96 },
      run: runTerminalOutputFlood,
    },
    {
      name: "many-active-sessions",
      description: "Many active thread sessions receiving turn lifecycle updates.",
      budget: { maxDurationMs: 1_500, maxHeapDeltaMb: 96 },
      run: runManyActiveSessions,
    },
    {
      name: "reconnecting-websocket-clients",
      description: "Many reconnecting clients sharing shell and thread snapshot reloads.",
      budget: { maxDurationMs: 1_500, maxHeapDeltaMb: 96 },
      run: runReconnectingWebSocketClients,
    },
    {
      name: "large-thread-timeline-diff",
      description: "Large thread timeline and diff summary workload.",
      budget: { maxDurationMs: 1_500, maxHeapDeltaMb: 128 },
      run: runLargeThreadTimelineAndDiff,
    },
  ];
}

export function parsePerformanceLoadOptions(argv: ReadonlyArray<string>): PerformanceLoadOptions {
  let scenario: PerformanceLoadOptions["scenario"] = "all";
  let json = false;
  let enforce = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--enforce") {
      enforce = true;
      continue;
    }
    if (arg === "--scenario") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--scenario requires a value");
      }
      scenario = parseScenarioName(value);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--scenario=")) {
      scenario = parseScenarioName(arg.slice("--scenario=".length));
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new Error(helpText());
    }
    throw new Error(`Unknown option: ${arg}\n\n${helpText()}`);
  }

  return { scenario, json, enforce };
}

function parseScenarioName(value: string): PerformanceLoadOptions["scenario"] {
  if (value === "all") return value;
  const scenario = getPerformanceLoadScenarios().find((candidate) => candidate.name === value);
  if (!scenario) {
    throw new Error(`Unknown scenario: ${value}\n\n${helpText()}`);
  }
  return scenario.name;
}

export function runPerformanceLoadScenario(
  scenario: PerformanceLoadScenarioDefinition,
): PerformanceLoadScenarioResult {
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const stats = scenario.run();
  const durationMs = performance.now() - startedAt;
  const heapAfter = process.memoryUsage().heapUsed;
  const heapDeltaMb = Math.max(0, heapAfter - heapBefore) / mb;

  return {
    name: scenario.name,
    description: scenario.description,
    durationMs,
    heapDeltaMb,
    budget: scenario.budget,
    passed:
      durationMs <= scenario.budget.maxDurationMs && heapDeltaMb <= scenario.budget.maxHeapDeltaMb,
    stats,
  };
}

export function runPerformanceLoadScenarios(
  options: Pick<PerformanceLoadOptions, "scenario">,
): ReadonlyArray<PerformanceLoadScenarioResult> {
  const scenarios = getPerformanceLoadScenarios().filter(
    (scenario) => options.scenario === "all" || scenario.name === options.scenario,
  );
  return scenarios.map(runPerformanceLoadScenario);
}

export function formatPerformanceLoadResults(
  results: ReadonlyArray<PerformanceLoadScenarioResult>,
): string {
  const lines = ["Performance load scenarios:"];
  for (const result of results) {
    const status = result.passed ? "PASS" : "FAIL";
    lines.push(
      `${status} ${result.name}: ${result.durationMs.toFixed(1)}ms / ${
        result.budget.maxDurationMs
      }ms, ${result.heapDeltaMb.toFixed(2)}MB / ${result.budget.maxHeapDeltaMb}MB heap`,
    );
    lines.push(`  ${result.description}`);
    lines.push(
      `  operations=${result.stats.operations} checksum=${result.stats.checksum} details=${JSON.stringify(
        result.stats.details,
      )}`,
    );
  }
  return lines.join("\n");
}

function helpText(): string {
  const scenarios = getPerformanceLoadScenarios()
    .map((scenario) => `  - ${scenario.name}`)
    .join("\n");
  return [
    "Usage: bun scripts/performance-load-scenarios.ts [--scenario <name|all>] [--json] [--enforce]",
    "",
    "Scenarios:",
    scenarios,
  ].join("\n");
}

async function main(): Promise<void> {
  let options: PerformanceLoadOptions;
  try {
    options = parsePerformanceLoadOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const results = runPerformanceLoadScenarios(options);
  if (options.json) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    console.log(formatPerformanceLoadResults(results));
  }

  if (options.enforce && results.some((result) => !result.passed)) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
