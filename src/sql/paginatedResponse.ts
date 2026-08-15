import { Schema as S } from "effect";

/**
 * Generic paginated response schema factory.
 *
 * @param itemSchema - The schema of a single row.
 * @returns A schema for `{ items, total, page, pageSize }`.
 *
 * @example
 * ```ts
 * response: { 200: paginatedSchema(UserSchema) }
 * ```
 */
export const paginatedSchema = <A, I>(itemSchema: S.Schema<A, I>) =>
  S.Struct({
    items: S.mutable(S.Array(itemSchema)),
    total: S.Number,
    page: S.Number,
    pageSize: S.Number,
  });

export type PaginatedResponse<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};
