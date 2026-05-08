import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

function resetEntries(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    yield* sql`DROP TABLE IF EXISTS entries`;
    yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
  });
}

function readEntryCount(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS "count"
      FROM entries
    `;
    return Number(rows[0]?.count ?? 0);
  });
}

layer("NodeSqliteClient", (it) => {
  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* resetEntries(sql);
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");
    }),
  );

  it.effect("commits successful transactions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* resetEntries(sql);

      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO entries(name) VALUES (${"alpha"})`;
          yield* sql`INSERT INTO entries(name) VALUES (${"beta"})`;
        }),
      );

      assert.equal(yield* readEntryCount(sql), 2);
    }),
  );

  it.effect("rolls back transactions on typed failure", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* resetEntries(sql);

      const exit = yield* Effect.exit(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO entries(name) VALUES (${"alpha"})`;
            return yield* Effect.fail("typed failure");
          }),
        ),
      );

      assert.equal(Exit.isFailure(exit), true);
      assert.equal(yield* readEntryCount(sql), 0);
    }),
  );

  it.effect("rolls back transactions on defects", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* resetEntries(sql);

      const exit = yield* Effect.exit(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO entries(name) VALUES (${"alpha"})`;
            return yield* Effect.die("defect");
          }),
        ),
      );

      assert.equal(Exit.isFailure(exit), true);
      assert.equal(yield* readEntryCount(sql), 0);
    }),
  );

  it.effect("rolls back interrupted transactions and releases the semaphore", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* resetEntries(sql);
      const inserted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const fiber = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO entries(name) VALUES (${"alpha"})`;
            yield* Deferred.succeed(inserted, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkScoped);

      yield* Deferred.await(inserted);
      yield* Fiber.interrupt(fiber);

      assert.equal(yield* readEntryCount(sql), 0);
      yield* sql`INSERT INTO entries(name) VALUES (${"after-interrupt"})`;
      assert.equal(yield* readEntryCount(sql), 1);
    }),
  );

  it.effect("reuses the active connection for nested transactions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* resetEntries(sql);

      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO entries(name) VALUES (${"outer"})`;
          const innerExit = yield* Effect.exit(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO entries(name) VALUES (${"inner"})`;
                return yield* Effect.fail("inner failure");
              }),
            ),
          );
          assert.equal(Exit.isFailure(innerExit), true);
          yield* sql`INSERT INTO entries(name) VALUES (${"after-inner"})`;
        }),
      );

      const rows = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM entries
        ORDER BY id
      `;
      assert.deepEqual(
        rows.map((row) => row.name),
        ["outer", "inner", "after-inner"],
      );
    }),
  );
});
