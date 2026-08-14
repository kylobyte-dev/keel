import { Schema as S } from "effect";
import type { HttpError } from "./response/errors.ts";

export const HttpErrorSchema = S.Struct({
  message: S.String,
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
    HttpErrorSchema.pipe(S.annotations({ description: descriptions[code] }));

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
