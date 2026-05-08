import type { ProviderRuntimeEvent, ProviderRuntimeEventType } from "@t3tools/contracts";

export const PROVIDER_RUNTIME_EVENT_BUFFER_CAPACITY = 10_000;
export const PROVIDER_REGISTRY_CHANGES_BUFFER_CAPACITY = 256;

export type ProviderRuntimeEventBackpressureClass = "must-deliver" | "coalescible" | "droppable";

const MUST_DELIVER_EVENT_TYPES = new Set<ProviderRuntimeEventType>([
  "session.started",
  "session.configured",
  "session.state.changed",
  "session.exited",
  "thread.started",
  "thread.state.changed",
  "thread.metadata.updated",
  "thread.realtime.started",
  "thread.realtime.error",
  "thread.realtime.closed",
  "turn.started",
  "turn.completed",
  "turn.aborted",
  "turn.plan.updated",
  "turn.proposed.completed",
  "turn.diff.updated",
  "item.started",
  "item.completed",
  "request.opened",
  "request.resolved",
  "user-input.requested",
  "user-input.resolved",
  "task.started",
  "task.completed",
  "hook.started",
  "hook.completed",
  "tool.summary",
  "auth.status",
  "account.updated",
  "account.rate-limits.updated",
  "mcp.status.updated",
  "mcp.oauth.completed",
  "model.rerouted",
  "config.warning",
  "files.persisted",
  "runtime.warning",
  "runtime.error",
]);

const COALESCIBLE_EVENT_TYPES = new Set<ProviderRuntimeEventType>([
  "thread.token-usage.updated",
  "thread.realtime.item-added",
  "thread.realtime.audio.delta",
  "turn.proposed.delta",
  "item.updated",
  "content.delta",
  "task.progress",
  "hook.progress",
  "tool.progress",
]);

export function classifyProviderRuntimeEvent(
  event: Pick<ProviderRuntimeEvent, "type">,
): ProviderRuntimeEventBackpressureClass {
  if (MUST_DELIVER_EVENT_TYPES.has(event.type)) return "must-deliver";
  if (COALESCIBLE_EVENT_TYPES.has(event.type)) return "coalescible";
  return "droppable";
}
