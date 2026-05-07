import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  formatTimeline,
  inspectThreadLogs,
  type InspectThreadLogsOptions,
} from "./inspect-thread-logs.ts";

const THREAD_A = "thread-a";
const THREAD_B = "thread-b";

let tempDirectoryPath: string;

beforeEach(() => {
  tempDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "t3-thread-logs-"));
  fs.mkdirSync(path.join(tempDirectoryPath, "provider"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tempDirectoryPath, { recursive: true, force: true });
});

describe("inspectThreadLogs", () => {
  it("parses only outer provider events by default", () => {
    writeProviderLog(THREAD_A, [
      providerLine({
        timestamp: "2026-05-05T18:54:28.174Z",
        stream: "CANON",
        event: {
          eventId: "outer-a",
          threadId: THREAD_A,
          type: "item.completed",
          turnId: "turn-a",
          itemId: "call-a",
          payload: {
            itemType: "command_execution",
            detail: "rg thread-b logs",
            data: {
              item: {
                type: "commandExecution",
                aggregatedOutput: providerLine({
                  timestamp: "2026-05-05T18:48:07.187Z",
                  stream: "CANON",
                  event: {
                    eventId: "embedded-b",
                    threadId: THREAD_B,
                    type: "thread.started",
                    payload: {},
                  },
                }),
              },
            },
          },
        },
      }),
    ]);

    const events = inspectThreadLogs(options({ threadId: THREAD_A }));

    expect(events).toHaveLength(1);
    expect(events[0]?.embedded).toBe(false);
    expect(formatTimeline(events)).toContain("outer-a");
    expect(formatTimeline(events)).not.toContain("embedded-b");
  });

  it("does not match embedded copied rows for another thread unless requested", () => {
    writeProviderLog(THREAD_A, [
      providerLine({
        timestamp: "2026-05-05T18:54:28.174Z",
        stream: "CANON",
        event: {
          eventId: "outer-a",
          threadId: THREAD_A,
          type: "item.completed",
          payload: {
            data: {
              rawOutput: {
                stdout: providerLine({
                  timestamp: "2026-05-05T18:48:07.187Z",
                  stream: "CANON",
                  event: {
                    eventId: "embedded-b",
                    threadId: THREAD_B,
                    type: "thread.started",
                    payload: {},
                  },
                }),
              },
            },
          },
        },
      }),
    ]);

    expect(inspectThreadLogs(options({ threadId: THREAD_B }))).toEqual([]);

    const withEmbedded = inspectThreadLogs(options({ threadId: THREAD_B, includeEmbedded: true }));
    expect(withEmbedded).toHaveLength(1);
    expect(withEmbedded[0]?.embedded).toBe(true);
    expect(formatTimeline(withEmbedded)).toContain("embedded");
  });

  it("supports grep and around filtering on parsed outer events", () => {
    writeProviderLog(THREAD_A, [
      providerLine({
        timestamp: "2026-05-05T18:54:28.000Z",
        stream: "CANON",
        event: { eventId: "one", threadId: THREAD_A, type: "turn.started", turnId: "turn-a" },
      }),
      providerLine({
        timestamp: "2026-05-05T18:54:29.000Z",
        stream: "CANON",
        event: {
          eventId: "two",
          threadId: THREAD_A,
          type: "item.completed",
          turnId: "turn-a",
          itemId: "item-two",
          payload: { itemType: "command_execution", detail: "bun lint" },
        },
      }),
      providerLine({
        timestamp: "2026-05-05T18:54:30.000Z",
        stream: "CANON",
        event: { eventId: "three", threadId: THREAD_A, type: "turn.completed", turnId: "turn-a" },
      }),
    ]);

    expect(inspectThreadLogs(options({ threadId: THREAD_A, grep: "bun lint" }))).toHaveLength(1);
    expect(
      inspectThreadLogs(options({ threadId: THREAD_A, around: "item-two", context: 1 })).map(
        (event) => JSON.parse(event.rawLine.replace(/^\[[^\]]+]\s+[A-Z]+:\s+/, "")).eventId,
      ),
    ).toEqual(["one", "two", "three"]);
  });

  it("can include parsed server trace records", () => {
    fs.writeFileSync(
      path.join(tempDirectoryPath, "server.trace.ndjson"),
      `${JSON.stringify({ createdAt: "2026-05-05T18:54:31.000Z", threadId: THREAD_A, type: "trace" })}\n`,
    );

    const events = inspectThreadLogs(options({ threadId: THREAD_A, includeServer: true }));

    expect(events).toHaveLength(1);
    expect(events[0]?.stream).toBe("TRACE");
  });
});

function options(overrides: Partial<InspectThreadLogsOptions>): InspectThreadLogsOptions {
  return {
    logsDirectoryPath: tempDirectoryPath,
    threadId: THREAD_A,
    json: false,
    grep: undefined,
    around: undefined,
    context: 5,
    includeEmbedded: false,
    includeServer: false,
    ...overrides,
  };
}

function writeProviderLog(threadId: string, lines: ReadonlyArray<string>): void {
  fs.writeFileSync(
    path.join(tempDirectoryPath, "provider", `${threadId}.log`),
    `${lines.join("\n")}\n`,
  );
}

function providerLine(input: {
  readonly timestamp: string;
  readonly stream: string;
  readonly event: unknown;
}): string {
  return `[${input.timestamp}] ${input.stream}: ${JSON.stringify(input.event)}`;
}
