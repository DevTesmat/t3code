import { Deferred, Duration, Effect, Exit, Option, Ref } from "effect";

export interface WebSocketSnapshotReloadCoordinator {
  readonly registerSubscriber: (
    key: string,
  ) => Effect.Effect<Effect.Effect<void, never, never>, never, never>;
  readonly reload: <A, E>(
    key: string,
    load: Effect.Effect<A, E, never>,
  ) => Effect.Effect<Option.Option<A>, E, never>;
}

export const makeWebSocketSnapshotReloadCoordinator = (options?: {
  readonly debounceWindow?: Duration.Duration;
  readonly now?: Effect.Effect<number, never, never>;
}): Effect.Effect<WebSocketSnapshotReloadCoordinator, never, never> =>
  Effect.gen(function* () {
    const debounceWindowMs = Duration.toMillis(options?.debounceWindow ?? Duration.millis(100));
    const now = options?.now ?? Effect.sync(() => Date.now());
    const inFlightReloads = yield* Ref.make(new Map<string, Deferred.Deferred<unknown, unknown>>());
    const lastReloadStartedAt = yield* Ref.make(new Map<string, number>());
    const subscriberCounts = yield* Ref.make(new Map<string, number>());

    const getSubscriberCount = (key: string) =>
      Ref.get(subscriberCounts).pipe(Effect.map((counts) => counts.get(key) ?? 0));

    return {
      registerSubscriber: (key) =>
        Ref.update(subscriberCounts, (counts) => {
          const next = new Map(counts);
          next.set(key, (next.get(key) ?? 0) + 1);
          return next;
        }).pipe(
          Effect.as(
            Ref.update(subscriberCounts, (counts) => {
              const next = new Map(counts);
              const count = next.get(key) ?? 0;
              if (count <= 1) {
                next.delete(key);
              } else {
                next.set(key, count - 1);
              }
              return next;
            }),
          ),
        ),
      reload: <A, E>(key: string, load: Effect.Effect<A, E, never>) =>
        Effect.gen(function* () {
          const existing = yield* Ref.get(inFlightReloads).pipe(
            Effect.map((reloads) => reloads.get(key) as Deferred.Deferred<A, E> | undefined),
          );
          if (existing) {
            const subscriberCount = yield* getSubscriberCount(key);
            yield* Effect.logDebug("websocket snapshot reload coalesced", {
              key,
              subscriberCount,
            });
            return Option.some(yield* Deferred.await(existing));
          }

          const startedAt = yield* now;
          const lastStartedAt = yield* Ref.get(lastReloadStartedAt).pipe(
            Effect.map((reloads) => reloads.get(key)),
          );
          if (
            lastStartedAt !== undefined &&
            debounceWindowMs > 0 &&
            startedAt - lastStartedAt < debounceWindowMs
          ) {
            const subscriberCount = yield* getSubscriberCount(key);
            yield* Effect.logDebug("websocket snapshot reload debounced", {
              key,
              subscriberCount,
              debounceWindowMs,
            });
            return Option.none<A>();
          }

          const deferred = yield* Deferred.make<A, E>();
          type InstalledReload = {
            readonly deferred: Deferred.Deferred<A, E>;
            readonly owner: boolean;
          };
          const installed = yield* Ref.modify(
            inFlightReloads,
            (
              reloads,
            ): readonly [InstalledReload, Map<string, Deferred.Deferred<unknown, unknown>>] => {
              const existingReload = reloads.get(key) as Deferred.Deferred<A, E> | undefined;
              if (existingReload) {
                return [{ deferred: existingReload, owner: false }, reloads] as const;
              }
              const next = new Map(reloads);
              next.set(key, deferred as Deferred.Deferred<unknown, unknown>);
              return [{ deferred, owner: true }, next] as const;
            },
          );

          if (!installed.owner) {
            const subscriberCount = yield* getSubscriberCount(key);
            yield* Effect.logDebug("websocket snapshot reload coalesced", {
              key,
              subscriberCount,
            });
            return Option.some(yield* Deferred.await(installed.deferred));
          }

          yield* Ref.update(lastReloadStartedAt, (reloads) => {
            const next = new Map(reloads);
            next.set(key, startedAt);
            return next;
          });

          const subscriberCount = yield* getSubscriberCount(key);
          yield* Effect.logDebug("websocket snapshot reload started", {
            key,
            subscriberCount,
          });

          const exit = yield* Effect.exit(load);
          const finishedAt = yield* now;
          const loadDurationMs = Math.max(0, finishedAt - startedAt);

          yield* Ref.update(inFlightReloads, (reloads) => {
            if (reloads.get(key) !== deferred) return reloads;
            const next = new Map(reloads);
            next.delete(key);
            return next;
          });

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(deferred, exit.value).pipe(Effect.orDie);
            yield* Effect.logDebug("websocket snapshot reload completed", {
              key,
              subscriberCount,
              loadDurationMs,
            });
            return Option.some(exit.value);
          }

          yield* Deferred.failCause(deferred, exit.cause).pipe(Effect.orDie);
          yield* Effect.logWarning("websocket snapshot reload failed", {
            key,
            subscriberCount,
            loadDurationMs,
            cause: exit.cause,
          });
          return yield* Effect.failCause(exit.cause) as Effect.Effect<Option.Option<A>, E, never>;
        }),
    };
  });
