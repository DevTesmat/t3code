import { describe, expect, it } from "vitest";
import { Deferred, Duration, Effect, Fiber, Option, Ref } from "effect";

import { makeWebSocketSnapshotReloadCoordinator } from "./wsSnapshotReloadCoordinator.ts";

describe("WebSocket snapshot reload coordinator", () => {
  it("shares an in-flight reload for the same snapshot key", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = yield* makeWebSocketSnapshotReloadCoordinator({
          debounceWindow: Duration.zero,
        });
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const loadCount = yield* Ref.make(0);

        const load = Ref.update(loadCount, (count) => count + 1).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Deferred.await(release)),
          Effect.as("snapshot"),
        );

        const firstFiber = yield* coordinator
          .reload("thread:thread-1", load)
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const secondFiber = yield* coordinator
          .reload("thread:thread-1", load)
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        yield* Deferred.succeed(release, undefined);

        const [first, second, loads] = yield* Effect.all([
          Fiber.join(firstFiber),
          Fiber.join(secondFiber),
          Ref.get(loadCount),
        ]);

        expect(first).toEqual(Option.some("snapshot"));
        expect(second).toEqual(Option.some("snapshot"));
        expect(loads).toBe(1);
      }),
    );
  });

  it("debounces repeated reloads for the same key", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const currentTime = yield* Ref.make(1_000);
        const coordinator = yield* makeWebSocketSnapshotReloadCoordinator({
          debounceWindow: Duration.millis(100),
          now: Ref.get(currentTime),
        });
        const loadCount = yield* Ref.make(0);
        const load = Ref.update(loadCount, (count) => count + 1).pipe(Effect.as("snapshot"));

        const first = yield* coordinator.reload("shell", load);
        const second = yield* coordinator.reload("shell", load);
        yield* Ref.set(currentTime, 1_101);
        const third = yield* coordinator.reload("shell", load);
        const loads = yield* Ref.get(loadCount);

        expect(first).toEqual(Option.some("snapshot"));
        expect(second).toEqual(Option.none());
        expect(third).toEqual(Option.some("snapshot"));
        expect(loads).toBe(2);
      }),
    );
  });

  it("tracks subscribers independently by snapshot key", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = yield* makeWebSocketSnapshotReloadCoordinator({
          debounceWindow: Duration.zero,
        });
        const shellRelease = yield* coordinator.registerSubscriber("shell");
        const threadRelease = yield* coordinator.registerSubscriber("thread:thread-1");

        const shell = yield* coordinator.reload("shell", Effect.succeed("shell-snapshot"));
        const thread = yield* coordinator.reload(
          "thread:thread-1",
          Effect.succeed("thread-snapshot"),
        );

        yield* shellRelease;
        yield* threadRelease;

        expect(shell).toEqual(Option.some("shell-snapshot"));
        expect(thread).toEqual(Option.some("thread-snapshot"));
      }),
    );
  });
});
