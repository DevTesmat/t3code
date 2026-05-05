#!/usr/bin/env bun

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG_LINE_PATTERN = /^\[([^\]]+)]\s+([A-Z]+):\s+(.*)$/;
const SERVER_TRACE_PATTERN = /^server\.trace\.ndjson(?:\.\d+)?$/;
const PREVIEW_MAX_LENGTH = 160;

export interface InspectThreadLogsOptions {
  readonly logsDirectoryPath: string;
  readonly threadId: string;
  readonly json: boolean;
  readonly grep: string | undefined;
  readonly around: string | undefined;
  readonly context: number;
  readonly includeEmbedded: boolean;
  readonly includeServer: boolean;
}

export interface ParsedLogEvent {
  readonly filePath: string;
  readonly lineNumber: number;
  readonly timestamp: string;
  readonly stream: string;
  readonly event: unknown;
  readonly embedded: boolean;
  readonly rawLine: string;
}

interface CliParseResult {
  readonly options?: InspectThreadLogsOptions;
  readonly help?: boolean;
  readonly error?: string;
}

interface EventSummary {
  readonly eventId?: string;
  readonly type?: string;
  readonly method?: string;
  readonly turnId?: string;
  readonly itemId?: string;
  readonly itemType?: string;
  readonly title?: string;
  readonly detail?: string;
  readonly preview?: string;
}

function usage(): string {
  return [
    "Usage:",
    "  bun run logs:thread -- --logs <logs-dir> --thread <thread-id> [options]",
    "",
    "Options:",
    "  --logs <path>          T3 logs directory. Defaults to ~/.t3/userdata/logs.",
    "  --thread <id>          Canonical thread id to inspect. Required.",
    "  --json                 Emit machine-readable JSON lines.",
    "  --grep <text>          Filter parsed outer events by a case-insensitive text match.",
    "  --around <id>          Show events around an eventId, itemId, or turnId.",
    "  --context <n>          Number of neighboring events for --around. Defaults to 5.",
    "  --include-server       Also scan server.trace.ndjson rotated files by parsed thread fields.",
    "  --include-embedded     Also expose raw lines where the thread id appears only inside nested text.",
    "  --help                 Show this help.",
    "",
    "Default parsing only considers the outer JSON event after the log prefix, so copied",
    "log rows inside fields such as aggregatedOutput do not produce false thread matches.",
  ].join("\n");
}

function defaultLogsDirectoryPath(): string {
  return path.join(os.homedir(), ".t3", "userdata", "logs");
}

function parseArgs(argv: ReadonlyArray<string>): CliParseResult {
  let logsDirectoryPath = defaultLogsDirectoryPath();
  let threadId: string | undefined;
  let json = false;
  let grep: string | undefined;
  let around: string | undefined;
  let context = 5;
  let includeEmbedded = false;
  let includeServer = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        return { help: true };
      case "--logs":
        logsDirectoryPath = valueArg(argv, index, arg);
        index += 1;
        break;
      case "--thread":
        threadId = valueArg(argv, index, arg);
        index += 1;
        break;
      case "--json":
        json = true;
        break;
      case "--grep":
        grep = valueArg(argv, index, arg);
        index += 1;
        break;
      case "--around":
        around = valueArg(argv, index, arg);
        index += 1;
        break;
      case "--context": {
        const raw = valueArg(argv, index, arg);
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          return { error: `Invalid --context value: ${raw}` };
        }
        context = parsed;
        index += 1;
        break;
      }
      case "--include-embedded":
        includeEmbedded = true;
        break;
      case "--include-server":
        includeServer = true;
        break;
      default:
        return { error: `Unknown argument: ${arg}` };
    }
  }

  if (!threadId?.trim()) {
    return { error: "Missing required --thread <id>." };
  }

  return {
    options: {
      logsDirectoryPath,
      threadId: threadId.trim(),
      json,
      grep,
      around,
      context,
      includeEmbedded,
      includeServer,
    },
  };
}

function valueArg(argv: ReadonlyArray<string>, index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function safeReadDirectory(directoryPath: string): string[] {
  try {
    return fs.readdirSync(directoryPath);
  } catch {
    return [];
  }
}

function providerLogDirectory(logsDirectoryPath: string): string {
  return path.join(logsDirectoryPath, "provider");
}

function providerLogPattern(threadId: string): RegExp {
  return new RegExp(`^${escapeRegExp(threadId)}\\.log(?:\\.\\d+)?$`);
}

function findProviderLogFiles(input: {
  readonly logsDirectoryPath: string;
  readonly threadId: string;
  readonly includeEmbedded: boolean;
}): string[] {
  const directoryPath = providerLogDirectory(input.logsDirectoryPath);
  const names = safeReadDirectory(directoryPath);
  const exactPattern = providerLogPattern(input.threadId);
  return names
    .filter((name) =>
      input.includeEmbedded ? /\.log(?:\.\d+)?$/.test(name) : exactPattern.test(name),
    )
    .map((name) => path.join(directoryPath, name))
    .toSorted(compareLogFilePaths);
}

function findServerTraceFiles(logsDirectoryPath: string): string[] {
  return safeReadDirectory(logsDirectoryPath)
    .filter((name) => SERVER_TRACE_PATTERN.test(name))
    .map((name) => path.join(logsDirectoryPath, name))
    .toSorted(compareLogFilePaths);
}

function compareLogFilePaths(left: string, right: string): number {
  const baseCompare = baseLogName(left).localeCompare(baseLogName(right));
  if (baseCompare !== 0) {
    return baseCompare;
  }
  return rotationIndex(left) - rotationIndex(right);
}

function baseLogName(filePath: string): string {
  return path.basename(filePath).replace(/\.\d+$/, "");
}

function rotationIndex(filePath: string): number {
  const match = /\.(\d+)$/.exec(filePath);
  return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
}

function readLines(filePath: string): string[] {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

function parseProviderLine(
  filePath: string,
  line: string,
  lineNumber: number,
): ParsedLogEvent | null {
  const match = LOG_LINE_PATTERN.exec(line);
  if (!match) {
    return null;
  }
  const [, timestamp, stream, jsonText] = match;
  const event = parseJson(jsonText);
  if (event === undefined) {
    return null;
  }
  return {
    filePath,
    lineNumber,
    timestamp: timestamp ?? "",
    stream: stream ?? "",
    event,
    embedded: false,
    rawLine: line,
  };
}

function parseServerTraceLine(
  filePath: string,
  line: string,
  lineNumber: number,
): ParsedLogEvent | null {
  const event = parseJson(line);
  if (event === undefined) {
    return null;
  }
  const record = asRecord(event);
  const timestamp =
    asString(record?.createdAt) ??
    asString(record?.timestamp) ??
    asString(record?.time) ??
    asString(record?.date) ??
    "";
  return {
    filePath,
    lineNumber,
    timestamp,
    stream: "TRACE",
    event,
    embedded: false,
    rawLine: line,
  };
}

function parseJson(value: string | undefined): unknown {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function eventThreadId(event: unknown): string | undefined {
  const record = asRecord(event);
  const payload = asRecord(record?.payload);
  const raw = asRecord(record?.raw);
  const rawPayload = asRecord(raw?.payload);
  const rawPayloadThread = asRecord(rawPayload?.thread);
  const providerRefs = asRecord(record?.providerRefs);
  return (
    asString(record?.threadId) ??
    asString(payload?.threadId) ??
    asString(rawPayload?.threadId) ??
    asString(rawPayloadThread?.id) ??
    asString(providerRefs?.threadId)
  );
}

function eventMatchesThread(event: unknown, threadId: string): boolean {
  return eventThreadId(event) === threadId;
}

function eventSearchText(parsed: ParsedLogEvent): string {
  return JSON.stringify(parsed.event);
}

function createEmbeddedLineEvent(input: {
  readonly filePath: string;
  readonly line: string;
  readonly lineNumber: number;
}): ParsedLogEvent {
  return {
    filePath: input.filePath,
    lineNumber: input.lineNumber,
    timestamp: "",
    stream: "EMBED",
    event: { rawLine: input.line },
    embedded: true,
    rawLine: input.line,
  };
}

export function inspectThreadLogs(options: InspectThreadLogsOptions): ParsedLogEvent[] {
  const providerFiles = findProviderLogFiles(options);
  const serverFiles = options.includeServer ? findServerTraceFiles(options.logsDirectoryPath) : [];
  const events: ParsedLogEvent[] = [];
  const seen = new Set<string>();

  for (const filePath of providerFiles) {
    const lines = readLines(filePath);
    lines.forEach((line, index) => {
      if (!line) {
        return;
      }
      const parsed = parseProviderLine(filePath, line, index + 1);
      if (parsed && eventMatchesThread(parsed.event, options.threadId)) {
        addParsedEvent(events, seen, parsed);
        return;
      }
      if (options.includeEmbedded && line.includes(options.threadId)) {
        addParsedEvent(
          events,
          seen,
          createEmbeddedLineEvent({ filePath, line, lineNumber: index + 1 }),
        );
      }
    });
  }

  for (const filePath of serverFiles) {
    const lines = readLines(filePath);
    lines.forEach((line, index) => {
      if (!line) {
        return;
      }
      const parsed = parseServerTraceLine(filePath, line, index + 1);
      if (parsed && eventMatchesThread(parsed.event, options.threadId)) {
        addParsedEvent(events, seen, parsed);
      }
    });
  }

  const grepFiltered = filterByGrep(events, options.grep);
  const aroundFiltered = filterAround(grepFiltered, options.around, options.context);
  return aroundFiltered.toSorted(compareParsedEvents);
}

function addParsedEvent(events: ParsedLogEvent[], seen: Set<string>, event: ParsedLogEvent): void {
  const key = `${event.filePath}:${event.lineNumber}:${event.embedded ? "embedded" : "outer"}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  events.push(event);
}

function compareParsedEvents(left: ParsedLogEvent, right: ParsedLogEvent): number {
  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  const fileCompare = left.filePath.localeCompare(right.filePath);
  if (fileCompare !== 0) {
    return fileCompare;
  }
  return left.lineNumber - right.lineNumber;
}

function filterByGrep(events: ParsedLogEvent[], grep: string | undefined): ParsedLogEvent[] {
  const needle = grep?.trim().toLowerCase();
  if (!needle) {
    return events;
  }
  return events.filter((event) => eventSearchText(event).toLowerCase().includes(needle));
}

function filterAround(
  events: ParsedLogEvent[],
  around: string | undefined,
  context: number,
): ParsedLogEvent[] {
  const target = around?.trim();
  if (!target) {
    return events;
  }
  const index = events.findIndex((event) => eventMatchesIdentifier(event.event, target));
  if (index < 0) {
    return [];
  }
  return events.slice(Math.max(0, index - context), index + context + 1);
}

function eventMatchesIdentifier(event: unknown, target: string): boolean {
  const summary = summarizeEvent(event);
  return summary.eventId === target || summary.itemId === target || summary.turnId === target;
}

function summarizeEvent(event: unknown): EventSummary {
  const record = asRecord(event);
  const payload = asRecord(record?.payload);
  const payloadData = asRecord(payload?.data);
  const item = asRecord(payload?.item) ?? asRecord(payloadData?.item);
  const raw = asRecord(record?.raw);
  const rawPayload = asRecord(raw?.payload);
  const rawItem = asRecord(rawPayload?.item);
  const data = payloadData;
  const outputPreview = asRecord(data?.outputPreview);
  const outputLines = Array.isArray(outputPreview?.lines)
    ? outputPreview.lines.filter((line): line is string => typeof line === "string")
    : [];
  const rawOutput = asRecord(data?.rawOutput);
  const outputPreviewText = outputLines.join("\\n");
  const preview =
    asString(payload?.delta) ??
    asString(record?.textDelta) ??
    asString(data?.command) ??
    asString(data?.prompt) ??
    asString(outputPreviewText) ??
    asString(rawOutput?.stdout) ??
    asString(rawOutput?.stderr) ??
    asString(rawItem?.aggregatedOutput) ??
    asString(rawItem?.text);
  const summary: EventSummary = {};
  setIfDefined(summary, "eventId", asString(record?.eventId) ?? asString(record?.id));
  setIfDefined(summary, "type", asString(record?.type));
  setIfDefined(summary, "method", asString(record?.method) ?? asString(raw?.method));
  setIfDefined(summary, "turnId", asString(record?.turnId) ?? asString(rawPayload?.turnId));
  setIfDefined(summary, "itemId", asString(record?.itemId) ?? asString(rawPayload?.itemId));
  setIfDefined(
    summary,
    "itemType",
    asString(payload?.itemType) ?? asString(item?.type) ?? asString(rawItem?.type),
  );
  setIfDefined(
    summary,
    "title",
    asString(payload?.title) ?? asString(item?.title) ?? asString(rawItem?.title),
  );
  setIfDefined(summary, "detail", asString(payload?.detail) ?? asString(data?.detail));
  setIfDefined(
    summary,
    "preview",
    preview ? truncate(preview.replace(/\s+/g, " "), PREVIEW_MAX_LENGTH) : undefined,
  );
  return summary;
}

function setIfDefined<Key extends keyof EventSummary>(
  summary: EventSummary,
  key: Key,
  value: EventSummary[Key] | undefined,
): void {
  if (value !== undefined) {
    summary[key] = value;
  }
}

export function formatTimeline(events: ReadonlyArray<ParsedLogEvent>): string {
  if (events.length === 0) {
    return "No matching thread log events found.";
  }

  return events.map(formatTimelineEvent).join("\n");
}

function formatTimelineEvent(event: ParsedLogEvent): string {
  const summary = summarizeEvent(event.event);
  const location = `${path.relative(process.cwd(), event.filePath)}:${event.lineNumber}`;
  const parts = [
    event.timestamp || "no-time",
    event.stream,
    event.embedded ? "embedded" : (summary.type ?? summary.method ?? "event"),
    summary.method && summary.type ? `method=${summary.method}` : undefined,
    summary.eventId ? `event=${summary.eventId}` : undefined,
    summary.turnId ? `turn=${summary.turnId}` : undefined,
    summary.itemId ? `item=${summary.itemId}` : undefined,
    summary.itemType ? `itemType=${summary.itemType}` : undefined,
    summary.title ? `title=${quote(summary.title)}` : undefined,
    summary.detail ? `detail=${quote(truncate(summary.detail, PREVIEW_MAX_LENGTH))}` : undefined,
    summary.preview ? `preview=${quote(summary.preview)}` : undefined,
    `at=${location}`,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.join(" | ");
}

export function formatJsonLines(events: ReadonlyArray<ParsedLogEvent>): string {
  return events
    .map((event) =>
      JSON.stringify({
        filePath: event.filePath,
        lineNumber: event.lineNumber,
        timestamp: event.timestamp,
        stream: event.stream,
        embedded: event.embedded,
        summary: summarizeEvent(event.event),
        event: event.event,
      }),
    )
    .join("\n");
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runCli(): void {
  let parsed: CliParseResult;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  if (parsed.help) {
    console.log(usage());
    return;
  }
  if (parsed.error || !parsed.options) {
    console.error(parsed.error ?? "Invalid arguments.");
    console.error("");
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const events = inspectThreadLogs(parsed.options);
  const output = parsed.options.json ? formatJsonLines(events) : formatTimeline(events);
  if (output.length > 0) {
    console.log(output);
  }
}

if (import.meta.main) {
  runCli();
}
