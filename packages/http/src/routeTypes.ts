import type { Schema as S } from "effect";
import type {
  ContextConfigDefault,
  FastifyBaseLogger,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
  RouteGenericInterface,
  RouteHandlerMethod,
} from "fastify";
import type { ResolveFastifyRequestType } from "fastify/types/type-provider.js";
import type { IncomingMessage } from "http";
import type { HttpError } from "./response/errors.ts";
import type { HttpResponse } from "./response/success.ts";
import type { EffectTypeProvider } from "./typeProvider.ts";

export type SimpleFastifyRequest<
  Input extends { body?: unknown; querystring?: unknown; params?: unknown },
> = FastifyRequest<
  RouteGenericInterface,
  RawServerDefault,
  IncomingMessage,
  {
    body: S.Schema<Input["body"]>;
    querystring: S.Schema<Input["querystring"]>;
    params: S.Schema<Input["params"]>;
  },
  EffectTypeProvider,
  unknown,
  FastifyBaseLogger,
  ResolveFastifyRequestType<
    EffectTypeProvider,
    {
      body: S.Schema<Input["body"]>;
      querystring: S.Schema<Input["querystring"]>;
      params: S.Schema<Input["params"]>;
    },
    RouteGenericInterface
  >
>;

export type SimpleFastifyReply<Output> = FastifyReply<
  RouteGenericInterface,
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  ContextConfigDefault,
  {
    response: {
      200: S.Schema<Output, any>;
    };
  },
  EffectTypeProvider
>;

type UnionToIntersection<U> = (U extends any ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

type HttpResponseToSchema<T extends HttpResponse<any, any>> =
  T extends HttpResponse<infer V, infer Status>
    ? { [K in Status]: S.Schema<V, any> }
    : never;

type ExtractSuccessSchemas<Output> = (Exclude<
  Output,
  HttpResponse<any, any>
> extends never
  ? unknown
  : { 200: S.Schema<Exclude<Output, HttpResponse<any, any>>, any> }) &
  (Extract<Output, HttpResponse<any, any>> extends never
    ? unknown
    : UnionToIntersection<
        HttpResponseToSchema<Extract<Output, HttpResponse<any, any>>>
      >);

/**
 * Type-level hook that lets an app contribute extra HTTP statuses to the response
 * schema of every route, computed from the controller's error type.
 *
 * Keel cannot know about app-level error families (an HTTP client that maps to 502,
 * a rate limiter that maps to 429, ...), so an app declares an interface extending
 * this one and reads `this["errors"]` — the same trick Fastify uses for its type
 * providers — then passes it to `createKeelWith`.
 *
 * @example
 * ```ts
 * interface HttpClientExtraStatuses extends ExtraStatusProvider {
 *   readonly statuses: this["errors"] extends HttpClientError ? 502 : never;
 * }
 * ```
 */
export interface ExtraStatusProvider {
  readonly errors: unknown;
  readonly statuses: number;
}

/** Default provider: no extra statuses beyond 500 and the tagged HttpErrors. */
export interface NoExtraStatuses extends ExtraStatusProvider {
  readonly statuses: never;
}

/** Applies an {@link ExtraStatusProvider} to a concrete error type. */
export type ApplyExtraStatuses<
  Provider extends ExtraStatusProvider,
  Errors,
> = (Provider & { readonly errors: Errors })["statuses"];

export type ResponseSchema<
  Output,
  Errors,
  ExtraStatuses extends number = never,
> = ExtractSuccessSchemas<Output> & {
  500: S.Schema<{ message: string }, any>;
} & {
  [Status in Errors extends HttpError ? Errors["statusCode"] : never]: S.Schema<
    { message: string },
    any
  >;
} & {
  [Status in ExtraStatuses]: S.Schema<{ message: string }, any>;
};

export type SimpleRouteHandlerMethod<
  Output,
  Errors,
  Input extends {
    body?: unknown;
    querystring?: unknown;
    params?: unknown;
  } = {},
  ExtraStatuses extends number = never,
> = RouteHandlerMethod<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  RouteGenericInterface,
  ContextConfigDefault,
  {
    body?: S.Schema<Input["body"], any>;
    querystring?: S.Schema<Input["querystring"], any>;
    params?: S.Schema<Input["params"], any>;
    response: ResponseSchema<Output, Errors, ExtraStatuses>;
  },
  EffectTypeProvider,
  FastifyBaseLogger
>;

export type Params<T extends Record<string, unknown>> = { params: Readonly<T> };
export type Query<T extends Record<string, unknown>> = {
  querystring: Readonly<T>;
};
export type Body<T> = {
  body: Readonly<T>;
};
