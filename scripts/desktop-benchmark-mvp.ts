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
const PROMPT = "Reply exactly with: TEST";
const EXPECTED_REPLY = "TEST";
const SCENARIO = "exact-test-reply";
const DEFAULT_TIMEOUT_MS = 120_000;
const RPC_TIMEOUT_MS = 20_000;
const NOOP = () => undefined;

interface BenchmarkBootstrap {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bootstrapToken: string;
}

interface BenchmarkResult {
  readonly runId: string;
  readonly scenario: string;
  readonly startedAt: string;
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
  readonly finalAssistantText: string;
  readonly error?: string;
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
): ModelSelection {
  const selected = settings.textGenerationModelSelection;
  const selectedProvider =
    selected &&
    providers.find(
      (provider) =>
        provider.instanceId === selected.instanceId &&
        provider.enabled &&
        provider.installed &&
        provider.status !== "disabled" &&
        provider.availability !== "unavailable",
    );
  if (selected && selectedProvider) {
    return selected;
  }

  const provider = providers.find(
    (candidate) =>
      candidate.enabled &&
      candidate.installed &&
      candidate.status !== "disabled" &&
      candidate.availability !== "unavailable" &&
      candidate.models.length > 0,
  );
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

async function runBenchmark() {
  const startedAtIso = nowIso();
  const startedAt = performance.now();
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Crypto.randomBytes(3).toString("hex")}`;
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
    logStage(runId, "waiting-for-desktop-bootstrap");
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
      const modelSelection = selectBenchmarkModel(config.providers, config.settings);
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
      let finalAssistantText = "";
      const assistantTextByMessageId = new Map<string, string>();
      let sessionReady = false;
      let finalAssistantReceived = false;
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
            const messageKey = event.payload.messageId;
            const currentText = assistantTextByMessageId.get(messageKey) ?? "";
            const nextText = event.payload.streaming
              ? `${currentText}${event.payload.text}`
              : event.payload.text || currentText;
            assistantTextByMessageId.set(messageKey, nextText);
            finalAssistantText = nextText;
            if (!event.payload.streaming) {
              finalAssistantEventMs = elapsedMs(startedAt);
              finalAssistantReceived = nextText.trim().length > 0;
            }
          }
          if (event.type === "thread.session-set") {
            sessionReady =
              event.payload.session.status === "ready" &&
              event.payload.session.activeTurnId === null;
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

      const turnStartedAt = performance.now();
      const turnCommand: ClientOrchestrationCommand = {
        type: "thread.turn.start",
        commandId: CommandId.make(id("cmd-turn-start")),
        threadId,
        message: {
          messageId,
          role: "user",
          text: PROMPT,
          attachments: [],
        },
        modelSelection,
        titleSeed: "Benchmark TEST",
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

      const normalizedReply = finalAssistantText.trim();
      if (normalizedReply !== EXPECTED_REPLY) {
        throw new Error(
          `Expected assistant reply '${EXPECTED_REPLY}', received '${normalizedReply}'.`,
        );
      }

      result = {
        runId,
        scenario: SCENARIO,
        startedAt: startedAtIso,
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
        finalAssistantText,
      };
    } finally {
      await rpc.dispose();
    }
  } catch (error) {
    result = {
      runId,
      scenario: SCENARIO,
      startedAt: startedAtIso,
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
    return;
  }

  console.log(
    [
      `[bench] passed runId=${runId}`,
      `model=${result.providerInstanceId}/${result.model}`,
      `turn=${result.turnWallClockMs}ms`,
      `firstAssistant=${result.timeToFirstAssistantEventMs ?? "n/a"}ms`,
      `finalAssistant=${result.timeToFinalAssistantEventMs ?? "n/a"}ms`,
      `result=${resultPath}`,
    ].join(" "),
  );
}

await runBenchmark();
