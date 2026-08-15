import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { paginate } from "./paginate.ts";
import type { PaginatableQuery } from "./paginate.ts";
import type { SqlExecutor } from "./executor.ts";

type Row = { id: number };

/**
 * A select builder that records the order of the calls it receives.
 *
 * `limit`/`offset` mutate the real Drizzle builder in place, so the order
 * matters: the count subquery has to be taken before the page bounds land.
 */
const makeFakeQuery = (rows: Row[]) => {
  const calls: string[] = [];
  const bounds: { limit?: number; offset?: number } = {};

  const query: PaginatableQuery = {
    as: (alias: string) => {
      calls.push(`as:${alias}`);

      return { alias };
    },
    limit: (value: number) => {
      calls.push(`limit:${value}`);
      bounds.limit = value;

      return query;
    },
    offset: (value: number) => {
      calls.push(`offset:${value}`);
      bounds.offset = value;

      return Effect.succeed(rows);
    },
  };

  return { query, calls, bounds };
};

const makeFakeExecutor = (count: { count: number }[]) => {
  const subqueries: unknown[] = [];

  const executor = {
    select: () => ({
      from: (subquery: unknown) => {
        subqueries.push(subquery);

        return Effect.succeed(count);
      },
    }),
  } as unknown as SqlExecutor;

  return { executor, subqueries };
};

describe("paginate", () => {
  it("returns the page alongside the total and the pagination echo", () => {
    const rows: Row[] = [{ id: 1 }, { id: 2 }];
    const { query } = makeFakeQuery(rows);
    const { executor } = makeFakeExecutor([{ count: 42 }]);

    const result = Effect.runSync(
      paginate<Row>(executor, query, { page: 2, pageSize: 20 }),
    );

    expect(result).toEqual({
      items: rows,
      total: 42,
      page: 2,
      pageSize: 20,
    });
  });

  it("translates page and pageSize into limit and offset", () => {
    const { query, bounds } = makeFakeQuery([]);
    const { executor } = makeFakeExecutor([{ count: 0 }]);

    Effect.runSync(paginate<Row>(executor, query, { page: 3, pageSize: 25 }));

    expect(bounds).toEqual({ limit: 25, offset: 50 });
  });

  it("counts the first page from offset 0", () => {
    const { query, bounds } = makeFakeQuery([]);
    const { executor } = makeFakeExecutor([{ count: 0 }]);

    Effect.runSync(paginate<Row>(executor, query, { page: 1, pageSize: 10 }));

    expect(bounds.offset).toBe(0);
  });

  it("takes the count subquery before applying the page bounds", () => {
    const { query, calls } = makeFakeQuery([]);
    const { executor } = makeFakeExecutor([{ count: 7 }]);

    Effect.runSync(paginate<Row>(executor, query, { page: 2, pageSize: 10 }));

    expect(calls).toEqual(["as:paginated", "limit:10", "offset:10"]);
  });

  it("counts over the subquery, not the table", () => {
    const { query } = makeFakeQuery([]);
    const { executor, subqueries } = makeFakeExecutor([{ count: 7 }]);

    Effect.runSync(paginate<Row>(executor, query, { page: 1, pageSize: 10 }));

    expect(subqueries).toEqual([{ alias: "paginated" }]);
  });

  it("falls back to a total of 0 when the count query returns nothing", () => {
    const { query } = makeFakeQuery([]);
    const { executor } = makeFakeExecutor([]);

    const result = Effect.runSync(
      paginate<Row>(executor, query, { page: 1, pageSize: 10 }),
    );

    expect(result.total).toBe(0);
  });
});
