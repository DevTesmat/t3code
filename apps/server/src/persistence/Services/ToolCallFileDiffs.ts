import { IsoDateTime, NonNegativeInt, ProviderItemId, ThreadId, TurnId } from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ToolCallFileDiff = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  toolCallId: ProviderItemId,
  diff: Schema.String,
  truncated: Schema.Boolean,
  sizeBytes: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastAccessedAt: IsoDateTime,
});
export type ToolCallFileDiff = typeof ToolCallFileDiff.Type;

export const UpsertToolCallFileDiffInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  toolCallId: ProviderItemId,
  diff: Schema.String,
  truncated: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type UpsertToolCallFileDiffInput = typeof UpsertToolCallFileDiffInput.Type;

export const ListToolCallFileDiffsByThreadInput = Schema.Struct({
  threadId: ThreadId,
  accessedAt: IsoDateTime,
});
export type ListToolCallFileDiffsByThreadInput = typeof ListToolCallFileDiffsByThreadInput.Type;

export const ListLatestToolCallFileDiffsByThreadInput = Schema.Struct({
  threadId: ThreadId,
  accessedAt: IsoDateTime,
  limit: NonNegativeInt,
});
export type ListLatestToolCallFileDiffsByThreadInput =
  typeof ListLatestToolCallFileDiffsByThreadInput.Type;

export const GetToolCallFileDiffInput = Schema.Struct({
  threadId: ThreadId,
  toolCallId: ProviderItemId,
  accessedAt: IsoDateTime,
});
export type GetToolCallFileDiffInput = typeof GetToolCallFileDiffInput.Type;

export const CleanupToolCallFileDiffsInput = Schema.Struct({
  now: IsoDateTime,
  staleAfterMs: NonNegativeInt,
  maxTotalBytes: NonNegativeInt,
  targetTotalBytes: NonNegativeInt,
  batchSize: NonNegativeInt,
});
export type CleanupToolCallFileDiffsInput = typeof CleanupToolCallFileDiffsInput.Type;

export interface ToolCallFileDiffRepositoryShape {
  readonly upsert: (
    input: UpsertToolCallFileDiffInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThread: (
    input: ListToolCallFileDiffsByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ToolCallFileDiff>, ProjectionRepositoryError>;
  readonly listLatestByThread: (
    input: ListLatestToolCallFileDiffsByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ToolCallFileDiff>, ProjectionRepositoryError>;
  readonly getByThreadAndToolCall: (
    input: GetToolCallFileDiffInput,
  ) => Effect.Effect<ToolCallFileDiff | null, ProjectionRepositoryError>;
  readonly cleanupIfOverBudget: (
    input: CleanupToolCallFileDiffsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ToolCallFileDiffRepository extends Context.Service<
  ToolCallFileDiffRepository,
  ToolCallFileDiffRepositoryShape
>()("t3/persistence/Services/ToolCallFileDiffs/ToolCallFileDiffRepository") {}
