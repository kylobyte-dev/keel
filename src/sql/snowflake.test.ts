import { getColumns } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { snowflake, snowflakeId } from "./snowflake.ts";

const users = pgTable("users", {
  id: snowflakeId(),
  name: text().notNull(),
});

describe("snowflake", () => {
  it("mints bigint ids", () => {
    expect(typeof snowflake.nextId()).toBe("bigint");
  });

  it("mints distinct, increasing ids in the same millisecond", () => {
    const ids = Array.from({ length: 100 }, () => snowflake.nextId());

    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((left, right) => (left < right ? -1 : 1))).toEqual(
      ids,
    );
  });
});

describe("snowflakeId", () => {
  it("declares a not-null bigint primary key", () => {
    const { id } = getColumns(users);

    expect(id.primary).toBe(true);
    expect(id.notNull).toBe(true);
    expect(id.getSQLType()).toBe("bigint");
  });

  it("defaults the column from the shared generator", () => {
    const { id } = getColumns(users);

    expect(typeof id.defaultFn?.()).toBe("bigint");
  });

  it("takes a generator per writing process", () => {
    const table = pgTable("events", { id: snowflakeId(() => 42n) });

    expect(getColumns(table).id.defaultFn?.()).toBe(42n);
  });
});
