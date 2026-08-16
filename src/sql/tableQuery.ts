import { Effect, Schema as S } from "effect";
import { asc, desc } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Flat schema for standard table query params — validated at the HTTP boundary.
 * Spread into route-specific query schemas and extend with per-resource filters.
 *
 * @example
 * ```ts
 * export const UserQuerySchema = S.Struct({
 *   ...tableQueryFields,
 *   sort: S.optional(S.Literal("name", "email", "createdAt")),
 *   filter: S.optional(parseJsonParam(UserFilterSchema)),
 * });
 * ```
 */
export const tableQueryFields = {
  sort: S.optional(S.String),
  dir: S.optional(S.Literals(["asc", "desc"])),
  q: S.optional(S.String),
  page: S.optional(S.NumberFromString.pipe(S.check(S.isGreaterThan(0)))).pipe(
    S.withDecodingDefaultType(Effect.succeed(DEFAULT_PAGE)),
  ),
  pageSize: S.optional(
    S.NumberFromString.pipe(
      S.check(S.isBetween({ minimum: 0, maximum: MAX_PAGE_SIZE })),
    ),
  ).pipe(S.withDecodingDefaultType(Effect.succeed(DEFAULT_PAGE_SIZE))),
};

export const TableQuerySchema = S.Struct(tableQueryFields);
export type TableQuery = S.Schema.Type<typeof TableQuerySchema>;

/**
 * Grouped types used internally (controller → query service layer).
 */
export type TableQuerySorting = { sort?: string; dir?: "asc" | "desc" };
export type TableQueryFilters = { q?: string };
export type TableQueryPagination = { page: number; pageSize: number };

/**
 * Maps `{ sort: 'name', dir: 'asc' }` to a Drizzle ORDER BY expression.
 *
 * The column set is the allow-list: a `sort` naming anything outside it yields
 * `undefined` rather than an error, so the caller falls back to its own default
 * ordering instead of failing the request.
 *
 * @param columns - The sortable columns, keyed by the name accepted on the wire.
 * @param sorting - The decoded `sort`/`dir` pair.
 * @returns The ORDER BY expression, or undefined when there is nothing to sort by.
 */
export const buildOrderBy = (
  columns: Record<string, PgColumn<any>>,
  sorting: TableQuerySorting,
): SQL | undefined => {
  if (!sorting.sort) return undefined;

  const column = columns[sorting.sort];
  if (!column) return undefined;

  return sorting.dir === "desc" ? desc(column) : asc(column);
};
