import { Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import { BigIntIdSchema, errorsSchemas, parseJsonParam } from "./parsing.ts";
import { makeJsonSchema } from "./typeProvider.ts";

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
    expect(makeJsonSchema(BigIntIdSchema)).toMatchObject({ type: "string" });
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

  // KNOWN GAP (Effect 4 rc.109): annotations attached to a transformation are
  // dropped by the JSON Schema generator — only annotations on leaf schemas
  // survive. The `contentSchema` set by `parseJsonParam` therefore does not
  // reach the document, and the param is documented as a bare JSON string.
  // Decoding is unaffected; this is a documentation regression only.
  it("is documented as a JSON-carrying string", () => {
    expect(makeJsonSchema(schema)).toMatchObject({
      type: "string",
      contentMediaType: "application/json",
    });
  });
});

describe("errorsSchemas", () => {
  it("always includes 500 alongside the requested statuses", () => {
    expect(Object.keys(errorsSchemas([404]))).toEqual(
      expect.arrayContaining(["404", "500"]),
    );
  });
});
