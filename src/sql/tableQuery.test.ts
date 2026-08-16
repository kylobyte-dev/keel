import { Schema as S } from "effect";
import { asc, desc, getColumns } from "drizzle-orm";
import { bigint, PgDialect, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  buildOrderBy,
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  TableQuerySchema,
} from "./tableQuery.ts";

const users = pgTable("users", {
  id: bigint({ mode: "bigint" }).primaryKey(),
  name: text().notNull(),
});

const dialect = new PgDialect();
const toSql = (query: unknown) => dialect.sqlToQuery(query as never).sql;

const decodeQuery = S.decodeUnknownSync(TableQuerySchema);

describe("tableQueryFields", () => {
  it("defaults page and pageSize when they are absent", () => {
    expect(decodeQuery({})).toMatchObject({
      page: DEFAULT_PAGE,
      pageSize: DEFAULT_PAGE_SIZE,
    });
  });

  it("decodes page and pageSize from strings", () => {
    expect(decodeQuery({ page: "3", pageSize: "50" })).toMatchObject({
      page: 3,
      pageSize: 50,
    });
  });

  it("rejects a page below 1", () => {
    expect(() => decodeQuery({ page: "0" })).toThrow();
  });

  it("rejects a pageSize above the maximum", () => {
    expect(() => decodeQuery({ pageSize: "101" })).toThrow();
  });

  it("rejects a direction that is neither asc nor desc", () => {
    expect(() => decodeQuery({ dir: "sideways" })).toThrow();
  });

  it("rejects null for an absent parameter", () => {
    expect(() => decodeQuery({ sort: null })).toThrow();
    expect(() => decodeQuery({ q: null })).toThrow();
  });

  // The decoder above rejects null, so the document must not offer it. `S.optional`
  // would advertise `anyOf: [T, null]` on every one of these fields.
  it("does not document a null branch for the fields without a default", () => {
    const properties = S.toJsonSchemaDocument(TableQuerySchema).schema
      .properties as Record<string, unknown>;

    expect(properties.sort).toStrictEqual({ type: "string" });
    expect(properties.q).toStrictEqual({ type: "string" });
    expect(properties.dir).toStrictEqual({
      type: "string",
      enum: ["asc", "desc"],
    });
  });
});

describe("buildOrderBy", () => {
  const columns = getColumns(users);

  it("returns undefined when no sort is requested", () => {
    expect(buildOrderBy(columns, {})).toBeUndefined();
  });

  it("returns undefined for a column outside the allow-list", () => {
    expect(buildOrderBy(columns, { sort: "password" })).toBeUndefined();
  });

  it("defaults to ascending when no direction is given", () => {
    expect(toSql(buildOrderBy(columns, { sort: "name" }))).toBe(
      toSql(asc(users.name)),
    );
  });

  it("honours a descending direction", () => {
    expect(toSql(buildOrderBy(columns, { sort: "name", dir: "desc" }))).toBe(
      toSql(desc(users.name)),
    );
  });
});
