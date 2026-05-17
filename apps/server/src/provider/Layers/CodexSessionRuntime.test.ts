import assert from "node:assert/strict";

import { Effect, Schema } from "effect";
import { describe, it } from "vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_EXPLORATION_COMMAND_STEERING_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_SUBAGENT_COORDINATION_INSTRUCTIONS,
  CODEX_USER_INPUT_TOOL_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import {
  buildTurnStartParams,
  isRecoverableThreadResumeError,
  openCodexThread,
} from "./CodexSessionRuntime.ts";

const SUBAGENT_USER_INPUT_STARTUP_POLICY = [
  "Subagent startup policy:",
  "- T3Code owns subagent startup model selection state.",
  "- The request_user_input tool is available for this startup gate in every T3Code collaboration mode.",
  "- Before every spawnAgent call, call request_user_input to ask the user which subagent model and reasoning effort to use.",
  "- Do not ask this as a normal chat question; use request_user_input so the app can show a pending user-input state before the subagent exists.",
  "- The request_user_input call must contain exactly these question ids for startup selection: subagent_model and subagent_reasoning_effort.",
  "- The subagent_model answer must be the raw model id to pass as spawnAgent.model.",
  "- The subagent_reasoning_effort answer must be the raw reasoning effort to pass as spawnAgent.reasoning_effort.",
  "- After request_user_input resolves, pass the selected model and reasoning_effort into spawnAgent.",
].join("\n");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: `${CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS}\n\n${SUBAGENT_USER_INPUT_STARTUP_POLICY}`,
        },
      },
    });
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /official Plan Mode plan/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /<proposed_plan>/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /custom `\.md` plan/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /non-`<proposed_plan>` deliverable/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /compact, legible/);
    assert.match(
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
      /single-level feature- or outcome-oriented bullets/,
    );
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /Avoid nested bullets by default/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /Aim for under 40 lines in official/);
    assert.match(
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
      /top "Cause" section of at most 1-2 lines/,
    );
    assert.match(
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
      /repetitive "Risk" \/ "Plan" \/ "Verification" subsections/,
    );
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /bounded research helpers/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /repo explorers/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /online researchers/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /intermediate verification runners/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /parallel repo searches/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /destructive operations/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /must not edit or write files/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /test\/check commands/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /expected output format/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /links and dates/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /exit status/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /After the batch is done/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /receiver thread ID/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /failed or stale subagents/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /reviewed the evidence/);
    assert.match(
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
      /main agent must run that final validation/,
    );
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /Exploration command guidance/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /User input tool availability/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /every T3Code collaboration mode/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /rg --files/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /git status --short/);
    assert.match(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /dense shell pipelines/);
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: `${CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS}\n\n${SUBAGENT_USER_INPUT_STARTUP_POLICY}`,
        },
      },
    });
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /label Default mode as Build mode/);
    assert.match(
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      /request_user_input.*blocking question is important/,
    );
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /User input tool availability/);
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /future modes/);
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /blocking question is important/);
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /bounded research helpers/);
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /repo explorers/);
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /online researchers/);
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /intermediate verification runners/);
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /parallel repo searches/);
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /destructive operations/);
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /must not edit or write files/);
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /test\/check commands/);
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /expected output format/);
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /links and dates/);
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /exit status/);
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /After the batch is done/);
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /receiver thread ID/);
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /failed or stale subagents/);
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /reviewed the evidence/);
    assert.match(
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      /main agent must run that final validation/,
    );
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /Exploration command guidance/);
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /rg --files/);
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /git status --short/);
    assert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /dense shell pipelines/);
  });

  it("uses the same subagent coordination guidance in plan and default modes", () => {
    assert.match(
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
      new RegExp(escapeRegExp(CODEX_SUBAGENT_COORDINATION_INSTRUCTIONS)),
    );
    assert.match(
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      new RegExp(escapeRegExp(CODEX_SUBAGENT_COORDINATION_INSTRUCTIONS)),
    );
  });

  it("uses the same exploration command guidance in plan and default modes", () => {
    assert.match(
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
      new RegExp(escapeRegExp(CODEX_EXPLORATION_COMMAND_STEERING_INSTRUCTIONS)),
    );
    assert.match(
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      new RegExp(escapeRegExp(CODEX_EXPLORATION_COMMAND_STEERING_INSTRUCTIONS)),
    );
  });

  it("uses the same user-input tool guidance in plan and default modes", () => {
    assert.match(
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
      new RegExp(escapeRegExp(CODEX_USER_INPUT_TOOL_INSTRUCTIONS)),
    );
    assert.match(
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      new RegExp(escapeRegExp(CODEX_USER_INPUT_TOOL_INSTRUCTIONS)),
    );
  });

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });

  it("requires app-mediated user input before subagent startup without no-prompt default", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Explore this",
        model: "gpt-5.5",
        interactionMode: "default",
      }),
    );

    const instructions = params.collaborationMode?.settings.developer_instructions ?? "";
    assert.match(instructions, /Subagent startup policy/);
    assert.match(instructions, /T3Code owns subagent startup model selection state/);
    assert.match(
      instructions,
      /available for this startup gate in every T3Code collaboration mode/,
    );
    assert.match(instructions, /Before every spawnAgent call, call request_user_input/);
    assert.match(instructions, /subagent_model and subagent_reasoning_effort/);
    assert.match(instructions, /show a pending user-input state before the subagent exists/);
    assert.match(instructions, /pass the selected model and reasoning_effort into spawnAgent/);
  });

  it("allows direct subagent startup with the persisted no-prompt default", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Explore this",
        model: "gpt-5.5",
        interactionMode: "default",
        subagentNoPrompt: true,
        subagentDefaultModelSelection: createModelSelection(
          ProviderInstanceId.make("codex"),
          "gpt-5.4-mini",
          [{ id: "reasoningEffort", value: "low" }],
        ),
      }),
    );

    const instructions = params.collaborationMode?.settings.developer_instructions ?? "";
    assert.match(instructions, /When calling spawnAgent, pass model: "gpt-5.4-mini"/);
    assert.match(instructions, /pass reasoning_effort: "low"/);
    assert.match(instructions, /no-prompt is enabled/);
    assert.doesNotMatch(instructions, /Before every spawnAgent call, call request_user_input/);
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it("falls back to thread/start when resume fails recoverably", async () => {
    const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
    const started = makeThreadOpenResponse("fresh-thread");
    const client = {
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        calls.push({ method, payload });
        if (method === "thread/resume") {
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "thread not found",
            }),
          );
        }
        return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
      },
    };

    const opened = await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }),
    );

    assert.equal(opened.thread.id, "fresh-thread");
    assert.deepStrictEqual(
      calls.map((call) => call.method),
      ["thread/resume", "thread/start"],
    );
  });

  it("propagates non-recoverable resume failures", async () => {
    const client = {
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        _payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        if (method === "thread/resume") {
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "timed out waiting for server",
            }),
          );
        }
        return Effect.succeed(
          makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
        );
      },
    };

    await assert.rejects(
      Effect.runPromise(
        openCodexThread({
          client,
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "full-access",
          cwd: "/tmp/project",
          requestedModel: "gpt-5.3-codex",
          serviceTier: undefined,
          resumeThreadId: "stale-thread",
        }),
      ),
      (error: unknown) =>
        Schema.is(CodexErrors.CodexAppServerRequestError)(error) &&
        error.errorMessage === "timed out waiting for server",
    );
  });
});
