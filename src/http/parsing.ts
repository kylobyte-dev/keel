import { Schema as S } from "effect";
import type { HttpError } from "./response/errors.ts";
import { makeJsonSchema } from "./typeProvider.ts";

export const HttpErrorSchema = S.Struct({
  message: S.String,
});

/**
 * A `bigint` identifier that travels as a string.
 *
 * JSON has no integer wide enough for a 64-bit key, so the wire format is a
 * string: under Effect 4 the codec that decodes one is `S.BigIntFromString`,
 * not `S.BigInt` (which validates an existing `bigint`). It already documents
 * itself as a string with a digits-only pattern. Applies to any `bigint` key —
 * a Snowflake, a `bigserial` — and an app keyed by `uuid` or `text` uses
 * `S.UUID` or `S.String` instead.
 *
 * KNOWN GAP (Effect 4 rc.109): the `description` below is dropped by the JSON
 * Schema generator, which keeps annotations only on leaf schemas, not on
 * transformations. The wire contract is right; the prose is missing.
 */
export const BigIntIdSchema = S.BigIntFromString.annotate({
  description: "A 64-bit identifier, encoded as a string",
});

/**
 * Wraps a schema in `S.fromJsonString` and describes the JSON it carries with
 * the actual object schema, via the standard `contentSchema` keyword.
 *
 * Use this for JSON-encoded query string parameters so Fastify validates the
 * decoded value with Effect Schema.
 *
 * KNOWN GAP (Effect 4 rc.109): as with {@link BigIntIdSchema}, the annotation
 * is attached to a transformation and the generator drops it, so the parameter
 * currently documents itself as `{ type: "string", contentMediaType: ... }`
 * without the structure. `contentSchema` is the right keyword for this and the
 * call is kept so the document fills in once the generator carries it.
 *
 * @param schema - The schema describing the decoded value.
 * @returns A schema that parses a JSON string and documents its content.
 *
 * @example
 * ```ts
 * // GET /users?filter={"role":"admin"}
 * export const UserQuerySchema = S.Struct({
 *   ...tableQueryFields,
 *   filter: S.optionalKey(parseJsonParam(UserFilterSchema)),
 * });
 * ```
 */
export const parseJsonParam = <A, I>(schema: S.Codec<A, I>) =>
  S.fromJsonString(schema).annotate({
    contentSchema: makeJsonSchema(schema),
  });

/** Reason phrases used as the OpenAPI description of each error response. */
export const errorSchemasDescriptions: Record<
  HttpError["statusCode"] | 500,
  string
> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  500: "Internal Server Error",
};

/**
 * Builds an `errorsSchemas` helper over a set of allowed status codes.
 *
 * An app that maps extra statuses (e.g. 502 for an upstream failure) builds its own
 * helper by widening the allowed set and the descriptions map.
 *
 * @example
 * ```ts
 * export const errorsSchemas = makeErrorsSchemas<HttpError["statusCode"] | 502>({
 *   ...errorSchemasDescriptions,
 *   502: "Bad Gateway",
 * });
 * ```
 */
export const makeErrorsSchemas = <AllowedStatus extends number>(
  descriptions: Record<AllowedStatus | 500, string>,
) => {
  const annotatedErrorSchema = (code: AllowedStatus | 500) =>
    HttpErrorSchema.annotate({ description: descriptions[code] });

  /**
   * Generates a collection of schemas for specified HTTP error status codes.
   *
   * This utility is useful for defining OpenAPI responses for various error conditions.
   * It automatically includes a 500 Internal Server Error schema.
   *
   * @param codes - An array of HTTP status codes to generate schemas for.
   * @returns An object where keys are status codes and values are the corresponding Error schemas.
   */
  return <Status extends AllowedStatus[]>(codes: Status) =>
    ({
      500: annotatedErrorSchema(500),
      ...codes.reduce(
        (acc, code) => ({ ...acc, [code]: annotatedErrorSchema(code) }),
        {},
      ),
    }) as {
      500: typeof HttpErrorSchema;
    } & {
      [K in Status[number]]: typeof HttpErrorSchema;
    };
};

/** Error response schemas for the statuses keel's tagged `HttpError`s map to. */
export const errorsSchemas = makeErrorsSchemas<HttpError["statusCode"]>(
  errorSchemasDescriptions,
);
