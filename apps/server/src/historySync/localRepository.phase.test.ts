import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  clearInitialSyncPhase,
  failInitialSyncPhase,
  readState,
  setInitialSyncPhase,
} from "./localRepository.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("history sync local repository phase helpers", (it) => {
  it.effect("sets, fails, and clears initial sync phase metadata", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 36 });

      yield* setInitialSyncPhase(sql, {
        phase: "backup",
        startedAt: "2026-05-01T00:00:00.000Z",
      });
      yield* setInitialSyncPhase(sql, {
        phase: "import-remote",
        startedAt: "2026-05-01T00:01:00.000Z",
      });
      yield* failInitialSyncPhase(sql, {
        error: "import failed",
        failedAt: "2026-05-01T00:02:00.000Z",
      });

      const failedState = yield* readState(sql);
      assert.strictEqual(failedState?.initialSyncPhase, "import-remote");
      assert.strictEqual(failedState?.initialSyncStartedAt, "2026-05-01T00:00:00.000Z");
      assert.strictEqual(failedState?.initialSyncError, "2026-05-01T00:02:00.000Z: import failed");

      yield* clearInitialSyncPhase(sql);

      const clearedState = yield* readState(sql);
      assert.strictEqual(clearedState?.initialSyncPhase, null);
      assert.strictEqual(clearedState?.initialSyncStartedAt, null);
      assert.strictEqual(clearedState?.initialSyncError, null);
    }),
  );
});
