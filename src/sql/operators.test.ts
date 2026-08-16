import { Schema as S } from "effect";
import { between, eq, gte, ilike, inArray, lte, ne } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  applyDateOp,
  applyStringOp,
  DateOps,
  escapeWildcards,
  StringOps,
} from "./operators.ts";

const decode = <A, I>(schema: S.Codec<A, I>, input: unknown) =>
  S.decodeUnknownSync(schema)(input);

describe("StringOps schema", () => {
  it("decodes { eq: 'alice' }", () => {
    expect(decode(StringOps, { eq: "alice" })).toEqual({ eq: "alice" });
  });

  it("decodes { neq: 'alice' }", () => {
    expect(decode(StringOps, { neq: "alice" })).toEqual({ neq: "alice" });
  });

  it("decodes { like: 'ali%' }", () => {
    expect(decode(StringOps, { like: "ali%" })).toEqual({ like: "ali%" });
  });

  it("decodes { in: ['a', 'b'] }", () => {
    expect(decode(StringOps, { in: ["a", "b"] })).toEqual({ in: ["a", "b"] });
  });

  it("rejects unknown operator", () => {
    expect(() => decode(StringOps, { unknown: "x" })).toThrow();
  });
});

describe("DateOps schema", () => {
  it("decodes { gte: ISO string } into Date", () => {
    const result = decode(DateOps, { gte: "2024-01-01T00:00:00.000Z" });

    expect(result).toMatchObject({ gte: expect.any(Date) });
  });

  it("decodes { between: [ISO, ISO] } into [Date, Date]", () => {
    const result = decode(DateOps, {
      between: ["2024-01-01T00:00:00.000Z", "2024-12-31T00:00:00.000Z"],
    });

    expect(result).toMatchObject({
      between: [expect.any(Date), expect.any(Date)],
    });
  });

  it("rejects unknown operator", () => {
    expect(() => decode(DateOps, { after: "2024-01-01" })).toThrow();
  });
});

describe("escapeWildcards", () => {
  it("escapes %, _, and backslash", () => {
    expect(escapeWildcards("100% great_name\\path")).toBe(
      "100\\% great\\_name\\\\path",
    );
  });

  it("leaves safe characters unchanged", () => {
    expect(escapeWildcards("alice")).toBe("alice");
  });
});

describe("applyStringOp", () => {
  const fakeColumn = { name: "name" } as any;

  it("{ eq } generates eq clause", () => {
    expect(applyStringOp(fakeColumn, { eq: "alice" })).toEqual(
      eq(fakeColumn, "alice"),
    );
  });

  it("{ neq } generates ne clause", () => {
    expect(applyStringOp(fakeColumn, { neq: "alice" })).toEqual(
      ne(fakeColumn, "alice"),
    );
  });

  it("{ like } escapes wildcards and generates ilike clause", () => {
    expect(applyStringOp(fakeColumn, { like: "ali%_ce" })).toEqual(
      ilike(fakeColumn, "%ali\\%\\_ce%"),
    );
  });

  it("{ in } generates inArray clause", () => {
    expect(applyStringOp(fakeColumn, { in: ["a", "b"] })).toEqual(
      inArray(fakeColumn, ["a", "b"]),
    );
  });
});

describe("applyDateOp", () => {
  const fakeColumn = { name: "created_at" } as any;
  const date = new Date("2024-01-01T00:00:00.000Z");
  const laterDate = new Date("2024-12-31T00:00:00.000Z");

  it("{ gte } generates gte clause", () => {
    expect(applyDateOp(fakeColumn, { gte: date })).toEqual(
      gte(fakeColumn, date),
    );
  });

  it("{ lte } generates lte clause", () => {
    expect(applyDateOp(fakeColumn, { lte: date })).toEqual(
      lte(fakeColumn, date),
    );
  });

  it("{ between } generates between clause", () => {
    expect(applyDateOp(fakeColumn, { between: [date, laterDate] })).toEqual(
      between(fakeColumn, date, laterDate),
    );
  });
});
