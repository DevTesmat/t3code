#!/usr/bin/env bun

import { spawn, type ChildProcess } from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs/promises";
import * as Net from "node:net";
import * as Path from "node:path";
import process from "node:process";

import {
  CommandId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
  type ClientOrchestrationCommand,
  type ModelSelection,
  type OrchestrationThreadStreamItem,
  type ProviderOptionSelection,
  type ServerConfig,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

const BASE_SERVER_PORT = 13773;
const BASE_WEB_PORT = 5733;
const BENCH_ROOT = Path.resolve(".t3-bench");
const DEFAULT_TIMEOUT_MS = 120_000;
const RPC_TIMEOUT_MS = 20_000;
const NOOP = () => undefined;

const SCENARIOS = {
  "exact-test-reply": {
    prompt: "Reply exactly with: TEST",
    title: "Benchmark TEST",
    validate: (text: string) => {
      const normalized = text.trim();
      if (normalized !== "TEST") {
        throw new Error(`Expected assistant reply 'TEST', received '${normalized}'.`);
      }
    },
  },
  "fixed-output": {
    prompt:
      "Reply with exactly 200 repetitions of the word BENCH separated by a single space. Do not include any other text.",
    title: "Benchmark fixed output",
    validate: (text: string) => {
      const words = text.trim().split(/\s+/).filter(Boolean);
      const invalid = words.find((word) => word !== "BENCH");
      if (words.length < 100 || invalid) {
        throw new Error(
          `Expected at least 100 BENCH tokens and no other text, received ${words.length}${invalid ? ` with invalid token '${invalid}'` : ""}.`,
        );
      }
    },
  },
} as const;

type BenchmarkScenario = keyof typeof SCENARIOS;

interface BenchmarkBootstrap {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bootstrapToken: string;
}

interface BenchmarkResult {
  readonly runId: string;
  readonly batchId: string;
  readonly runIndex: number;
  readonly runCount: number;
  readonly scenario: string;
  readonly startedAt: string;
  readonly turnStartedAt: string | null;
  readonly completedAt: string;
  readonly success: boolean;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly modelOptions: ReadonlyArray<ProviderOptionSelection>;
  readonly serverReadyMs: number;
  readonly desktopReadyMs: number;
  readonly threadCreateMs: number;
  readonly turnWallClockMs: number;
  readonly timeToFirstAssistantEventMs: number | null;
  readonly timeToFinalAssistantEventMs: number | null;
  readonly timeToFirstAssistantFromTurnMs: number | null;
  readonly timeToFinalAssistantFromTurnMs: number | null;
  readonly tokenUsage: BenchmarkTokenUsage | null;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningOutputTokens: number | null;
  readonly totalTokens: number | null;
  readonly outputTokensPerSecond: number | null;
  readonly finalAssistantText: string;
  readonly error?: string;
}

interface BenchmarkOptions {
  readonly scenario: BenchmarkScenario;
  readonly providerInstanceId?: string;
  readonly model?: string;
  readonly runs: number;
}

interface BenchmarkTokenUsage {
  readonly usedTokens?: number;
  readonly totalProcessedTokens?: number;
  readonly maxTokens?: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly lastUsedTokens?: number;
  readonly lastInputTokens?: number;
  readonly lastCachedInputTokens?: number;
  readonly lastOutputTokens?: number;
  readonly lastReasoningOutputTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
}

interface BenchmarkRunOutput {
  readonly result: BenchmarkResult;
  readonly resultPath: string;
}

interface BenchmarkSummary {
  readonly batchId: string;
  readonly scenario: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly success: boolean;
  readonly runsRequested: number;
  readonly runsCompleted: number;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly resultPaths: ReadonlyArray<string>;
  readonly stats: {
    readonly serverReadyMs: BenchmarkStats | null;
    readonly desktopReadyMs: BenchmarkStats | null;
    readonly threadCreateMs: BenchmarkStats | null;
    readonly turnWallClockMs: BenchmarkStats | null;
    readonly timeToFirstAssistantFromTurnMs: BenchmarkStats | null;
    readonly timeToFinalAssistantFromTurnMs: BenchmarkStats | null;
    readonly outputTokens: BenchmarkStats | null;
    readonly reasoningOutputTokens: BenchmarkStats | null;
    readonly outputTokensPerSecond: BenchmarkStats | null;
  };
}

interface BenchmarkStats {
  readonly count: number;
  readonly min: number;
  readonly median: number;
  readonly p95: number;
  readonly max: number;
}

type RpcProtocolClient = any;

const makeRpcProtocolClient = RpcClient.make(WsRpcGroup);

function nowIso() {
  return new Date().toISOString();
}

function elapsedMs(startedAt: number) {
  return Math.round(performance.now() - startedAt);
}

function id(prefix: string) {
  return `${prefix}-${Crypto.randomUUID()}`;
}

function parseArgs(argv: ReadonlyArray<string>): BenchmarkOptions {
  const options: {
    scenario?: BenchmarkScenario;
    providerInstanceId?: string;
    model?: string;
    runs?: number;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--scenario") {
      options.scenario = parseScenario(readOptionValue(argv, (index += 1), arg));
      continue;
    }
    if (arg.startsWith("--scenario=")) {
      options.scenario = parseScenario(arg.slice("--scenario=".length));
      continue;
    }
    if (arg === "--provider" || arg === "--provider-instance") {
      options.providerInstanceId = readOptionValue(argv, (index += 1), arg);
      continue;
    }
    if (arg.startsWith("--provider=")) {
      options.providerInstanceId = arg.slice("--provider=".length);
      continue;
    }
    if (arg.startsWith("--provider-instance=")) {
      options.providerInstanceId = arg.slice("--provider-instance=".length);
      continue;
    }
    if (arg === "--model") {
      options.model = readOptionValue(argv, (index += 1), arg);
      continue;
    }
    if (arg.startsWith("--model=")) {
      options.model = arg.slice("--model=".length);
      continue;
    }
    if (arg === "--runs") {
      options.runs = parseRunCount(readOptionValue(argv, (index += 1), arg));
      continue;
    }
    if (arg.startsWith("--runs=")) {
      options.runs = parseRunCount(arg.slice("--runs=".length));
      continue;
    }
    throw new Error(`Unknown benchmark option: ${arg}`);
  }

  return {
    scenario: options.scenario ?? "exact-test-reply",
    ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
    ...(options.model ? { model: options.model } : {}),
    runs: options.runs ?? 1,
  };
}

function readOptionValue(argv: ReadonlyArray<string>, index: number, optionName: string) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function parseRunCount(raw: string) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error("--runs must be an integer between 1 and 50.");
  }
  return value;
}

function parseScenario(raw: string): BenchmarkScenario {
  if (raw === "exact-test-reply" || raw === "fixed-output") return raw;
  throw new Error(
    `Unknown benchmark scenario '${raw}'. Expected one of: ${Object.keys(SCENARIOS).join(", ")}.`,
  );
}

function printHelp() {
  console.log(`Usage: bun run dev:desktop:bench -- [options]

Options:
  --scenario <name>        Scenario to run: exact-test-reply or fixed-output
  --provider <instanceId>  Provider instance id to benchmark, for example codex
  --model <slug>           Model slug to benchmark, for example gpt-5.4-mini
  --runs <count>           Number of clean independent runs to execute
  -h, --help               Show this help
`);
}

async function canConnect(port: number, host = "127.0.0.1"): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = Net.createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function findPortOffset() {
  for (let offset = 3010; offset < 6000; offset += 1) {
    const serverBusy = await canConnect(BASE_SERVER_PORT + offset);
    const webBusy = await canConnect(BASE_WEB_PORT + offset);
    if (!serverBusy && !webBusy) return offset;
  }
  throw new Error("No available benchmark port offset found.");
}

async function waitForFile(path: string, timeoutMs: number) {
  const startedAt = performance.now();
  for (;;) {
    try {
      return await FS.readFile(path, "utf8");
    } catch (error) {
      if (performance.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for ${path}`, { cause: error });
      }
      await sleep(100);
    }
  }
}

async function waitForHttpOk(url: string, timeoutMs: number) {
  const startedAt = performance.now();
  for (;;) {
    try {
      const response = await fetchWithTimeout(url, { timeoutMs: 1_000 });
      if (response.status < 500) return;
    } catch {
      // Keep polling until timeout.
    }
    if (performance.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${url}`);
    }
    await sleep(100);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit & { readonly timeoutMs?: number } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? RPC_TIMEOUT_MS);
  try {
    const { timeoutMs: _timeoutMs, signal: _signal, ...requestInit } = init;
    return await fetch(input, {
      ...requestInit,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function withTimeout<T>(
  label: string,
  promise: Promise<T>,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out during ${label} after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function logStage(runId: string, stage: string) {
  console.log(`[bench] ${runId} ${stage}`);
}

function formatRunLabel(runIndex: number, runCount: number) {
  return runCount === 1 ? "" : ` run=${runIndex}/${runCount}`;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readTokenUsage(value: unknown): BenchmarkTokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const usage: Partial<Record<keyof BenchmarkTokenUsage, number>> = {};
  const assignNumber = (key: keyof BenchmarkTokenUsage, raw: unknown) => {
    const numberValue = asFiniteNumber(raw);
    if (numberValue !== undefined) {
      usage[key] = numberValue;
    }
  };
  assignNumber("usedTokens", record.usedTokens);
  assignNumber("totalProcessedTokens", record.totalProcessedTokens);
  assignNumber("maxTokens", record.maxTokens);
  assignNumber("inputTokens", record.inputTokens);
  assignNumber("cachedInputTokens", record.cachedInputTokens);
  assignNumber("outputTokens", record.outputTokens);
  assignNumber("reasoningOutputTokens", record.reasoningOutputTokens);
  assignNumber("lastUsedTokens", record.lastUsedTokens);
  assignNumber("lastInputTokens", record.lastInputTokens);
  assignNumber("lastCachedInputTokens", record.lastCachedInputTokens);
  assignNumber("lastOutputTokens", record.lastOutputTokens);
  assignNumber("lastReasoningOutputTokens", record.lastReasoningOutputTokens);
  assignNumber("toolUses", record.toolUses);
  assignNumber("durationMs", record.durationMs);
  return Object.keys(usage).length > 0 ? usage : null;
}

function deriveTokenMetrics(input: {
  readonly tokenUsage: BenchmarkTokenUsage | null;
  readonly timeToFinalAssistantFromTurnMs: number | null;
}) {
  const outputTokens = input.tokenUsage?.lastOutputTokens ?? input.tokenUsage?.outputTokens ?? null;
  const reasoningOutputTokens =
    input.tokenUsage?.lastReasoningOutputTokens ?? input.tokenUsage?.reasoningOutputTokens ?? null;
  const inputTokens = input.tokenUsage?.lastInputTokens ?? input.tokenUsage?.inputTokens ?? null;
  const cachedInputTokens =
    input.tokenUsage?.lastCachedInputTokens ?? input.tokenUsage?.cachedInputTokens ?? null;
  const totalTokens =
    input.tokenUsage?.lastUsedTokens ??
    (inputTokens !== null || outputTokens !== null || reasoningOutputTokens !== null
      ? (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningOutputTokens ?? 0)
      : (input.tokenUsage?.usedTokens ?? null));
  const durationMs = input.tokenUsage?.durationMs ?? input.timeToFinalAssistantFromTurnMs;
  const outputTokensPerSecond =
    outputTokens !== null && durationMs && durationMs > 0
      ? Math.round((outputTokens / (durationMs / 1_000)) * 100) / 100
      : null;

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    outputTokensPerSecond,
  };
}

async function exchangeBearerSession(httpBaseUrl: string, bootstrapToken: string) {
  const response = await fetchWithTimeout(new URL("/api/auth/bootstrap/bearer", httpBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: bootstrapToken }),
  });
  if (!response.ok) {
    throw new Error(`Bearer bootstrap failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { sessionToken?: string };
  if (!body.sessionToken) {
    throw new Error("Bearer bootstrap response did not include sessionToken.");
  }
  return body.sessionToken;
}

async function issueWebSocketToken(httpBaseUrl: string, bearerToken: string) {
  const response = await fetchWithTimeout(new URL("/api/auth/ws-token", httpBaseUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${bearerToken}` },
  });
  if (!response.ok) {
    throw new Error(`WebSocket token request failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { token?: string };
  if (!body.token) {
    throw new Error("WebSocket token response did not include token.");
  }
  return body.token;
}

function createRpcRuntime(wsUrl: string) {
  const socketUrl = new URL(wsUrl);
  socketUrl.pathname = "/ws";

  const websocketLayer = Layer.succeed(Socket.WebSocketConstructor, (url, protocols) => {
    return new globalThis.WebSocket(url, protocols);
  });
  const socketLayer = Socket.layerWebSocket(socketUrl.toString()).pipe(
    Layer.provide(websocketLayer),
  );
  const protocolLayer = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({
      retryTransientErrors: true,
    }),
  );
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      protocolLayer.pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson))),
    ),
  );
  const scope = runtime.runSync(Scope.make());
  const client = runtime.runPromise(Scope.provide(scope)(makeRpcProtocolClient));
  return {
    client,
    runPromise: <A>(effect: any) => runtime.runPromise(effect) as Promise<A>,
    runCallback: (effect: any) => runtime.runCallback(effect),
    dispose: async () => {
      await runtime.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined);
      runtime.dispose();
    },
  };
}

async function request<A>(
  rpc: ReturnType<typeof createRpcRuntime>,
  label: string,
  execute: (client: RpcProtocolClient) => any,
): Promise<A> {
  const client = await withTimeout(`${label}:rpc-client`, rpc.client);
  return await withTimeout(label, rpc.runPromise<A>(Effect.suspend(() => execute(client))));
}

function subscribeThread(
  rpc: ReturnType<typeof createRpcRuntime>,
  threadId: ThreadId,
  listener: (item: OrchestrationThreadStreamItem) => void,
) {
  let cancel: (() => void) | null = null;
  const completed = (async () => {
    const client = await rpc.client;
    cancel = rpc.runCallback(
      Stream.runForEach(client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId }), (item) =>
        Effect.sync(() => listener(item)),
      ),
    );
  })();
  return {
    cancel: () => cancel?.(),
    completed,
  };
}

function selectBenchmarkModel(
  providers: ReadonlyArray<ServerProvider>,
  settings: ServerSettings,
  options: BenchmarkOptions,
): ModelSelection {
  const availableProviders = providers.filter(
    (candidate) =>
      candidate.enabled &&
      candidate.installed &&
      candidate.status !== "disabled" &&
      candidate.availability !== "unavailable" &&
      candidate.models.length > 0,
  );

  const providerOverride = options.providerInstanceId;
  const modelOverride = options.model;
  if (providerOverride) {
    const provider = availableProviders.find(
      (candidate) => candidate.instanceId === providerOverride,
    );
    if (!provider) {
      throw new Error(`Provider instance '${providerOverride}' is not available for benchmarking.`);
    }
    const model =
      modelOverride ?? settings.textGenerationModelSelection?.model ?? provider.models[0]!.slug;
    if (!provider.models.some((candidate) => candidate.slug === model)) {
      throw new Error(
        `Model '${model}' is not available on provider instance '${providerOverride}'.`,
      );
    }
    return {
      instanceId: ProviderInstanceId.make(provider.instanceId),
      model,
      ...(settings.textGenerationModelSelection?.instanceId === provider.instanceId &&
      settings.textGenerationModelSelection?.model === model &&
      settings.textGenerationModelSelection.options
        ? { options: settings.textGenerationModelSelection.options }
        : {}),
    };
  }

  if (modelOverride) {
    const selectedProvider = settings.textGenerationModelSelection
      ? availableProviders.find(
          (provider) => provider.instanceId === settings.textGenerationModelSelection.instanceId,
        )
      : undefined;
    const provider =
      selectedProvider?.models.some((candidate) => candidate.slug === modelOverride) === true
        ? selectedProvider
        : availableProviders.find((candidate) =>
            candidate.models.some((model) => model.slug === modelOverride),
          );
    if (!provider) {
      throw new Error(`Model '${modelOverride}' is not available on any enabled provider.`);
    }
    return {
      instanceId: ProviderInstanceId.make(provider.instanceId),
      model: modelOverride,
    };
  }

  const selected = settings.textGenerationModelSelection;
  const selectedProvider =
    selected &&
    availableProviders.find(
      (provider) =>
        provider.instanceId === selected.instanceId &&
        provider.models.some((model) => model.slug === selected.model),
    );
  if (selected && selectedProvider) {
    return selected;
  }

  const provider = availableProviders[0];
  if (!provider) {
    throw new Error("No enabled provider with at least one model is available.");
  }
  return {
    instanceId: provider.instanceId,
    model: provider.models[0]!.slug,
  };
}

function startDevDesktop(input: {
  readonly runHome: string;
  readonly bootstrapPath: string;
  readonly portOffset: number;
}) {
  const child = spawn("bun", ["scripts/dev-runner.ts", "dev:desktop"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      T3CODE_HOME: input.runHome,
      T3CODE_BENCHMARK_MODE: "1",
      T3CODE_BENCHMARK_BOOTSTRAP_PATH: input.bootstrapPath,
      T3CODE_PORT_OFFSET: String(input.portOffset),
      T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
    },
    stdio: "inherit",
  });
  return child;
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(3_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

async function runSingleBenchmark(input: {
  readonly options: BenchmarkOptions;
  readonly batchId: string;
  readonly runIndex: number;
  readonly runCount: number;
}): Promise<BenchmarkRunOutput> {
  const startedAtIso = nowIso();
  const startedAt = performance.now();
  const scenario = SCENARIOS[input.options.scenario];
  const runId = `${input.batchId}-run-${String(input.runIndex).padStart(3, "0")}-${Crypto.randomBytes(3).toString("hex")}`;
  const runDir = Path.join(BENCH_ROOT, "runs", runId);
  const runHome = Path.join(runDir, "home");
  const workspaceRoot = Path.join(runDir, "workspace");
  const bootstrapPath = Path.join(runDir, "benchmark-bootstrap.json");
  const resultPath = Path.join(runDir, "result.json");

  await FS.mkdir(workspaceRoot, { recursive: true });
  await FS.writeFile(Path.join(workspaceRoot, "README.md"), "T3 Code benchmark workspace.\n");

  const portOffset = await findPortOffset();
  const child = startDevDesktop({ runHome, bootstrapPath, portOffset });
  let result: BenchmarkResult | null = null;

  try {
    logStage(
      runId,
      `waiting-for-desktop-bootstrap${formatRunLabel(input.runIndex, input.runCount)}`,
    );
    const bootstrapRaw = await waitForFile(bootstrapPath, DEFAULT_TIMEOUT_MS);
    const desktopReadyMs = elapsedMs(startedAt);
    const bootstrap = JSON.parse(bootstrapRaw) as BenchmarkBootstrap;
    logStage(runId, "waiting-for-server-http");
    await waitForHttpOk(new URL("/api/auth/session", bootstrap.httpBaseUrl).toString(), 30_000);
    const serverReadyMs = elapsedMs(startedAt);

    logStage(runId, "auth-bearer-bootstrap");
    const bearerToken = await withTimeout(
      "auth-bearer-bootstrap",
      exchangeBearerSession(bootstrap.httpBaseUrl, bootstrap.bootstrapToken),
    );
    logStage(runId, "auth-websocket-token");
    const wsToken = await withTimeout(
      "auth-websocket-token",
      issueWebSocketToken(bootstrap.httpBaseUrl, bearerToken),
    );
    const wsUrl = new URL(bootstrap.wsBaseUrl);
    wsUrl.searchParams.set("wsToken", wsToken);
    logStage(runId, "rpc-connect");
    const rpc = createRpcRuntime(wsUrl.toString());

    try {
      logStage(runId, "server-get-config");
      const config = await request<ServerConfig>(rpc, "server-get-config", (client) =>
        client[WS_METHODS.serverGetConfig]({}),
      );
      const modelSelection = selectBenchmarkModel(config.providers, config.settings, input.options);
      const projectId = ProjectId.make(id("project-bench"));
      const threadId = ThreadId.make(id("thread-bench"));
      const messageId = MessageId.make(id("message-bench"));
      const createdAt = nowIso();

      const projectCommand: ClientOrchestrationCommand = {
        type: "project.create",
        commandId: CommandId.make(id("cmd-project-create")),
        projectId,
        title: "Benchmark Project",
        workspaceRoot,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: modelSelection,
        createdAt,
      };
      logStage(runId, "project-create");
      await request(rpc, "project-create", (client) =>
        client[ORCHESTRATION_WS_METHODS.dispatchCommand](projectCommand),
      );

      const threadCreateStartedAt = performance.now();
      const threadCommand: ClientOrchestrationCommand = {
        type: "thread.create",
        commandId: CommandId.make(id("cmd-thread-create")),
        threadId,
        projectId,
        title: "Benchmark TEST",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: nowIso(),
      };
      logStage(runId, "thread-create");
      await request(rpc, "thread-create", (client) =>
        client[ORCHESTRATION_WS_METHODS.dispatchCommand](threadCommand),
      );
      const threadCreateMs = Math.round(performance.now() - threadCreateStartedAt);

      let firstAssistantEventMs: number | null = null;
      let finalAssistantEventMs: number | null = null;
      let timeToFirstAssistantFromTurnMs: number | null = null;
      let timeToFinalAssistantFromTurnMs: number | null = null;
      let tokenUsage: BenchmarkTokenUsage | null = null;
      let finalAssistantText = "";
      const assistantTextByMessageId = new Map<string, string>();
      let sessionReady = false;
      let finalAssistantReceived = false;
      let turnStartedAt: number | null = null;
      let turnStartedAtIso: string | null = null;
      let unsubscribeThread: () => void = NOOP;

      const completion = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for benchmark turn completion."));
        }, DEFAULT_TIMEOUT_MS);
        const subscription = subscribeThread(rpc, threadId, (item) => {
          if (item.kind !== "event") return;
          const event = item.event;
          if (event.type === "thread.message-sent" && event.payload.role === "assistant") {
            firstAssistantEventMs ??= elapsedMs(startedAt);
            timeToFirstAssistantFromTurnMs ??=
              turnStartedAt === null ? null : Math.round(performance.now() - turnStartedAt);
            const messageKey = event.payload.messageId;
            const currentText = assistantTextByMessageId.get(messageKey) ?? "";
            const nextText = event.payload.streaming
              ? `${currentText}${event.payload.text}`
              : event.payload.text || currentText;
            assistantTextByMessageId.set(messageKey, nextText);
            finalAssistantText = nextText;
            if (!event.payload.streaming) {
              finalAssistantEventMs = elapsedMs(startedAt);
              timeToFinalAssistantFromTurnMs =
                turnStartedAt === null ? null : Math.round(performance.now() - turnStartedAt);
              finalAssistantReceived = nextText.trim().length > 0;
            }
          }
          if (event.type === "thread.session-set") {
            sessionReady =
              event.payload.session.status === "ready" &&
              event.payload.session.activeTurnId === null;
          }
          if (
            event.type === "thread.activity-appended" &&
            event.payload.activity.kind === "context-window.updated"
          ) {
            tokenUsage = readTokenUsage(event.payload.activity.payload);
          }
          if (sessionReady && finalAssistantReceived) {
            clearTimeout(timeout);
            resolve();
          }
        });
        unsubscribeThread = subscription.cancel;
        subscription.completed.catch(reject);
      });
      await sleep(50);

      turnStartedAt = performance.now();
      turnStartedAtIso = nowIso();
      const turnCommand: ClientOrchestrationCommand = {
        type: "thread.turn.start",
        commandId: CommandId.make(id("cmd-turn-start")),
        threadId,
        message: {
          messageId,
          role: "user",
          text: scenario.prompt,
          attachments: [],
        },
        modelSelection,
        titleSeed: scenario.title,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: nowIso(),
      };
      logStage(runId, "turn-start");
      await request(rpc, "turn-start", (client) =>
        client[ORCHESTRATION_WS_METHODS.dispatchCommand](turnCommand),
      );
      logStage(runId, "waiting-for-turn-completion");
      await completion;
      unsubscribeThread();

      scenario.validate(finalAssistantText);
      const tokenMetrics = deriveTokenMetrics({
        tokenUsage,
        timeToFinalAssistantFromTurnMs,
      });

      result = {
        runId,
        batchId: input.batchId,
        runIndex: input.runIndex,
        runCount: input.runCount,
        scenario: input.options.scenario,
        startedAt: startedAtIso,
        turnStartedAt: turnStartedAtIso,
        completedAt: nowIso(),
        success: true,
        providerInstanceId: modelSelection.instanceId,
        model: modelSelection.model,
        modelOptions: modelSelection.options ?? [],
        serverReadyMs,
        desktopReadyMs,
        threadCreateMs,
        turnWallClockMs: Math.round(performance.now() - turnStartedAt),
        timeToFirstAssistantEventMs: firstAssistantEventMs,
        timeToFinalAssistantEventMs: finalAssistantEventMs,
        timeToFirstAssistantFromTurnMs,
        timeToFinalAssistantFromTurnMs,
        tokenUsage,
        ...tokenMetrics,
        finalAssistantText,
      };
    } finally {
      await rpc.dispose();
    }
  } catch (error) {
    result = {
      runId,
      batchId: input.batchId,
      runIndex: input.runIndex,
      runCount: input.runCount,
      scenario: input.options.scenario,
      startedAt: startedAtIso,
      turnStartedAt: null,
      completedAt: nowIso(),
      success: false,
      providerInstanceId: "",
      model: "",
      modelOptions: [],
      serverReadyMs: 0,
      desktopReadyMs: 0,
      threadCreateMs: 0,
      turnWallClockMs: 0,
      timeToFirstAssistantEventMs: null,
      timeToFinalAssistantEventMs: null,
      timeToFirstAssistantFromTurnMs: null,
      timeToFinalAssistantFromTurnMs: null,
      tokenUsage: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
      outputTokensPerSecond: null,
      finalAssistantText: "",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await FS.mkdir(runDir, { recursive: true });
    if (result) {
      await FS.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    }
    await stopChild(child);
  }

  if (!result.success) {
    console.error(`[bench] failed runId=${runId} result=${resultPath}`);
    console.error(result.error);
    process.exitCode = 1;
    return { result, resultPath };
  }

  console.log(
    [
      `[bench] passed runId=${runId}`,
      `model=${result.providerInstanceId}/${result.model}`,
      `turn=${result.turnWallClockMs}ms`,
      `firstAssistantFromTurn=${result.timeToFirstAssistantFromTurnMs ?? "n/a"}ms`,
      `finalAssistantFromTurn=${result.timeToFinalAssistantFromTurnMs ?? "n/a"}ms`,
      `outputTps=${result.outputTokensPerSecond ?? "n/a"}`,
      `result=${resultPath}`,
    ].join(" "),
  );
  return { result, resultPath };
}

function percentile(sortedValues: ReadonlyArray<number>, percentileValue: number) {
  if (sortedValues.length === 0) return null;
  const index = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  return sortedValues[Math.min(Math.max(index, 0), sortedValues.length - 1)]!;
}

function buildStats(values: ReadonlyArray<number | null | undefined>): BenchmarkStats | null {
  const sortedValues = values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .toSorted((left, right) => left - right);
  if (sortedValues.length === 0) return null;
  return {
    count: sortedValues.length,
    min: sortedValues[0]!,
    median: percentile(sortedValues, 50)!,
    p95: percentile(sortedValues, 95)!,
    max: sortedValues[sortedValues.length - 1]!,
  };
}

function buildSummary(input: {
  readonly batchId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly options: BenchmarkOptions;
  readonly outputs: ReadonlyArray<BenchmarkRunOutput>;
}): BenchmarkSummary {
  const results = input.outputs.map((output) => output.result);
  const successfulResults = results.filter((result) => result.success);
  const representative = successfulResults[0] ?? results[0];
  return {
    batchId: input.batchId,
    scenario: input.options.scenario,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    success: successfulResults.length === input.options.runs,
    runsRequested: input.options.runs,
    runsCompleted: successfulResults.length,
    providerInstanceId:
      representative?.providerInstanceId ?? input.options.providerInstanceId ?? "",
    model: representative?.model ?? input.options.model ?? "",
    resultPaths: input.outputs.map((output) => output.resultPath),
    stats: {
      serverReadyMs: buildStats(successfulResults.map((result) => result.serverReadyMs)),
      desktopReadyMs: buildStats(successfulResults.map((result) => result.desktopReadyMs)),
      threadCreateMs: buildStats(successfulResults.map((result) => result.threadCreateMs)),
      turnWallClockMs: buildStats(successfulResults.map((result) => result.turnWallClockMs)),
      timeToFirstAssistantFromTurnMs: buildStats(
        successfulResults.map((result) => result.timeToFirstAssistantFromTurnMs),
      ),
      timeToFinalAssistantFromTurnMs: buildStats(
        successfulResults.map((result) => result.timeToFinalAssistantFromTurnMs),
      ),
      outputTokens: buildStats(successfulResults.map((result) => result.outputTokens)),
      reasoningOutputTokens: buildStats(
        successfulResults.map((result) => result.reasoningOutputTokens),
      ),
      outputTokensPerSecond: buildStats(
        successfulResults.map((result) => result.outputTokensPerSecond),
      ),
    },
  };
}

async function runBenchmark() {
  const options = parseArgs(process.argv.slice(2));
  const batchStartedAt = nowIso();
  const batchId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Crypto.randomBytes(3).toString("hex")}`;
  const outputs: Array<BenchmarkRunOutput> = [];

  console.log(
    [
      `[bench] batch=${batchId}`,
      `scenario=${options.scenario}`,
      `runs=${options.runs}`,
      options.providerInstanceId ? `provider=${options.providerInstanceId}` : null,
      options.model ? `model=${options.model}` : null,
    ]
      .filter(Boolean)
      .join(" "),
  );

  for (let runIndex = 1; runIndex <= options.runs; runIndex += 1) {
    const output = await runSingleBenchmark({
      options,
      batchId,
      runIndex,
      runCount: options.runs,
    });
    outputs.push(output);
    if (!output.result.success) break;
  }

  const summary = buildSummary({
    batchId,
    startedAt: batchStartedAt,
    completedAt: nowIso(),
    options,
    outputs,
  });
  const summaryPath = Path.join(BENCH_ROOT, "runs", `${batchId}-summary.json`);
  await FS.mkdir(Path.dirname(summaryPath), { recursive: true });
  await FS.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  console.log(
    [
      `[bench] summary batch=${batchId}`,
      `success=${summary.success}`,
      `completed=${summary.runsCompleted}/${summary.runsRequested}`,
      `turnMedian=${summary.stats.turnWallClockMs?.median ?? "n/a"}ms`,
      `finalFromTurnMedian=${summary.stats.timeToFinalAssistantFromTurnMs?.median ?? "n/a"}ms`,
      `outputTpsMedian=${summary.stats.outputTokensPerSecond?.median ?? "n/a"}`,
      `summary=${summaryPath}`,
    ].join(" "),
  );

  if (!summary.success) process.exitCode = 1;
}

await runBenchmark();
