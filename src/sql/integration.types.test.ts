import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { bigint, pgTable, text } from "drizzle-orm/pg-core";
import { Config, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createSql } from "./repository.ts";
import { paginate } from "./paginate.ts";

/**
 * Compile-time check that the helpers accept the real thing.
 *
 * Nothing here connects to Postgres — the value of the file is that `tsc` proves
 * an `Effect.Service` wrapping `PgDrizzle.make()` satisfies `SqlExecutor`, that a
 * transaction handle does too, and that the requirement of a repository is the
 * app's own service tag.
 */

const users = pgTable("users", {
  id: bigint({ mode: "bigint" }).primaryKey(),
  name: text().notNull(),
});

const PgClientLive = PgClient.layerConfig({
  url: Config.redacted("DATABASE_URL"),
});

class DatabaseService extends Effect.Service<DatabaseService>()(
  "DatabaseService",
  {
    effect: PgDrizzle.make().pipe(Effect.provide(PgDrizzle.DefaultServices)),
    dependencies: [PgClientLive],
  },
) {}

const { buildRepository } = createSql(DatabaseService);

const insertOne = Effect.gen(function* () {
  const repository = yield* buildRepository(users);

  return yield* repository.insert({ id: 1n, name: "Alice" });
});

// The repository's only requirement is the app's own service.
const _requiresDatabaseService: Effect.Effect<
  { id: bigint; name: string } | null,
  any,
  DatabaseService
> = insertOne;

const insertTwoInOneTransaction = Effect.gen(function* () {
  const database = yield* DatabaseService;
  const repository = yield* buildRepository(users);

  return yield* database.transaction((transaction) =>
    Effect.gen(function* () {
      yield* repository.withTx(transaction).insert({ id: 1n, name: "Alice" });

      return yield* repository.withTx(transaction).insert({
        id: 2n,
        name: "Bob",
      });
    }),
  );
});

const paginateOverTheService = Effect.gen(function* () {
  const database = yield* DatabaseService;

  return yield* paginate<typeof users.$inferSelect>(
    database,
    database.select().from(users),
    { page: 1, pageSize: 20 },
  );
});

describe("sql helpers against the real Drizzle Effect database", () => {
  it("type-checks without connecting", () => {
    expect(typeof buildRepository).toBe("function");
    expect(insertTwoInOneTransaction).toBeDefined();
    expect(paginateOverTheService).toBeDefined();
    expect(_requiresDatabaseService).toBeDefined();
  });
});
