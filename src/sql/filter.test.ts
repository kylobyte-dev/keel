import { Schema as S } from "effect";
import { eq, isNull } from "drizzle-orm";
import {
  bigint,
  PgDialect,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { defineFilter, field } from "./filter.ts";
import { applyDateOp, applyStringOp, DateOps, StringOps } from "./operators.ts";

const users = pgTable("users", {
  id: bigint({ mode: "bigint" }).primaryKey(),
  name: text().notNull(),
  email: text(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

const dialect = new PgDialect();
const toSql = (query: unknown) =>
  dialect
    .sqlToQuery(query as never)
    .sql.replace(/\s+/g, " ")
    .trim();

const userFilter = defineFilter({
  name: field(StringOps, (op) => applyStringOp(users.name, op)),
  createdAt: field(DateOps, (op) => applyDateOp(users.createdAt, op)),
});

describe("defineFilter schema", () => {
  it("makes every field optional", () => {
    expect(S.decodeUnknownSync(userFilter.schema)({})).toEqual({});
  });

  it("decodes the fields that are present", () => {
    const decoded = S.decodeUnknownSync(userFilter.schema)({
      name: { eq: "alice" },
    });

    expect(decoded).toEqual({ name: { eq: "alice" } });
  });

  it("rejects a field whose operator is unknown", () => {
    expect(() =>
      S.decodeUnknownSync(userFilter.schema)({ name: { startsWith: "a" } }),
    ).toThrow();
  });
});

describe("defineFilter buildWhere", () => {
  it("returns undefined when nothing is filtered", () => {
    expect(userFilter.buildWhere({})).toBeUndefined();
  });

  it("builds a condition for the single field provided", () => {
    expect(toSql(userFilter.buildWhere({ name: { eq: "alice" } }))).toBe(
      toSql(eq(users.name, "alice")),
    );
  });

  it("skips fields left undefined", () => {
    const where = userFilter.buildWhere({
      name: { eq: "alice" },
      createdAt: undefined,
    });

    expect(toSql(where)).toBe(toSql(eq(users.name, "alice")));
  });

  it("combines several fields with AND", () => {
    const where = toSql(
      userFilter.buildWhere({
        name: { eq: "alice" },
        createdAt: { gte: new Date("2024-01-01T00:00:00.000Z") },
      }),
    );

    expect(where).toContain(" and ");
    expect(where).toContain('"name"');
    expect(where).toContain('"created_at"');
  });

  it("includes the extra conditions passed by the caller", () => {
    const where = toSql(
      userFilter.buildWhere({ name: { eq: "alice" } }, [isNull(users.email)]),
    );

    expect(where).toContain("is null");
    expect(where).toContain(" and ");
  });

  it("ignores undefined entries among the extra conditions", () => {
    const where = userFilter.buildWhere({}, [undefined, undefined]);

    expect(where).toBeUndefined();
  });
});
