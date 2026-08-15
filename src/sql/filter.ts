import { Schema as S } from "effect";
import { and } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/** A single filter field: how it is validated, and how it becomes SQL. */
export type FieldDef<A> = {
  schema: S.Schema<A, any, never>;
  toSQL: (value: A) => SQL;
};

/**
 * Pairs an Effect Schema with the Drizzle condition it produces.
 *
 * @param schema - The schema the incoming value is decoded with.
 * @param toSQL - Builds the condition from the decoded value.
 * @returns The field definition consumed by `defineFilter`.
 */
export const field = <A, I>(
  schema: S.Schema<A, I, never>,
  toSQL: (value: A) => SQL,
): FieldDef<A> => ({ schema: schema as S.Schema<A, any, never>, toSQL });

type FilterDef = Record<string, FieldDef<any>>;
type FilterType<D extends FilterDef> = {
  [K in keyof D]?: S.Schema.Type<D[K]["schema"]>;
};

/**
 * Defines a filter by bundling an Effect Schema with a SQL builder for each field.
 *
 * Returns:
 * - `schema` — an Effect Schema for the filter (each field optional), for use in
 *   route query schemas and HTTP validation
 * - `buildWhere` — a function that converts decoded filter values into a Drizzle
 *   WHERE clause, accepting optional extra conditions (e.g. full-text search)
 *
 * Adding a field here is the single change required — both validation and SQL
 * generation update automatically.
 *
 * @example
 * ```ts
 * const userFilter = defineFilter({
 *   name: field(StringOps, (op) => applyStringOp(users.name, op)),
 *   createdAt: field(DateOps, (op) => applyDateOp(users.createdAt, op)),
 * });
 *
 * export const UserQuerySchema = S.Struct({
 *   ...tableQueryFields,
 *   filter: S.optional(parseJsonParam(userFilter.schema)),
 * });
 * ```
 */
export const defineFilter = <D extends FilterDef>(def: D) => {
  const schema = S.Struct(
    Object.fromEntries(
      Object.entries(def).map(([key, { schema: fieldSchema }]) => [
        key,
        S.optional(fieldSchema),
      ]),
    ),
  ) as unknown as S.Schema<FilterType<D>>;

  const buildWhere = (
    values: FilterType<D>,
    extra: readonly (SQL | undefined)[] = [],
  ): SQL | undefined => {
    const conditions: SQL[] = extra.filter(
      (condition): condition is SQL => condition !== undefined,
    );

    for (const key of Object.keys(def) as (keyof D & string)[]) {
      const value = values[key];
      if (value !== undefined) conditions.push(def[key]!.toSQL(value));
    }

    return and(...conditions);
  };

  return { schema, buildWhere };
};
