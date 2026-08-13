import type { SwaggerTransform } from "@fastify/swagger";
import { pinoInstance } from "@keel/runtime";
import { Either, JSONSchema, ParseResult, Schema as S } from "effect";
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
  validator: this["schema"] extends S.Schema<any>
    ? S.Schema.Type<this["schema"]>
    : never;
  serializer: this["schema"] extends S.Schema<any>
    ? S.Schema.Type<this["schema"]>
    : never;
  response: this["schema"] extends S.Schema<any>
    ? S.Schema.Type<this["schema"]>
    : never;
}

export const validatorCompiler: FastifySchemaCompiler<S.Schema<any>> =
  ({ schema, httpPart }) =>
  (data) => {
    const result = S.decodeUnknownEither(schema)(data);

    if (Either.isLeft(result)) {
      const error = new errorCodes.FST_ERR_VALIDATION(
        httpPart,
        "Validation failed",
        ParseResult.TreeFormatter.formatErrorSync(result.left),
      );
      const issues = ParseResult.ArrayFormatter.formatIssueSync(
        result.left.issue,
      );
      error.validation = issues.map((issue) => ({
        keyword: issue._tag,
        instancePath: issue.path.join("."),
        schemaPath: `${httpPart}/${issue.path.join("/")}:${issue._tag}`,
        params: {
          message: issue.message,
        },
      }));

      return { error };
    }

    return { value: result.right };
  };

export const serializerCompiler: FastifySerializerCompiler<S.Schema<any>> =
  ({ schema, method, url }) =>
  (data) => {
    const result = S.encodeUnknownEither(schema)(data);
    if (Either.isLeft(result)) {
      pinoInstance.error(result.left.message);
      throw new ResponseSerializationError(method, url, {
        cause: result.left,
      });
    }

    return JSON.stringify(result.right);
  };

export type FastifyPluginAsyncEffect<
  Options extends FastifyPluginOptions = Record<never, never>,
  Server extends RawServerBase = RawServerDefault,
> = FastifyPluginAsync<Options, Server, EffectTypeProvider>;

/**
 * `JSONSchema.make` mette le definizioni riusabili in un blocco `$defs` locale e le
 * referenzia con `$ref: "#/$defs/Name"`. Ma quel ref si risolve alla **root del
 * documento** OpenAPI, dove `$defs` non esiste (sta annidato nello schema di rotta):
 * Scalar lo tollera, ma bundler severi (openapi-typescript) falliscono. Qui
 * dereferenziamo i `$defs` locali inline, così ogni schema è self-contained.
 * Uno schema ricorsivo verrebbe lasciato intatto (guardia `seen`) invece di andare
 * in loop.
 */
const inlineLocalDefs = (root: Record<string, any>): Record<string, any> => {
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
          return node; // ciclo o ref esterno: lascia com'è
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
        transformed[prop] = inlineLocalDefs(JSONSchema.make(propSchema));
      }
    }

    if (response) {
      transformed.response = {};

      for (const prop in response) {
        const propSchema = (response as any)[prop];
        transformed.response[prop] = inlineLocalDefs(
          JSONSchema.make(propSchema),
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
