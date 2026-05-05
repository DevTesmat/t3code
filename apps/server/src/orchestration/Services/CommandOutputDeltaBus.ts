import { Effect, Queue, Stream } from "effect";
import type { OrchestrationCommandOutputDelta } from "@t3tools/contracts";

type Subscriber = (delta: OrchestrationCommandOutputDelta) => Effect.Effect<void>;

const subscribers = new Set<Subscriber>();

export const publishCommandOutputDelta = (delta: OrchestrationCommandOutputDelta) =>
  Effect.forEach(subscribers, (subscriber) => subscriber(delta), {
    concurrency: "unbounded",
    discard: true,
  });

export const commandOutputDeltaStream: Stream.Stream<OrchestrationCommandOutputDelta> =
  Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const subscriber: Subscriber = (delta) => Queue.offer(queue, delta).pipe(Effect.asVoid);
        subscribers.add(subscriber);
        return subscriber;
      }),
      (subscriber) => Effect.sync(() => subscribers.delete(subscriber)),
    ),
  );
