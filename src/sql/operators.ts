import { Schema as S } from "effect";
import { between, eq, gte, ilike, inArray, lte, ne } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/** Comparison operators accepted for a string column in a filter. */
export const StringOps = S.Union([
  S.Struct({ eq: S.String }),
  S.Struct({ neq: S.String }),
  S.Struct({ like: S.String }),
  S.Struct({ in: S.Array(S.String) }),
]);
export type StringOps = S.Schema.Type<typeof StringOps>;

/**
 * The ISO-string ⇄ `Date` codec, with an explicit OpenAPI representation.
 *
 * Under Effect 4 the string-decoding codec is `S.DateFromString` — plain
 * `S.Date` validates an existing `Date` and would reject the string that
 * actually travels on the wire. The generated document already says `string`;
 * the annotation adds the `date-time` format for the reader.
 */
export const DateSchema = S.DateFromString.annotate({ format: "date-time" });

/** Comparison operators accepted for a date column in a filter. */
export const DateOps = S.Union([
  S.Struct({ gte: DateSchema }),
  S.Struct({ lte: DateSchema }),
  S.Struct({ between: S.Tuple([DateSchema, DateSchema]) }),
]);
export type DateOps = S.Schema.Type<typeof DateOps>;

/**
 * Escapes the characters `LIKE` treats as wildcards.
 *
 * User input reaches `ilike` as data, never as a pattern: without escaping, a
 * search for `100%` matches every row instead of the literal string.
 *
 * @param value - The raw user input.
 * @returns The input with `%`, `_` and `\` escaped.
 */
export const escapeWildcards = (value: string) =>
  value.replace(/[%_\\]/g, "\\$&");

/**
 * Turns a decoded `StringOps` value into a Drizzle condition.
 *
 * `like` is applied as a case-insensitive contains match with the user's
 * wildcards escaped.
 *
 * @param column - The column to compare.
 * @param op - The decoded operator object.
 * @returns The corresponding SQL condition.
 */
export const applyStringOp = (column: PgColumn<any>, op: StringOps): SQL => {
  if ("eq" in op) return eq(column, op.eq);
  if ("neq" in op) return ne(column, op.neq);
  if ("like" in op) return ilike(column, `%${escapeWildcards(op.like)}%`);

  return inArray(column, op.in);
};

/**
 * Turns a decoded `DateOps` value into a Drizzle condition.
 *
 * @param column - The column to compare.
 * @param op - The decoded operator object.
 * @returns The corresponding SQL condition.
 */
export const applyDateOp = (column: PgColumn<any>, op: DateOps): SQL => {
  if ("gte" in op) return gte(column, op.gte);
  if ("lte" in op) return lte(column, op.lte);

  return between(column, op.between[0], op.between[1]);
};
