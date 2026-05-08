import { Effect, Queue, Stream } from "effect";
import type {
  OrchestrationCommandOutputDelta,
  OrchestrationCommandOutputSnapshot,
} from "@t3tools/contracts";
import {
  appendCommandOutputBufferDelta,
  replaceCommandOutputBufferSnapshot,
} from "./CommandOutputBuffer.ts";

type Subscriber = (delta: OrchestrationCommandOutputDelta) => Effect.Effect<void>;
type SnapshotSubscriber = (snapshot: OrchestrationCommandOutputSnapshot) => Effect.Effect<void>;

const subscribers = new Set<Subscriber>();
const snapshotSubscribers = new Set<SnapshotSubscriber>();

export const publishCommandOutputDelta = (delta: OrchestrationCommandOutputDelta) =>
  appendCommandOutputBufferDelta(delta).pipe(
    Effect.andThen(
      Effect.forEach(subscribers, (subscriber) => subscriber(delta), {
        concurrency: "unbounded",
        discard: true,
      }),
    ),
  );

export const publishCommandOutputSnapshot = (snapshot: OrchestrationCommandOutputSnapshot) =>
  replaceCommandOutputBufferSnapshot(snapshot).pipe(
    Effect.andThen(
      Effect.forEach(snapshotSubscribers, (subscriber) => subscriber(snapshot), {
        concurrency: "unbounded",
        discard: true,
      }),
    ),
  );

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

export const commandOutputSnapshotStream: Stream.Stream<OrchestrationCommandOutputSnapshot> =
  Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const subscriber: SnapshotSubscriber = (snapshot) =>
          Queue.offer(queue, snapshot).pipe(Effect.asVoid);
        snapshotSubscribers.add(subscriber);
        return subscriber;
      }),
      (subscriber) => Effect.sync(() => snapshotSubscribers.delete(subscriber)),
    ),
  );
