import { eq, getColumns } from "drizzle-orm";
import type {
  PgColumn,
  PgTable,
  PgTableWithColumns,
  TableConfig,
} from "drizzle-orm/pg-core";
import { Context, Effect } from "effect";
import type { SqlExecutor } from "./executor.ts";

type TableWithIdConfig = TableConfig & {
  columns: {
    id: PgColumn<any>;
  };
};

const makeOps = <T extends TableWithIdConfig>(
  executor: SqlExecutor,
  table: PgTable<T>,
) => {
  type Out = PgTableWithColumns<T>["$inferSelect"];
  type In = PgTableWithColumns<T>["$inferInsert"];

  const columns = getColumns(table);

  return {
    insert: (value: In) =>
      executor
        .insert(table)
        .values(value)
        .returning()
        .pipe(Effect.map((result) => (result as Out[])[0] ?? null)),
    update: (id: Out["id"], value: Partial<In>) =>
      executor
        .update(table)
        .set(value)
        .where(eq(columns.id, id))
        .returning()
        .pipe(Effect.map((result) => (result as any as Out[])[0] ?? null)),
    delete: (id: Out["id"]) => executor.delete(table).where(eq(columns.id, id)),
  };
};

/**
 * The write operations a repository exposes, bound to one executor.
 *
 * Derived from `makeOps` rather than written out, so the error and requirement
 * channels stay exactly what Drizzle produces instead of being widened to `any`.
 */
export type RepositoryOps<T extends TableWithIdConfig> = ReturnType<
  typeof makeOps<T>
>;

/** A repository: the write operations, plus a way to rebind them to a transaction. */
export type Repository<T extends TableWithIdConfig> = RepositoryOps<T> & {
  /**
   * Returns the same operations issued through a running transaction.
   *
   * @param transaction - The handle given by `db.transaction`.
   */
  withTx: (transaction: SqlExecutor) => RepositoryOps<T>;
};

/**
 * Binds the SQL helpers to the application's database service.
 *
 * Keel never owns the database connection: how the pool is configured, which
 * environment variable holds the URL, and which `pg` type parsers are overridden
 * are all application decisions. The app builds its own service and hands the tag
 * over, exactly as it hands its `ManagedRuntime` to `createKeel` — the tag then
 * flows into the requirements of every repository built here.
 *
 * @param Database - The tag of the application's Drizzle Effect database service.
 * @returns The helpers bound to that tag.
 *
 * @example
 * ```ts
 * // shared/app/sql.ts
 * import { createSql } from "@kylobyte/keel/sql";
 * import { DatabaseService } from "../../services/database/database.service.ts";
 *
 * export const { buildRepository } = createSql(DatabaseService);
 * ```
 */
export const createSql = <Self, Database extends SqlExecutor>(
  Database: Context.Tag<Self, Database>,
) => {
  /**
   * Builds a write-only repository for a given Drizzle table.
   *
   * Provides `insert`, `update` and `delete`, plus `withTx` to reissue any of
   * them inside a transaction. All read queries — including simple ID lookups —
   * belong in feature-specific query services that use the database service
   * directly.
   *
   * @param table - The Drizzle table to build the repository for.
   * @returns An Effect producing the repository, requiring the database service.
   *
   * @example
   * ```ts
   * export class UserRepositoryService extends Effect.Service<UserRepositoryService>()(
   *   "repository/User",
   *   {
   *     effect: buildRepository(users),
   *     dependencies: [DatabaseService.Default],
   *   },
   * ) {}
   *
   * // inside a transaction
   * yield* db.transaction((tx) =>
   *   Effect.gen(function* () {
   *     const plan = yield* planRepo.withTx(tx).insert(values);
   *     yield* priceRepo.withTx(tx).insert({ planId: plan.id, ...price });
   *   }),
   * );
   * ```
   */
  const buildRepository = <T extends TableWithIdConfig>(
    table: PgTable<T>,
  ): Effect.Effect<Repository<T>, never, Self> =>
    Effect.gen(function* () {
      const database = yield* Database;

      return {
        ...makeOps<T>(database, table),
        withTx: (transaction: SqlExecutor) => makeOps<T>(transaction, table),
      };
    });

  return { buildRepository };
};
