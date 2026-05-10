import type { ToolLifecycleItemType } from "@t3tools/contracts";

export type ToolActivityGroupKind = "exploration" | "validation" | "other";
export type ToolActivitySafetyKind = "verified-read-only" | "mutating" | "unknown";
export type ToolActivitySafetySource =
  | "file-change"
  | "command-actions"
  | "request-kind"
  | "changed-files"
  | "heuristic";

export interface ToolActivitySafetyVerdict {
  readonly kind: ToolActivitySafetyKind;
  readonly source: ToolActivitySafetySource;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeCommandValue(value: unknown): string | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== undefined);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function stripTrailingExitCode(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code \d+>)\s*$/iu.exec(trimmed);
  const output = match?.groups?.output?.trim() ?? trimmed;
  return output.length > 0 ? output : undefined;
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  const backtickMatch = /`([^`]+)`/u.exec(title);
  return backtickMatch?.[1]?.trim() || undefined;
}

function extractToolCommand(data: Record<string, unknown> | undefined, title: string | undefined) {
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const rawInput = asRecord(data?.rawInput);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
    normalizeCommandValue(rawInput?.command),
  ];
  const direct = candidates.find((candidate) => candidate !== undefined);
  if (direct) {
    return direct;
  }
  const executable = asTrimmedString(rawInput?.executable);
  const args = normalizeCommandValue(rawInput?.args);
  if (executable && args) {
    return `${executable} ${args}`;
  }
  if (executable) {
    return executable;
  }
  return extractCommandFromTitle(title);
}

function maybePathLike(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.startsWith(".") ||
    /\.(?:[a-z0-9]{1,12})$/iu.test(value)
  ) {
    return value;
  }
  return undefined;
}

function collectPaths(value: unknown, paths: string[], seen: Set<string>, depth: number): void {
  if (depth > 4 || paths.length >= 8) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPaths(entry, paths, seen, depth + 1);
      if (paths.length >= 8) {
        return;
      }
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  for (const key of ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"]) {
    const candidate = maybePathLike(asTrimmedString(record[key]));
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    paths.push(candidate);
    if (paths.length >= 8) {
      return;
    }
  }
  for (const nestedKey of ["locations", "item", "input", "result", "rawInput", "data", "changes"]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectPaths(record[nestedKey], paths, seen, depth + 1);
    if (paths.length >= 8) {
      return;
    }
  }
}

function extractPrimaryPath(data: Record<string, unknown> | undefined): string | undefined {
  const paths: string[] = [];
  collectPaths(data, paths, new Set<string>(), 0);
  return paths[0];
}

function normalizeEquivalentValue(value: string | undefined): string | undefined {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/\s+/gu, " ")
    .replace(/\s+(?:complete|completed|started)\s*$/iu, "")
    .trim();
}

function isEquivalent(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeEquivalentValue(left)?.toLowerCase();
  const normalizedRight = normalizeEquivalentValue(right)?.toLowerCase();
  return normalizedLeft !== undefined && normalizedLeft === normalizedRight;
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      current += char;
      quote = char;
      continue;
    }

    const isTwoCharSeparator = (char === "&" && next === "&") || (char === "|" && next === "|");
    if (isTwoCharSeparator) {
      const trimmed = current.trim();
      if (trimmed) {
        segments.push(trimmed);
      }
      current = "";
      index += 1;
      continue;
    }

    if (char === "|" || char === ";") {
      const trimmed = current.trim();
      if (trimmed) {
        segments.push(trimmed);
      }
      current = "";
      continue;
    }

    current += char;
  }

  const trimmed = current.trim();
  if (trimmed) {
    segments.push(trimmed);
  }
  return segments;
}

function tokenizeCommandSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (const char of segment) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function commandBasename(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\\/gu, "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  return basename.length > 0 ? basename : undefined;
}

function hasShellWriteRedirection(segment: string): boolean {
  return /(^|[^<=])>{1,2}(?![&=])/u.test(segment);
}

function stripLeadingAssignments(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? "")) {
    index += 1;
  }
  return tokens.slice(index);
}

function shellInnerCommand(tokens: readonly string[]): string | undefined {
  const command = commandBasename(tokens[0]);
  if (command !== "sh" && command !== "bash" && command !== "zsh") {
    return undefined;
  }

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (token === "--") {
      continue;
    }
    if (!token.startsWith("-")) {
      return undefined;
    }
    if (token.slice(1).includes("c")) {
      return tokens[index + 1];
    }
  }

  return undefined;
}

function expandShellWrappedSegments(segments: readonly string[]): string[] {
  return segments.flatMap((segment) => {
    const tokens = stripLeadingAssignments(tokenizeCommandSegment(segment));
    const innerCommand = shellInnerCommand(tokens);
    return innerCommand ? splitShellSegments(innerCommand) : [segment];
  });
}

function isValidationCommandSegment(segment: string): boolean {
  const tokens = stripLeadingAssignments(tokenizeCommandSegment(segment));
  const command = commandBasename(tokens[0]);
  if (!command) {
    return false;
  }

  const normalized = tokens.map((token) => token.toLowerCase());
  const joined = normalized.join(" ");
  if (
    command === "vitest" ||
    command === "pytest" ||
    (command === "go" && normalized[1] === "test") ||
    (command === "cargo" && normalized[1] === "test")
  ) {
    return true;
  }

  const packageManagers = new Set(["bun", "npm", "pnpm", "yarn"]);
  if (packageManagers.has(command)) {
    return /\b(?:test|vitest|lint|typecheck|tsc|build|check)\b/u.test(joined);
  }

  if (new Set(["tsc", "make", "just"]).has(command)) {
    return /\b(?:test|lint|typecheck|build|check)\b/u.test(joined);
  }

  return false;
}

function gitSubcommand(tokens: string[]): string | undefined {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (token === "-C" || token === "-c") {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return token.toLowerCase();
  }
  return undefined;
}

function isReadOnlyExplorationSegment(segment: string): boolean {
  if (hasShellWriteRedirection(segment)) {
    return false;
  }

  const tokens = stripLeadingAssignments(tokenizeCommandSegment(segment));
  const normalizedTokens = normalizeShellControlTokens(tokens);
  const command = commandBasename(normalizedTokens[0]);
  if (!command) {
    return isReadOnlyShellNoop(tokens);
  }

  if (isReadOnlyShellNoop(normalizedTokens)) {
    return true;
  }

  if (command === "if") {
    return isReadOnlyShellCondition(normalizedTokens.slice(1));
  }

  if (command === "for") {
    return normalizedTokens.some((token) => token.toLowerCase() === "in");
  }

  if (command === "sed") {
    return !normalizedTokens.some((token) => token === "-i" || token.startsWith("-i"));
  }

  if (command === "find") {
    return !normalizedTokens.some((token) =>
      ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(token.toLowerCase()),
    );
  }

  if (command === "git") {
    return new Set(["diff", "show", "status", "log", "grep", "ls-files"]).has(
      gitSubcommand(normalizedTokens) ?? "",
    );
  }

  if (command === "sort") {
    return !normalizedTokens.some((token) => token === "-o" || token.startsWith("--output"));
  }

  if (command === "xargs") {
    return isReadOnlyXargsSegment(normalizedTokens);
  }

  if (command === "node") {
    return isReadOnlyNodeInspectionSegment(normalizedTokens, segment);
  }

  return new Set([
    "[",
    "test",
    "rg",
    "grep",
    "fd",
    "ls",
    "tree",
    "pwd",
    "cat",
    "awk",
    "head",
    "tail",
    "wc",
    "sort",
    "tr",
    "printf",
  ]).has(command);
}

function normalizeShellControlTokens(tokens: readonly string[]): string[] {
  let normalized = [...tokens];
  while (normalized.length > 0) {
    const first = normalized[0]?.toLowerCase();
    if (first === "then" || first === "do") {
      normalized = normalized.slice(1);
      continue;
    }
    if (first === "if") {
      const thenIndex = normalized.findIndex((token) => token.toLowerCase() === "then");
      if (thenIndex >= 0) {
        normalized = normalized.slice(thenIndex + 1);
        continue;
      }
    }
    break;
  }
  return normalized;
}

function isReadOnlyShellNoop(tokens: readonly string[]): boolean {
  const joined = tokens.join(" ").trim().toLowerCase();
  if (!joined) {
    return false;
  }
  return joined === "fi" || joined === "done" || joined === "else";
}

function isReadOnlyShellCondition(tokens: readonly string[]): boolean {
  const command = commandBasename(tokens[0]);
  return command === "[" || command === "test";
}

function isReadOnlyXargsSegment(tokens: readonly string[]): boolean {
  const shellIndex = tokens.findIndex((token) => {
    const command = commandBasename(token);
    return command === "sh" || command === "bash" || command === "zsh";
  });
  if (shellIndex >= 0) {
    const innerCommand = shellInnerCommand(tokens.slice(shellIndex));
    return innerCommand ? classifyCommandActivity(innerCommand) === "exploration" : false;
  }

  const commandIndex = tokens.findIndex((token, index) => {
    if (index === 0) {
      return false;
    }
    if (!token || token === "--") {
      return false;
    }
    if (token === "-I" || token === "-P" || token === "-n" || token === "-L" || token === "-s") {
      return false;
    }
    const previous = tokens[index - 1];
    if (
      previous === "-I" ||
      previous === "-P" ||
      previous === "-n" ||
      previous === "-L" ||
      previous === "-s"
    ) {
      return false;
    }
    return !token.startsWith("-");
  });

  if (commandIndex < 0) {
    return false;
  }
  return isReadOnlyExplorationSegment(tokens.slice(commandIndex).join(" "));
}

function isReadOnlyNodeInspectionSegment(tokens: readonly string[], segment: string): boolean {
  if (
    !tokens.some((token) => token === "-e" || token === "--eval" || token === "-") &&
    !segment.includes("<<")
  ) {
    return false;
  }

  const lowered = segment.toLowerCase();
  return !/\b(?:writefile(?:sync)?|appendfile(?:sync)?|rm(?:sync)?|rmdir(?:sync)?|mkdir(?:sync)?|unlink(?:sync)?|rename(?:sync)?|copyfile(?:sync)?|cp(?:sync)?|createwritestream|exec(?:file)?(?:sync)?|spawn(?:sync)?|fork)\b/u.test(
    lowered,
  );
}

function classifyCommandActivity(command: string): ToolActivityGroupKind {
  if (command.includes("<<") && isReadOnlyExplorationSegment(command)) {
    return "exploration";
  }

  const segments = expandShellWrappedSegments(splitShellSegments(command));
  if (segments.length === 0) {
    return "other";
  }
  if (segments.some(isValidationCommandSegment)) {
    return "validation";
  }
  return segments.every(isReadOnlyExplorationSegment) ? "exploration" : "other";
}

const readOnlyCommandActionTypes = new Set(["read", "listfiles", "search"]);

function normalizeCommandActionType(value: unknown): string | undefined {
  if (typeof value === "string") {
    return asTrimmedString(value)?.toLowerCase();
  }
  const record = asRecord(value);
  return asTrimmedString(record?.type)?.toLowerCase();
}

export function deriveToolActivitySafety(input: {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly changedFiles?: ReadonlyArray<string> | null | undefined;
  readonly requestKind?: "command" | "file-read" | "file-change" | null | undefined;
  readonly commandActionTypes?: ReadonlyArray<string> | null | undefined;
}): ToolActivitySafetyVerdict | undefined {
  if (input.itemType === "file_change") {
    return { kind: "mutating", source: "file-change" };
  }
  if (input.requestKind === "file-change") {
    return { kind: "mutating", source: "request-kind" };
  }
  if ((input.changedFiles?.length ?? 0) > 0) {
    return { kind: "mutating", source: "changed-files" };
  }

  const commandActionTypes = input.commandActionTypes
    ?.map((actionType) => normalizeCommandActionType(actionType))
    .filter((actionType): actionType is string => actionType !== undefined);
  if (commandActionTypes !== undefined && commandActionTypes.length > 0) {
    return commandActionTypes.every((actionType) => readOnlyCommandActionTypes.has(actionType))
      ? { kind: "verified-read-only", source: "command-actions" }
      : { kind: "unknown", source: "command-actions" };
  }

  return undefined;
}

export interface ToolActivityGroupClassificationInput {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | null | undefined;
  readonly label?: string | null | undefined;
  readonly command?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly changedFiles?: ReadonlyArray<string> | null | undefined;
  readonly requestKind?: "command" | "file-read" | "file-change" | null | undefined;
  readonly commandActionTypes?: ReadonlyArray<string> | null | undefined;
  readonly safety?: ToolActivitySafetyVerdict | null | undefined;
}

export function classifyToolActivityGroup(
  input: ToolActivityGroupClassificationInput,
): ToolActivityGroupKind {
  const safety =
    input.safety ??
    deriveToolActivitySafety({
      itemType: input.itemType,
      changedFiles: input.changedFiles,
      requestKind: input.requestKind,
      commandActionTypes: input.commandActionTypes,
    });
  if (safety?.kind === "mutating") {
    return "other";
  }
  if (safety?.kind === "verified-read-only") {
    return "exploration";
  }

  const command = asTrimmedString(input.command ?? undefined);
  if (command) {
    return classifyCommandActivity(command);
  }

  if (input.itemType === "command_execution") {
    return "other";
  }

  if (input.itemType === "web_search") {
    return "other";
  }

  const normalizedLabel = normalizeEquivalentValue(
    asTrimmedString(input.title ?? undefined) ?? asTrimmedString(input.label ?? undefined),
  )?.toLowerCase();

  if (
    input.requestKind === "file-read" ||
    normalizedLabel === "read file" ||
    normalizedLabel === "searched files" ||
    normalizedLabel === "find" ||
    normalizedLabel === "grep"
  ) {
    return "exploration";
  }

  return "other";
}

function classifyToolAction(input: {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
}): "command" | "read" | "file_change" | "search" | "other" {
  const itemType = input.itemType ?? undefined;
  const kind = asTrimmedString(input.data?.kind)?.toLowerCase();
  const title = asTrimmedString(input.title)?.toLowerCase();
  if (itemType === "command_execution" || kind === "execute" || title === "terminal") {
    return "command";
  }
  if (kind === "read" || title === "read file") {
    return "read";
  }
  if (
    itemType === "file_change" ||
    kind === "edit" ||
    kind === "move" ||
    kind === "delete" ||
    kind === "write"
  ) {
    return "file_change";
  }
  if (itemType === "web_search" || kind === "search" || title === "find" || title === "grep") {
    return "search";
  }
  return "other";
}

export interface ToolActivityPresentationInput {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly data?: unknown;
  readonly fallbackSummary?: string | null | undefined;
}

export interface ToolActivityPresentation {
  readonly summary: string;
  readonly detail?: string | undefined;
}

export function deriveToolActivityPresentation(
  input: ToolActivityPresentationInput,
): ToolActivityPresentation {
  const title = asTrimmedString(input.title);
  const detail = stripTrailingExitCode(asTrimmedString(input.detail));
  const fallbackSummary = asTrimmedString(input.fallbackSummary) ?? "Tool";
  const data = asRecord(input.data);
  const command = extractToolCommand(data, title);
  const primaryPath = extractPrimaryPath(data);
  const action = classifyToolAction({
    itemType: input.itemType,
    title,
    data,
  });

  if (action === "command") {
    return {
      summary: "Ran command",
      ...(command ? { detail: command } : {}),
    };
  }

  if (action === "read") {
    if (primaryPath) {
      return {
        summary: "Read file",
        detail: primaryPath,
      };
    }
    return {
      summary: "Read file",
    };
  }

  if (action === "file_change") {
    return {
      summary: "Changed files",
      ...(primaryPath ? { detail: primaryPath } : {}),
    };
  }

  if (action === "search") {
    const query =
      asTrimmedString(asRecord(data?.rawInput)?.query) ??
      asTrimmedString(asRecord(data?.rawInput)?.pattern) ??
      asTrimmedString(asRecord(data?.rawInput)?.searchTerm);
    return {
      summary: "Searched files",
      ...(query ? { detail: query } : {}),
    };
  }

  if (detail && !isEquivalent(detail, title) && !isEquivalent(detail, fallbackSummary)) {
    return {
      summary: title ?? fallbackSummary,
      detail,
    };
  }

  return {
    summary: title ?? fallbackSummary,
  };
}
