import { sql } from "drizzle-orm";
import { Effect } from "effect";
import type { SqlExecutor } from "./executor.ts";
import type { TableQueryPagination } from "./tableQuery.ts";
import type { PaginatedResponse } from "./paginatedResponse.ts";

/**
 * The shape `paginate` needs from a Drizzle select builder.
 *
 * Kept structural on purpose: every builder in the chain (`select().from()`,
 * `.where()`, `.orderBy()`, a join chain) satisfies it without the caller having
 * to name the concrete generic type.
 */
export type PaginatableQuery = {
  as: (alias: string) => any;
  limit: (value: number) => any;
  offset: (value: number) => any;
};

/**
 * Runs a query as a page, alongside the total row count of the same query.
 *
 * The count runs over `baseQuery` wrapped as a subquery, so it counts the
 * filtered — but unpaginated — result set. Note that `.as()` snapshots the SQL
 * while `.limit()`/`.offset()` mutate the builder in place: the subquery must be
 * taken *before* the page bounds are applied, or the count starts agreeing with
 * `items.length` on every page.
 *
 * Both queries are issued concurrently on the same executor.
 *
 * @param executor - The database service, or a transaction handle.
 * @param baseQuery - The fully built query, filtered and ordered but unpaginated.
 * @param pagination - The decoded `page`/`pageSize` pair.
 * @returns An Effect producing the page and the total.
 *
 * @example
 * ```ts
 * paginate<DbUser>(
 *   db,
 *   db.select().from(users).where(where).orderBy(orderBy),
 *   pagination,
 * );
 * ```
 */
export const paginate = <TResult>(
  executor: SqlExecutor,
  baseQuery: PaginatableQuery,
  pagination: TableQueryPagination,
) =>
  Effect.gen(function* () {
    const subquery = baseQuery.as("paginated");

    const countEffect = executor
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(subquery)
      .pipe(Effect.map((rows) => rows[0] ?? { count: 0 }));

    const selectEffect: Effect.Effect<any> = baseQuery
      .limit(pagination.pageSize)
      .offset((pagination.page - 1) * pagination.pageSize);

    const [{ count }, items] = yield* Effect.all([countEffect, selectEffect], {
      concurrency: 2,
    });

    return {
      items: items as TResult[],
      total: count,
      page: pagination.page,
      pageSize: pagination.pageSize,
    } satisfies PaginatedResponse<TResult>;
  });
