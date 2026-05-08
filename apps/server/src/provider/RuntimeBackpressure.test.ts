import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { classifyProviderRuntimeEvent } from "./RuntimeBackpressure.ts";

const baseEvent = {
  provider: ProviderDriverKind.make("codex"),
  threadId: ThreadId.make("thread-1"),
};

describe("provider runtime backpressure policy", () => {
  it("keeps lifecycle and completion events on the must-deliver path", () => {
    expect(classifyProviderRuntimeEvent({ ...baseEvent, type: "session.started" })).toBe(
      "must-deliver",
    );
    expect(classifyProviderRuntimeEvent({ ...baseEvent, type: "turn.completed" })).toBe(
      "must-deliver",
    );
    expect(classifyProviderRuntimeEvent({ ...baseEvent, type: "request.opened" })).toBe(
      "must-deliver",
    );
    expect(classifyProviderRuntimeEvent({ ...baseEvent, type: "runtime.error" })).toBe(
      "must-deliver",
    );
  });

  it("marks high-frequency deltas as coalescible", () => {
    expect(classifyProviderRuntimeEvent({ ...baseEvent, type: "content.delta" })).toBe(
      "coalescible",
    );
    expect(classifyProviderRuntimeEvent({ ...baseEvent, type: "turn.proposed.delta" })).toBe(
      "coalescible",
    );
    expect(classifyProviderRuntimeEvent({ ...baseEvent, type: "tool.progress" })).toBe(
      "coalescible",
    );
  });

  it("defaults non-critical notices to droppable classification", () => {
    expect(classifyProviderRuntimeEvent({ ...baseEvent, type: "deprecation.notice" })).toBe(
      "droppable",
    );
  });
});
