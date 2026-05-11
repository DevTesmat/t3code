import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Deferred, Effect } from "effect";

import { makeKeyedCoalescingWorker } from "./KeyedCoalescingWorker.ts";

describe("makeKeyedCoalescingWorker", () => {
  it.live("waits for latest work enqueued during active processing before draining the key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          merge: (_current, next) => next,
          process: (key, value) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}`);

              if (value === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }

              if (value === "second") {
                yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseSecond);
              }
            }),
        });

        yield* worker.enqueue("terminal-1", "first");
        yield* Deferred.await(firstStarted);
        expect((yield* worker.health).active).toBe(1);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker
            .drainKey("terminal-1")
            .pipe(Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie))),
        );

        yield* worker.enqueue("terminal-1", "second");
        const coalescedHealth = yield* worker.health;
        expect(coalescedHealth.backlog).toBe(1);
        expect(coalescedHealth.coalesced).toBe(0);
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["terminal-1:first", "terminal-1:second"]);
        const health = yield* worker.health;
        expect(health.backlog).toBe(0);
        expect(health.attempted).toBe(2);
        expect(health.accepted).toBe(2);
        expect(health.processed).toBe(2);
        expect(health.dropped).toBe(0);
      }),
    ),
  );

  it.live("requeues pending work for a key after a processor failure and keeps draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFailure = yield* Deferred.make<void>();
        const secondProcessed = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, string, never>({
          merge: (_current, next) => next,
          process: (key, value) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}`);

              if (value === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFailure);
                yield* Effect.fail("boom");
              }

              if (value === "second" || value === "third") {
                yield* Deferred.succeed(secondProcessed, undefined).pipe(Effect.orDie);
              }
            }),
        });

        yield* worker.enqueue("terminal-1", "first");
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue("terminal-1", "second");
        yield* worker.enqueue("terminal-1", "third");
        expect((yield* worker.health).coalesced).toBe(1);
        yield* Deferred.succeed(releaseFailure, undefined);
        yield* Deferred.await(secondProcessed);
        yield* worker.drainKey("terminal-1");

        expect(processed).toEqual(["terminal-1:first", "terminal-1:third"]);
        const health = yield* worker.health;
        expect(health.attempted).toBe(3);
        expect(health.accepted).toBe(3);
        expect(health.failed).toBe(1);
        expect(health.processed).toBe(1);
        expect(health.dropped).toBe(0);
      }),
    ),
  );
});
