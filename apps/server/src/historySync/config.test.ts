import {
  DEFAULT_SERVER_SETTINGS,
  type HistorySyncStatus,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { Effect, Exit, Ref, Stream } from "effect";
import { describe, expect, test } from "vitest";

import {
  SecretStoreError,
  type ServerSecretStoreShape,
} from "../auth/Services/ServerSecretStore.ts";
import type { ServerSettingsShape } from "../serverSettings.ts";
import { createHistorySyncConfigController } from "./config.ts";
import type { HistorySyncStateRow } from "./localRepository.ts";

function makeSecretStore(input: {
  readonly value?: string | null;
  readonly failGet?: boolean;
}): ServerSecretStoreShape {
  let value = input.value ?? null;
  return {
    get: () =>
      input.failGet
        ? Effect.fail(new SecretStoreError({ message: "read failed" }))
        : Effect.succeed(value === null ? null : new TextEncoder().encode(value)),
    set: (_name, nextValue) =>
      Effect.sync(() => {
        value = new TextDecoder().decode(nextValue);
      }),
    getOrCreateRandom: () => Effect.succeed(new Uint8Array([1])),
    remove: () =>
      Effect.sync(() => {
        value = null;
      }),
  };
}

function makeSettingsService(initial: ServerSettings): ServerSettingsShape {
  let settings = initial;
  return {
    start: Effect.void,
    ready: Effect.void,
    getSettings: Effect.sync(() => settings),
    updateSettings: (patch: ServerSettingsPatch) =>
      Effect.sync(() => {
        settings = {
          ...settings,
          historySync: {
            ...settings.historySync,
            ...patch.historySync,
          },
        };
        return settings;
      }),
    streamChanges: Stream.empty,
  };
}

function makeController(input: {
  readonly secretValue?: string | null;
  readonly failSecretGet?: boolean;
  readonly settings?: ServerSettings;
  readonly status?: HistorySyncStatus;
  readonly state?: HistorySyncStateRow | null;
}) {
  return Effect.gen(function* () {
    const statusRef = yield* Ref.make<HistorySyncStatus>(
      input.status ?? { state: "disabled", configured: false },
    );
    const published: HistorySyncStatus[] = [];
    const controller = createHistorySyncConfigController({
      secretStore: makeSecretStore({
        value: input.secretValue ?? null,
        ...(input.failSecretGet !== undefined ? { failGet: input.failSecretGet } : {}),
      }),
      settingsService: makeSettingsService(input.settings ?? DEFAULT_SERVER_SETTINGS),
      statusRef,
      readState: Effect.succeed(input.state ?? null),
      readBackupSummary: Effect.succeed(null),
      publishStatus: (status) =>
        Effect.sync(() => {
          published.push(status);
        }).pipe(Effect.andThen(Ref.set(statusRef, status))),
      clearStopped: () => Effect.void,
      syncNow: () => Effect.void,
    });
    return { controller, published };
  });
}

describe("history sync config controller", () => {
  test("treats secret read failures as unconfigured", async () => {
    const { controller } = await Effect.runPromise(
      makeController({ secretValue: "mysql://user:pass@localhost/db", failSecretGet: true }),
    );

    await expect(Effect.runPromise(controller.getConnectionString)).resolves.toBeNull();
  });

  test("config snapshot reports needs-initial-sync for configured incomplete state", async () => {
    const { controller } = await Effect.runPromise(
      makeController({
        secretValue: "mysql://user:pass@localhost/db",
        status: { state: "disabled", configured: true },
        state: {
          hasCompletedInitialSync: 0,
          lastSyncedRemoteSequence: 0,
          lastSuccessfulSyncAt: "2026-05-01T00:00:00.000Z",
        },
      }),
    );

    await expect(Effect.runPromise(controller.toConfig)).resolves.toMatchObject({
      configured: true,
      status: {
        state: "needs-initial-sync",
        configured: true,
        lastSyncedAt: "2026-05-01T00:00:00.000Z",
      },
    });
  });

  test("config snapshot includes durable initial sync recovery metadata", async () => {
    const { controller } = await Effect.runPromise(
      makeController({
        secretValue: "mysql://user:pass@localhost/db",
        status: { state: "error", configured: true, message: "failed", lastSyncedAt: null },
        state: {
          hasCompletedInitialSync: 0,
          lastSyncedRemoteSequence: 0,
          lastSuccessfulSyncAt: null,
          initialSyncPhase: "import-remote",
          initialSyncStartedAt: "2026-05-01T00:00:00.000Z",
          initialSyncError: "2026-05-01T00:01:00.000Z: import failed",
        },
      }),
    );

    await expect(Effect.runPromise(controller.toConfig)).resolves.toMatchObject({
      initialSyncRecovery: {
        phase: "import-remote",
        startedAt: "2026-05-01T00:00:00.000Z",
        error: "2026-05-01T00:01:00.000Z: import failed",
      },
    });
  });

  test("rejects clear and mysql update in the same request", async () => {
    const { controller } = await Effect.runPromise(makeController({}));
    const exit = await Effect.runPromiseExit(
      controller.updateConfig({
        clearConnection: true,
        mysql: {
          host: "localhost",
          port: 3306,
          database: "history",
          username: "user",
          password: "secret",
          tlsEnabled: false,
        },
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain(
        "Cannot clear and update the MySQL connection in the same request.",
      );
    }
  });

  test("connection test returns failure for invalid mysql fields", async () => {
    const { controller } = await Effect.runPromise(makeController({}));

    await expect(
      Effect.runPromise(
        controller.testConnection({
          host: "",
          port: 3306,
          database: "history",
          username: "user",
          password: "secret",
          tlsEnabled: false,
        }),
      ),
    ).resolves.toMatchObject({
      success: false,
      message: "MySQL host is required.",
    });
  });

  test("startup publishes needs-initial-sync when configured before initial sync", async () => {
    const { controller, published } = await Effect.runPromise(
      makeController({
        secretValue: "mysql://user:pass@localhost/db",
        state: {
          hasCompletedInitialSync: 0,
          lastSyncedRemoteSequence: 0,
          lastSuccessfulSyncAt: null,
        },
      }),
    );

    await expect(Effect.runPromise(controller.publishConfiguredStartupStatus)).resolves.toBe(false);
    expect(published).toEqual([
      { state: "needs-initial-sync", configured: true, lastSyncedAt: null },
    ]);
  });
});
