/**
 * DrainableWorker - A queue-based worker that exposes a `drain()` effect.
 *
 * Wraps the common `Queue.unbounded` + `Effect.forever` pattern and adds
 * a signal that resolves when the queue is empty **and** the current item
 * has finished processing. This lets tests replace timing-sensitive
 * `Effect.sleep` calls with deterministic `drain()`.
 *
 * @module DrainableWorker
 */
import type { Scope } from "effect";
import { Effect, Exit, TxQueue, TxRef } from "effect";

import type { WorkerHealthSnapshot } from "./WorkerHealth.ts";

export interface DrainableWorkerOptions {
  /**
   * Maximum queued items. Defaults to the previous unbounded behavior for
   * compatibility; server reactors should pass an explicit budget.
   */
  readonly capacity?: number;
}

export interface DrainableWorker<A> {
  /**
   * Enqueue a work item and track it for `drain()`.
   *
   * Returns `true` when the item was accepted by the queue. Bounded queues
   * normally backpressure instead of rejecting, but rejected offers are surfaced
   * for shutdown or future queue policies.
   */
  readonly enqueue: (item: A) => Effect.Effect<boolean>;

  /**
   * Number of queued or actively processing items tracked by this worker.
   */
  readonly backlog: Effect.Effect<number>;

  /**
   * Low-cost runtime health snapshot for operational diagnostics.
   */
  readonly health: Effect.Effect<WorkerHealthSnapshot>;

  /**
   * Resolves when the queue is empty and the worker is idle (not processing).
   */
  readonly drain: Effect.Effect<void>;
}

interface DrainableWorkerState {
  readonly queuedAtMs: ReadonlyArray<number>;
  readonly activeStartedAtMs: number | null;
  readonly attempted: number;
  readonly accepted: number;
  readonly processed: number;
  readonly failed: number;
  readonly dropped: number;
}

const initialState: DrainableWorkerState = {
  queuedAtMs: [],
  activeStartedAtMs: null,
  attempted: 0,
  accepted: 0,
  processed: 0,
  failed: 0,
  dropped: 0,
};

/**
 * Create a drainable worker that processes items from an unbounded queue.
 *
 * The worker is forked into the current scope and will be interrupted when
 * the scope closes. A finalizer shuts down the queue.
 *
 * @param process - The effect to run for each queued item.
 * @returns A `DrainableWorker` with `queue` and `drain`.
 */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
  options: DrainableWorkerOptions = {},
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(
      typeof options.capacity === "number"
        ? TxQueue.bounded<A>(options.capacity)
        : TxQueue.unbounded<A>(),
      TxQueue.shutdown,
    );
    const stateRef = yield* TxRef.make<DrainableWorkerState>(initialState);

    yield* TxQueue.take(queue).pipe(
      Effect.tap((a) =>
        TxRef.update(stateRef, (state) => ({
          ...state,
          queuedAtMs: state.queuedAtMs.slice(1),
          activeStartedAtMs: Date.now(),
        })).pipe(
          Effect.tx,
          Effect.andThen(process(a).pipe(Effect.exit)),
          Effect.flatMap((exit) =>
            TxRef.update(stateRef, (state) => ({
              ...state,
              activeStartedAtMs: null,
              processed: Exit.isSuccess(exit) ? state.processed + 1 : state.processed,
              failed: Exit.isFailure(exit) ? state.failed + 1 : state.failed,
            })).pipe(
              Effect.tx,
              Effect.andThen(Exit.isSuccess(exit) ? Effect.void : Effect.failCause(exit.cause)),
            ),
          ),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const backlog: DrainableWorker<A>["backlog"] = TxRef.get(stateRef).pipe(
      Effect.map((state) => state.queuedAtMs.length + (state.activeStartedAtMs === null ? 0 : 1)),
      Effect.tx,
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(stateRef).pipe(
      Effect.tap((state) =>
        state.queuedAtMs.length > 0 || state.activeStartedAtMs !== null
          ? Effect.txRetry
          : Effect.void,
      ),
      Effect.asVoid,
      Effect.tx,
    );

    const enqueue: DrainableWorker<A>["enqueue"] = (element) =>
      TxRef.update(stateRef, (state) => ({ ...state, attempted: state.attempted + 1 })).pipe(
        Effect.tx,
        Effect.andThen(
          TxQueue.offer(queue, element).pipe(
            Effect.flatMap((accepted) =>
              TxRef.update(stateRef, (state) => ({
                ...state,
                accepted: accepted ? state.accepted + 1 : state.accepted,
                dropped: accepted ? state.dropped : state.dropped + 1,
                queuedAtMs: accepted ? [...state.queuedAtMs, Date.now()] : state.queuedAtMs,
              })).pipe(Effect.as(accepted)),
            ),
            Effect.tx,
          ),
        ),
      );

    const health: DrainableWorker<A>["health"] = TxRef.get(stateRef).pipe(
      Effect.map((state) => {
        const now = Date.now();
        const active = state.activeStartedAtMs === null ? 0 : 1;
        const oldestItemAt =
          state.activeStartedAtMs === null
            ? state.queuedAtMs[0]
            : Math.min(state.activeStartedAtMs, state.queuedAtMs[0] ?? state.activeStartedAtMs);

        return {
          capacity: options.capacity ?? null,
          backlog: state.queuedAtMs.length + active,
          queued: state.queuedAtMs.length,
          active,
          oldestItemAgeMs: oldestItemAt === undefined ? null : Math.max(0, now - oldestItemAt),
          attempted: state.attempted,
          accepted: state.accepted,
          processed: state.processed,
          failed: state.failed,
          dropped: state.dropped,
          coalesced: 0,
        } satisfies WorkerHealthSnapshot;
      }),
      Effect.tx,
    );

    return { enqueue, drain, backlog, health } satisfies DrainableWorker<A>;
  });
