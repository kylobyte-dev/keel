import type { SwaggerTransform } from "@fastify/swagger";
import { pinoInstance } from "../runtime/index.ts";
import { Result, Schema as S, SchemaIssue } from "effect";
import {
  errorCodes,
  type FastifyPluginAsync,
  type FastifyPluginOptions,
  type FastifySchema,
  type FastifySchemaCompiler,
  type FastifyTypeProvider,
  type RawServerBase,
  type RawServerDefault,
} from "fastify";
import type { FastifySerializerCompiler } from "fastify/types/schema.js";
import { ResponseSerializationError } from "./errors.ts";

export interface EffectTypeProvider extends FastifyTypeProvider {
  validator: this["schema"] extends S.Top
    ? S.Schema.Type<this["schema"]>
    : never;
  serializer: this["schema"] extends S.Top
    ? S.Schema.Type<this["schema"]>
    : never;
  response: this["schema"] extends S.Top
    ? S.Schema.Type<this["schema"]>
    : never;
}

/**
 * The JSON Schema for a schema, as a self-contained object.
 *
 * v4 returns a document — the schema plus a separate `definitions` map — so the
 * definitions are folded back under `$defs` to match what `inlineLocalDefs`
 * (and Fastify's schema slot) expect.
 */
export const makeJsonSchema = (schema: S.Top): Record<string, any> => {
  const document = S.toJsonSchemaDocument(schema);

  return Object.keys(document.definitions).length > 0
    ? { ...document.schema, $defs: document.definitions }
    : { ...document.schema };
};

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

export const validatorCompiler: FastifySchemaCompiler<S.Codec<any, any>> =
  ({ schema, httpPart }) =>
  (data) => {
    const result = S.decodeUnknownResult(schema)(data);

    if (Result.isFailure(result)) {
      const error = new errorCodes.FST_ERR_VALIDATION(
        httpPart,
        "Validation failed",
        result.failure.message,
      );
      const { issues } = formatIssue(result.failure.issue);
      error.validation = issues.map((issue) => {
        const path = (issue.path ?? []).map((segment) =>
          typeof segment === "object" ? String(segment.key) : String(segment),
        );

        return {
          keyword: "schema",
          instancePath: path.join("."),
          schemaPath: `${httpPart}/${path.join("/")}`,
          params: {
            message: issue.message,
          },
        };
      });

      return { error };
    }

    return { value: result.success };
  };

export const serializerCompiler: FastifySerializerCompiler<S.Codec<any, any>> =
  ({ schema, method, url }) =>
  (data) => {
    const result = S.encodeUnknownResult(schema)(data);
    if (Result.isFailure(result)) {
      pinoInstance.error(result.failure.message);
      throw new ResponseSerializationError(method, url, {
        cause: result.failure,
      });
    }

    return JSON.stringify(result.success);
  };

export type FastifyPluginAsyncEffect<
  Options extends FastifyPluginOptions = Record<never, never>,
  Server extends RawServerBase = RawServerDefault,
> = FastifyPluginAsync<Options, Server, EffectTypeProvider>;

/**
 * `toJsonSchemaDocument` puts reusable definitions in a separate `definitions` map,
 * which `makeJsonSchema` folds back under `$defs`, referenced as `$ref: "#/$defs/Name"`.
 * But that ref resolves against the **root of the OpenAPI document**, where `$defs`
 * does not exist (it sits nested inside the route schema): Scalar tolerates it, strict
 * bundlers (openapi-typescript) fail. So we dereference the local `$defs` inline here,
 * leaving every schema self-contained. A recursive schema is left intact (the `seen`
 * guard) rather than looping forever.
 */
export const inlineLocalDefs = (
  root: Record<string, any>,
): Record<string, any> => {
  const defs: Record<string, any> = root?.$defs ?? {};

  const resolve = (node: any, seen: ReadonlySet<string>): any => {
    if (Array.isArray(node)) {
      return node.map((item) => resolve(item, seen));
    }
    if (node && typeof node === "object") {
      const ref: unknown = node.$ref;
      if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
        const name = ref.slice("#/$defs/".length);
        if (seen.has(name) || !(name in defs)) {
          return node; // cycle or external ref: leave it as it is
        }
        return resolve(defs[name], new Set(seen).add(name));
      }
      const output: Record<string, any> = {};
      for (const key in node) {
        if (key === "$defs") continue;
        output[key] = resolve(node[key], seen);
      }
      return output;
    }
    return node;
  };

  return resolve(root, new Set());
};

export const jsonSchemaTransform: (
  skipList: (string | RegExp)[],
) => SwaggerTransform<FastifySchema> =
  (skipList = []) =>
  ({ schema, url }) => {
    if (!schema) {
      return {
        schema,
        url,
      };
    }

    const { response, headers, querystring, body, params, hide, ...rest } =
      schema;

    const transformed: Record<string, any> = {};

    if (
      hide ||
      skipList.some((pattern) => {
        if (typeof pattern === "string") {
          return url?.includes(pattern);
        }
        return pattern.test(url);
      })
    ) {
      transformed.hide = true;
      return { schema: transformed, url };
    }

    const effectSchema: Record<string, any> = {
      headers,
      querystring,
      body,
      params,
    };

    for (const prop in effectSchema) {
      const propSchema = effectSchema[prop];
      if (propSchema) {
        transformed[prop] = inlineLocalDefs(makeJsonSchema(propSchema));
      }
    }

    if (response) {
      transformed.response = {};

      for (const prop in response) {
        const propSchema = (response as any)[prop];
        transformed.response[prop] = inlineLocalDefs(
          makeJsonSchema(propSchema),
        );
      }
    }

    for (const prop in rest) {
      const meta = rest[prop as keyof typeof rest];
      if (meta) {
        transformed[prop] = meta;
      }
    }

    return { schema: transformed, url };
  };
