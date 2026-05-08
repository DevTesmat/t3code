import { describe, expect, it } from "vitest";

import {
  formatPerformanceLoadResults,
  getPerformanceLoadScenarios,
  parsePerformanceLoadOptions,
  runPerformanceLoadScenarios,
} from "./performance-load-scenarios.ts";

describe("performance load scenarios", () => {
  it("defines the audit-required load scenarios", () => {
    expect(getPerformanceLoadScenarios().map((scenario) => scenario.name)).toEqual([
      "long-provider-stream",
      "terminal-output-flood",
      "many-active-sessions",
      "reconnecting-websocket-clients",
      "large-thread-timeline-diff",
    ]);
  });

  it("parses scenario and enforcement options", () => {
    expect(
      parsePerformanceLoadOptions([
        "--scenario",
        "reconnecting-websocket-clients",
        "--json",
        "--enforce",
      ]),
    ).toEqual({
      scenario: "reconnecting-websocket-clients",
      json: true,
      enforce: true,
    });
  });

  it("runs a selected scenario and returns stable workload counters", () => {
    const [result] = runPerformanceLoadScenarios({ scenario: "reconnecting-websocket-clients" });

    expect(result?.name).toBe("reconnecting-websocket-clients");
    expect(result?.stats.operations).toBe(3_000);
    expect(result?.stats.details.coalescedSnapshotLoads).toBe(4);
    expect(result?.stats.checksum).toBeGreaterThan(0);
  });

  it("formats human-readable results", () => {
    const results = runPerformanceLoadScenarios({ scenario: "terminal-output-flood" });
    const formatted = formatPerformanceLoadResults(results);

    expect(formatted).toContain("terminal-output-flood");
    expect(formatted).toContain("operations=");
    expect(formatted).toContain("checksum=");
  });
});
