import { JSONSchema, Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import { BigIntIdSchema, errorsSchemas, parseJsonParam } from "./parsing.ts";

describe("BigIntIdSchema", () => {
  it("decodes a string into a bigint", () => {
    expect(S.decodeUnknownSync(BigIntIdSchema)("1234567890123456789")).toBe(
      1234567890123456789n,
    );
  });

  it("encodes a bigint back to a string", () => {
    expect(S.encodeSync(BigIntIdSchema)(1234567890123456789n)).toBe(
      "1234567890123456789",
    );
  });

  it("rejects a value that is not an integer string", () => {
    expect(() => S.decodeUnknownSync(BigIntIdSchema)("abc")).toThrow();
  });

  it("documents itself as a string, not as the decoded bigint", () => {
    expect(JSONSchema.make(BigIntIdSchema)).toMatchObject({ type: "string" });
  });
});

describe("parseJsonParam", () => {
  const FilterSchema = S.Struct({ role: S.optional(S.String) });
  const schema = parseJsonParam(FilterSchema);

  it("decodes a JSON-encoded query param", () => {
    expect(S.decodeUnknownSync(schema)('{"role":"admin"}')).toEqual({
      role: "admin",
    });
  });

  it("rejects a payload the wrapped schema refuses", () => {
    expect(() => S.decodeUnknownSync(schema)('{"role":42}')).toThrow();
  });

  it("rejects a string that is not JSON", () => {
    expect(() => S.decodeUnknownSync(schema)("role=admin")).toThrow();
  });

  it("documents the object structure rather than a bare string", () => {
    expect(JSONSchema.make(schema)).toMatchObject(
      JSONSchema.make(FilterSchema),
    );
  });
});

describe("errorsSchemas", () => {
  it("always includes 500 alongside the requested statuses", () => {
    expect(Object.keys(errorsSchemas([404]))).toEqual(
      expect.arrayContaining(["404", "500"]),
    );
  });
});
