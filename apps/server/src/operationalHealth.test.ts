import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderSession,
  type ServerLifecycleStreamEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Stream } from "effect";

import { collectOperationalHealth } from "./operationalHealth.ts";
import { OrchestrationEventStore } from "./persistence/Services/OrchestrationEventStore.ts";
import { ProjectionStateRepository } from "./persistence/Services/ProjectionState.ts";
import { ProviderService } from "./provider/Services/ProviderService.ts";
import { ServerLifecycleEvents } from "./serverLifecycleEvents.ts";

it.effect("collects projection lag, active provider sessions, and startup readiness", () =>
  Effect.gen(function* () {
    const snapshot = yield* collectOperationalHealth.pipe(
      Effect.provideService(OrchestrationEventStore, {
        append: () => Effect.die("unused"),
        readFromSequence: () => Stream.empty,
        readAll: () => Stream.empty,
        getMaxSequence: () => Effect.succeed(12),
      }),
      Effect.provideService(ProjectionStateRepository, {
        upsert: () => Effect.die("unused"),
        getByProjector: () => Effect.die("unused"),
        minLastAppliedSequence: () => Effect.die("unused"),
        listAll: () =>
          Effect.succeed([
            {
              projector: "projection.threads",
              lastAppliedSequence: 10,
              updatedAt: "2026-05-05T10:00:00.000Z",
            },
            {
              projector: "projection.thread-messages",
              lastAppliedSequence: 8,
              updatedAt: "2026-05-05T10:01:00.000Z",
            },
          ]),
      }),
      Effect.provideService(ProviderService, {
        startSession: () => Effect.die("unused"),
        sendTurn: () => Effect.die("unused"),
        interruptTurn: () => Effect.die("unused"),
        respondToRequest: () => Effect.die("unused"),
        respondToUserInput: () => Effect.die("unused"),
        stopSession: () => Effect.die("unused"),
        recoverSession: () => Effect.die("unused"),
        listSessions: () =>
          Effect.succeed([
            {
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId: ProviderInstanceId.make("codex"),
              status: "running",
              runtimeMode: "full-access",
              threadId: ThreadId.make("thread-1"),
              activeTurnId: TurnId.make("turn-1"),
              createdAt: "2026-05-05T09:00:00.000Z",
              updatedAt: "2026-05-05T09:30:00.000Z",
            },
            {
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId: ProviderInstanceId.make("codex"),
              status: "ready",
              runtimeMode: "full-access",
              threadId: ThreadId.make("thread-2"),
              createdAt: "2026-05-05T09:05:00.000Z",
              updatedAt: "2026-05-05T09:35:00.000Z",
            },
          ] satisfies ReadonlyArray<ProviderSession>),
        getCapabilities: () => Effect.die("unused"),
        getInstanceInfo: () => Effect.die("unused"),
        rollbackConversation: () => Effect.die("unused"),
        streamEvents: Stream.empty,
      }),
      Effect.provideService(ServerLifecycleEvents, {
        publish: () => Effect.die("unused"),
        snapshot: Effect.succeed({
          sequence: 2,
          events: [
            {
              version: 1,
              sequence: 2,
              type: "ready",
              payload: {
                at: "2026-05-05T10:02:00.000Z",
                environment: {
                  environmentId: EnvironmentId.make("env-test"),
                  label: "Test",
                  platform: { os: "darwin", arch: "arm64" },
                  serverVersion: "0.0.0-test",
                  capabilities: { repositoryIdentity: true },
                },
              },
            },
          ] satisfies ReadonlyArray<ServerLifecycleStreamEvent>,
        }),
        stream: Stream.empty,
      }),
    );

    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.projection.maxEventSequence, 12);
    assert.equal(snapshot.projection.minAppliedSequence, 8);
    assert.equal(snapshot.projection.lagEvents, 4);
    assert.deepStrictEqual(
      snapshot.projection.projectors.map((projector) => [projector.projector, projector.lagEvents]),
      [
        ["projection.threads", 2],
        ["projection.thread-messages", 4],
      ],
    );
    assert.equal(snapshot.providerSessions.activeCount, 2);
    assert.equal(snapshot.providerSessions.byProvider[ProviderDriverKind.make("codex")], 2);
    assert.equal(snapshot.providerSessions.byProviderInstance[ProviderInstanceId.make("codex")], 2);
    assert.equal(snapshot.providerSessions.activeTurnCount, 1);
    assert.deepStrictEqual(snapshot.queues, {
      orchestrationCommandBacklog: null,
      projectionBacklog: null,
    });
    assert.equal(snapshot.startup.ready, true);
    assert.equal(snapshot.startup.readyAt, "2026-05-05T10:02:00.000Z");
  }),
);
