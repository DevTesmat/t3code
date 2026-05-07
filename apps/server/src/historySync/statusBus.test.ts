import type { HistorySyncStatus } from "@t3tools/contracts";
import { Effect, PubSub, Ref } from "effect";
import { describe, expect, test } from "vitest";

import {
  DISABLED_HISTORY_SYNC_STATUS,
  publishHistorySyncStatus,
  readHistorySyncStatus,
  subscribeHistorySyncStatus,
} from "./statusBus.ts";

describe("history sync status bus", () => {
  test("starts with the disabled fallback status", () => {
    expect(readHistorySyncStatus()).toEqual({
      state: "disabled",
      configured: false,
    });
  });

  test("publishes latest status and cleans up subscribers", async () => {
    const statuses: HistorySyncStatus[] = [];
    const idleStatus: HistorySyncStatus = {
      state: "idle",
      configured: true,
      lastSyncedAt: "2026-05-07T12:00:00.000Z",
    };
    const errorStatus: HistorySyncStatus = {
      state: "error",
      configured: true,
      message: "failed",
      lastSyncedAt: "2026-05-07T12:00:00.000Z",
    };

    const published = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const statusRef = yield* Ref.make<HistorySyncStatus>(DISABLED_HISTORY_SYNC_STATUS);
          const statusPubSub = yield* PubSub.unbounded<HistorySyncStatus>();
          const subscription = yield* PubSub.subscribe(statusPubSub);
          const unsubscribe = yield* subscribeHistorySyncStatus((status) =>
            Effect.sync(() => {
              statuses.push(status);
            }),
          );

          yield* publishHistorySyncStatus({ status: idleStatus, statusRef, statusPubSub });
          const refStatus = yield* Ref.get(statusRef);
          const pubSubStatus = yield* PubSub.take(subscription);

          unsubscribe();
          yield* publishHistorySyncStatus({ status: errorStatus, statusRef, statusPubSub });

          return { refStatus, pubSubStatus };
        }),
      ),
    );

    expect(readHistorySyncStatus()).toEqual(errorStatus);
    expect(published.refStatus).toEqual(idleStatus);
    expect(published.pubSubStatus).toEqual(idleStatus);
    expect(statuses).toEqual([idleStatus]);
  });
});
