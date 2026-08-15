import { Context, Effect } from "effect";
import { eq } from "drizzle-orm";
import { bigint, PgDialect, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { createSql } from "./repository.ts";
import type { SqlExecutor } from "./executor.ts";

const users = pgTable("users", {
  id: bigint({ mode: "bigint" }).primaryKey(),
  name: text().notNull(),
});

type DbUser = typeof users.$inferSelect;

const alice: DbUser = { id: 1n, name: "Alice" };

const dialect = new PgDialect();
const toSql = (query: unknown) => dialect.sqlToQuery(query as never).sql;

type RecordedCall = {
  operation: "insert" | "update" | "delete";
  table: unknown;
  values?: unknown;
  where?: unknown;
};

/**
 * A stand-in for the Drizzle Effect database that records the builder chain
 * instead of talking to Postgres. Both the database service and a transaction
 * handle are the same shape, so one fake covers `insert` and `withTx(tx).insert`.
 */
const makeFakeExecutor = (rows: DbUser[] = [alice]) => {
  const calls: RecordedCall[] = [];

  const executor = {
    insert: (table: unknown) => ({
      values: (values: unknown) => ({
        returning: () => {
          calls.push({ operation: "insert", table, values });

          return Effect.succeed(rows);
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: unknown) => ({
        where: (where: unknown) => ({
          returning: () => {
            calls.push({ operation: "update", table, values, where });

            return Effect.succeed(rows);
          },
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: (where: unknown) => {
        calls.push({ operation: "delete", table, where });

        return Effect.succeed(undefined);
      },
    }),
  } as unknown as SqlExecutor;

  return { executor, calls };
};

class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  SqlExecutor
>() {}

const { buildRepository } = createSql(DatabaseService);

const runWith = <A, E>(
  executor: SqlExecutor,
  effect: Effect.Effect<A, E, DatabaseService>,
) => Effect.runSync(Effect.provideService(effect, DatabaseService, executor));

describe("buildRepository", () => {
  it("inserts and returns the first row", () => {
    const { executor, calls } = makeFakeExecutor();

    const inserted = runWith(
      executor,
      Effect.gen(function* () {
        const repository = yield* buildRepository(users);

        return yield* repository.insert({ id: 1n, name: "Alice" });
      }),
    );

    expect(inserted).toEqual(alice);
    expect(calls).toEqual([
      { operation: "insert", table: users, values: { id: 1n, name: "Alice" } },
    ]);
  });

  it("returns null when the insert produces no row", () => {
    const { executor } = makeFakeExecutor([]);

    const inserted = runWith(
      executor,
      Effect.gen(function* () {
        const repository = yield* buildRepository(users);

        return yield* repository.insert({ id: 1n, name: "Alice" });
      }),
    );

    expect(inserted).toBeNull();
  });

  it("updates the row matching the id", () => {
    const { executor, calls } = makeFakeExecutor();

    const updated = runWith(
      executor,
      Effect.gen(function* () {
        const repository = yield* buildRepository(users);

        return yield* repository.update(1n, { name: "Alice II" });
      }),
    );

    expect(updated).toEqual(alice);
    expect(calls[0]).toMatchObject({
      operation: "update",
      values: { name: "Alice II" },
    });
    expect(toSql(calls[0]!.where)).toBe(toSql(eq(users.id, 1n)));
  });

  it("returns null when the update matches no row", () => {
    const { executor } = makeFakeExecutor([]);

    const updated = runWith(
      executor,
      Effect.gen(function* () {
        const repository = yield* buildRepository(users);

        return yield* repository.update(1n, { name: "Alice II" });
      }),
    );

    expect(updated).toBeNull();
  });

  it("deletes the row matching the id", () => {
    const { executor, calls } = makeFakeExecutor();

    runWith(
      executor,
      Effect.gen(function* () {
        const repository = yield* buildRepository(users);

        return yield* repository.delete(1n);
      }),
    );

    expect(calls[0]).toMatchObject({ operation: "delete", table: users });
    expect(toSql(calls[0]!.where)).toBe(toSql(eq(users.id, 1n)));
  });
});

describe("buildRepository withTx", () => {
  it("issues the operations through the transaction, not the database", () => {
    const database = makeFakeExecutor();
    const transaction = makeFakeExecutor();

    runWith(
      database.executor,
      Effect.gen(function* () {
        const repository = yield* buildRepository(users);

        return yield* repository.withTx(transaction.executor).insert({
          id: 1n,
          name: "Alice",
        });
      }),
    );

    expect(database.calls).toEqual([]);
    expect(transaction.calls).toEqual([
      { operation: "insert", table: users, values: { id: 1n, name: "Alice" } },
    ]);
  });

  it("leaves the database-bound operations usable alongside it", () => {
    const database = makeFakeExecutor();
    const transaction = makeFakeExecutor();

    runWith(
      database.executor,
      Effect.gen(function* () {
        const repository = yield* buildRepository(users);

        yield* repository.withTx(transaction.executor).delete(1n);

        return yield* repository.delete(2n);
      }),
    );

    expect(toSql(transaction.calls[0]!.where)).toBe(toSql(eq(users.id, 1n)));
    expect(toSql(database.calls[0]!.where)).toBe(toSql(eq(users.id, 2n)));
  });
});
