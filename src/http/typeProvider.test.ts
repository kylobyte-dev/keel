import { Schema as S } from "effect";
import { errorCodes } from "fastify";
import { describe, expect, it } from "vitest";
import { ResponseSerializationError } from "./errors.ts";
import {
  inlineLocalDefs,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "./typeProvider.ts";

const BodySchema = S.Struct({
  name: S.String,
  age: S.Number,
});

describe("validatorCompiler", () => {
  it("decodes a valid payload", () => {
    const validate = validatorCompiler({
      schema: BodySchema,
      method: "POST",
      url: "/people",
      httpPart: "body",
    });

    expect(validate({ name: "ada", age: 36 })).toEqual({
      value: { name: "ada", age: 36 },
    });
  });

  it("fails with FST_ERR_VALIDATION and a populated validation array", () => {
    const validate = validatorCompiler({
      schema: BodySchema,
      method: "POST",
      url: "/people",
      httpPart: "body",
    });

    const result = validate({ name: "ada", age: "not a number" }) as {
      error: InstanceType<typeof errorCodes.FST_ERR_VALIDATION>;
    };

    expect(result.error).toBeInstanceOf(errorCodes.FST_ERR_VALIDATION);
    expect(result.error.validation).toHaveLength(1);
    // Effect 4's Standard Schema formatter reports `{ message, path }` without
    // the issue tag Effect 3 exposed, so `keyword` is no longer per-issue.
    expect(result.error.validation?.[0]).toMatchObject({
      keyword: "schema",
      instancePath: "age",
      schemaPath: "body/age",
    });
    expect(result.error.validation?.[0]?.params).toHaveProperty("message");
  });

  it("reports the failing path of nested properties", () => {
    const NestedSchema = S.Struct({ car: S.Struct({ plate: S.String }) });
    const validate = validatorCompiler({
      schema: NestedSchema,
      method: "POST",
      url: "/cars",
      httpPart: "body",
    });

    const result = validate({ car: { plate: 42 } }) as {
      error: InstanceType<typeof errorCodes.FST_ERR_VALIDATION>;
    };

    expect(result.error.validation?.[0]).toMatchObject({
      instancePath: "car.plate",
      schemaPath: "body/car/plate",
    });
  });
});

describe("serializerCompiler", () => {
  it("encodes a valid payload", () => {
    const serialize = serializerCompiler({
      schema: BodySchema,
      method: "GET",
      url: "/people",
    });

    expect(serialize({ name: "ada", age: 36 })).toBe(
      JSON.stringify({ name: "ada", age: 36 }),
    );
  });

  it("throws ResponseSerializationError when the payload does not match", () => {
    const serialize = serializerCompiler({
      schema: BodySchema,
      method: "GET",
      url: "/people",
    });

    let thrown: unknown;
    try {
      serialize({ name: "ada" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ResponseSerializationError);
    expect(thrown).toMatchObject({
      code: "FST_ERR_RESPONSE_SERIALIZATION",
      method: "GET",
      url: "/people",
    });
  });
});

describe("jsonSchemaTransform", () => {
  /** Calls the transform the way @fastify/swagger does, one route at a time. */
  const transform = (
    schema: unknown,
    url: string,
    skipList: (string | RegExp)[] = [],
  ) => (jsonSchemaTransform(skipList) as any)({ schema, url, route: {} });

  it("keeps the route untouched when there is no schema", () => {
    expect(transform(undefined, "/health")).toEqual({
      schema: undefined,
      url: "/health",
    });
  });

  it("hides routes flagged with `hide`", () => {
    const result = transform({ hide: true, body: BodySchema }, "/internal");

    expect(result.schema).toEqual({ hide: true });
  });

  it("hides routes matching a string entry of the skip list", () => {
    const result = transform({ body: BodySchema }, "/internal/flush", [
      "/internal",
    ]);

    expect(result.schema).toEqual({ hide: true });
  });

  it("hides routes matching a RegExp entry of the skip list", () => {
    const result = transform({ body: BodySchema }, "docs/json", [/^docs\//]);

    expect(result.schema).toEqual({ hide: true });
  });

  it("converts request and response schemas, and keeps other metadata", () => {
    const result = transform(
      {
        summary: "Create a person",
        body: BodySchema,
        params: S.Struct({ id: S.String }),
        response: { 200: BodySchema },
      },
      "/people/:id",
    );

    const schema = result.schema as Record<string, any>;
    expect(schema.summary).toBe("Create a person");
    expect(schema.body.properties).toHaveProperty("name");
    expect(schema.params.properties).toHaveProperty("id");
    expect(schema.response[200].properties).toHaveProperty("age");
  });

  describe("inlineLocalDefs", () => {
    // A schema annotated with an identifier is emitted by `JSONSchema.make` as a
    // local `$defs` entry plus a `$ref` to it — a ref that does not resolve once
    // the schema is nested inside the OpenAPI document.
    const Money = S.Struct({ amount: S.Number }).annotate({
      identifier: "Money",
    });
    const Invoice = S.Struct({ total: Money, paid: Money });

    it("dereferences local $defs and drops the $defs block", () => {
      const result = transform(
        { body: Invoice, response: { 200: Invoice } },
        "/invoices",
      );

      const schema = result.schema as Record<string, any>;
      const serialized = JSON.stringify(schema);

      expect(serialized).not.toContain("$defs");
      expect(serialized).not.toContain("#/$defs/");
      expect(schema.body.properties.total.properties).toHaveProperty("amount");
      expect(schema.body.properties.paid.properties).toHaveProperty("amount");
      expect(schema.response[200].properties.total.properties).toHaveProperty(
        "amount",
      );
    });

    // Effect 4 has no schema-level JSON Schema override, so an external `$ref`
    // can no longer be produced through a schema: the branch is exercised on
    // `inlineLocalDefs` directly instead.
    it("leaves refs that do not point at a local $defs entry intact", () => {
      const result = inlineLocalDefs({
        type: "object",
        properties: {
          external: { $ref: "#/components/schemas/External" },
          missing: { $ref: "#/$defs/Absent" },
        },
        $defs: {},
      });

      expect(result.properties.external).toEqual({
        $ref: "#/components/schemas/External",
      });
      expect(result.properties.missing).toEqual({ $ref: "#/$defs/Absent" });
    });

    it("does not loop on a recursive schema", () => {
      interface Node {
        readonly name: string;
        readonly children: ReadonlyArray<Node>;
      }
      const NodeSchema = S.Struct({
        name: S.String,
        children: S.Array(
          S.suspend((): S.Schema<Node> => NodeSchema),
        ) as S.Schema<ReadonlyArray<Node>>,
      }).annotate({ identifier: "Node" });

      const result = transform({ body: NodeSchema }, "/nodes");

      const schema = result.schema as Record<string, any>;
      // The cycle is left as a `$ref` instead of being expanded forever.
      expect(JSON.stringify(schema)).toContain("#/$defs/Node");
      expect(schema.body.properties.name).toEqual({ type: "string" });
    });
  });
});
