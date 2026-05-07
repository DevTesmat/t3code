import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";

import {
  projectionProgressLabel,
  reloadHistorySyncProjections,
  type HistorySyncProgress,
} from "./projectionReload.ts";

describe("history sync projection reload", () => {
  test("is a no-op when reload is unavailable", async () => {
    await expect(Effect.runPromise(reloadHistorySyncProjections({}))).resolves.toBeUndefined();
  });

  test("publishes projecting progress and unsubscribes after successful reload", async () => {
    const published: HistorySyncProgress[] = [];
    let unsubscribed = false;

    await Effect.runPromise(
      reloadHistorySyncProjections({
        reloadFromStorage: () => Effect.void,
        context: {
          startedAt: "2026-05-07T12:00:00.000Z",
          lastSyncedAt: null,
        },
        publishProgress: (input) =>
          Effect.sync(() => {
            published.push(input.progress);
          }),
        subscribeProgress: (subscriber) =>
          Effect.sync(() => {
            void Effect.runSync(
              subscriber({
                projector: "projection.thread-messages",
                projectedCount: 3,
                maxSequence: 7,
                completed: false,
              }),
            );
            return () => {
              unsubscribed = true;
            };
          }),
      }),
    );

    expect(published).toEqual([
      {
        phase: "projecting",
        label: "Projecting thread messages",
        current: 3,
        total: 7,
      },
    ]);
    expect(unsubscribed).toBe(true);
  });

  test("unsubscribes when reload fails and maps the error", async () => {
    let unsubscribed = false;

    const exit = await Effect.runPromiseExit(
      reloadHistorySyncProjections({
        reloadFromStorage: () => Effect.fail(new Error("projection storage unavailable")),
        context: {
          startedAt: "2026-05-07T12:00:00.000Z",
          lastSyncedAt: "2026-05-07T11:00:00.000Z",
        },
        publishProgress: () => Effect.void,
        subscribeProgress: () =>
          Effect.sync(() => {
            return () => {
              unsubscribed = true;
            };
          }),
      }),
    );

    expect(unsubscribed).toBe(true);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain("Projection reload failed");
      expect(exit.cause.toString()).toContain("projection storage unavailable");
    }
  });

  test("formats projection progress labels", () => {
    expect(
      projectionProgressLabel({
        projector: "projection.pending-approvals",
        projectedCount: 1,
        maxSequence: 1,
        completed: true,
      }),
    ).toBe("Projecting pending approvals");
  });
});
