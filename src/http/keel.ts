import { PinoLogger, readonly } from "../runtime/index.ts";
import {
  Cause,
  Effect,
  Exit,
  Layer,
  Logger,
  type ManagedRuntime,
} from "effect";
import type { FastifyRequest } from "fastify";
import type { Controller, ControllerInput } from "./controller.ts";
import { HttpResponse } from "./response/success.ts";
import type {
  ApplyExtraStatuses,
  ExtraStatusProvider,
  NoExtraStatuses,
  SimpleRouteHandlerMethod,
} from "./routeTypes.ts";
import type { FastifyPluginAsyncEffect } from "./typeProvider.ts";

/**
 * Type guard to check if an unknown error object matches the HttpError structure.
 *
 * @param error - The error to check.
 * @returns True if the error is an HttpError.
 */
export function isHttpError(
  error: unknown,
): error is { _tag: string; statusCode: number; message: string } {
  return Boolean(
    typeof error === "object" &&
    error &&
    "statusCode" in error &&
    typeof error.statusCode === "number",
  );
}

/**
 * Maps an app-level failure to an HTTP response.
 *
 * Mappers run in order after the `isHttpError` check and before the 500 fallback;
 * the first one to return a value wins. This is how an app teaches keel about
 * error families keel cannot know (e.g. an HTTP client failure → 502 Bad Gateway).
 */
export type ErrorMapper = (
  error: unknown,
) => { statusCode: number; body: unknown } | undefined;

export interface KeelOptions {
  readonly errorMappers?: readonly ErrorMapper[];
}

/**
 * Turns a `Controller` into a Fastify route handler whose response schema is
 * derived from the controller's output and error types.
 */
export interface CreateRoute<
  RuntimeContext,
  StatusProvider extends ExtraStatusProvider,
  R,
  AdditionalErrors,
> {
  <Output, Errors, Input extends ControllerInput = {}>(
    handler: Controller<Input, Output, Errors, R | RuntimeContext, any>,
  ): SimpleRouteHandlerMethod<
    Readonly<Output>,
    Errors | AdditionalErrors,
    Input,
    ApplyExtraStatuses<StatusProvider, Errors | AdditionalErrors>
  >;
}

/** The body of a router: defines routes on `app` using `createRoute`. */
export type RouterDefinition<CreateRouteFn> = (
  app: Parameters<FastifyPluginAsyncEffect>[0],
  createRoute: CreateRouteFn,
) => ReturnType<FastifyPluginAsyncEffect>;

/** A router factory produced by `createRouter` / `createRouterWithErrors`. */
export type Router<
  RuntimeContext,
  StatusProvider extends ExtraStatusProvider,
  R,
  AdditionalErrors,
> = (
  routerPlugin: RouterDefinition<
    CreateRoute<RuntimeContext, StatusProvider, R, AdditionalErrors>
  >,
) => FastifyPluginAsyncEffect;

export interface Keel<
  RuntimeContext,
  StatusProvider extends ExtraStatusProvider,
> {
  /**
   * Creates a dynamic route handler that injects dependencies into the controller.
   *
   * This factory function takes a `requestProvider` which maps a Fastify request to a Layer
   * providing request-scoped dependencies (like logging context or user auth). It returns
   * a function that converts a `Controller` into a standard Fastify route handler.
   */
  createDynamicRouteHandler: <R, E = never, AdditionalErrors = never>(
    requestProvider: (request: FastifyRequest) => Layer.Layer<R, E>,
  ) => CreateRoute<RuntimeContext, StatusProvider, R, AdditionalErrors>;

  /**
   * Creates a router factory with a base dependency provider.
   *
   * This allows setting up common dependencies (like logging) for all routes defined
   * within the returned router.
   */
  createRouter: <R, E = never, AdditionalErrors = never>(
    requestProvider: (request: FastifyRequest) => Layer.Layer<R, E>,
    registerPlugins?: (
      app: Parameters<FastifyPluginAsyncEffect>[0],
    ) => Promise<void>,
  ) => Router<RuntimeContext, StatusProvider, R, AdditionalErrors>;

  /**
   * Creates a router factory with a fixed set of additional error types always present
   * in the route handler's schema, regardless of what the controller itself yields.
   *
   * Useful for routers that have framework-level failure modes outside the Effect pipeline
   * (e.g. auth hooks) that must still appear in the OpenAPI response schema.
   *
   * @example
   * export const authenticatedRouter = createRouterWithErrors<UnauthorizedError>()(requestProvider, registerPlugins);
   */
  createRouterWithErrors: <AdditionalErrors>() => <R, E = never>(
    requestProvider: (request: FastifyRequest) => Layer.Layer<R, E>,
    registerPlugins?: (
      app: Parameters<FastifyPluginAsyncEffect>[0],
    ) => Promise<void>,
  ) => Router<RuntimeContext, StatusProvider, R, AdditionalErrors>;

  /**
   * The default router instance for the application.
   * It provides base logging via Pino.
   */
  router: Router<RuntimeContext, StatusProvider, never, never>;
}

/**
 * Binds keel's route machinery to an application `ManagedRuntime`.
 *
 * Every helper returned here is closed over `runtime`, so the runtime's context
 * flows into the controllers' requirements without any manual annotation: a
 * controller whose `Default` needs a service not provided by the runtime (nor by
 * the router's request provider) is a compile error at the route definition.
 *
 * @example
 * ```ts
 * // shared/app/keel.ts
 * export const { router, createRouter, createRouterWithErrors } = createKeel(AppRuntime);
 * ```
 */
export const createKeel = <RuntimeContext, RuntimeError>(
  runtime: ManagedRuntime.ManagedRuntime<RuntimeContext, RuntimeError>,
  options?: KeelOptions,
): Keel<RuntimeContext, NoExtraStatuses> =>
  createKeelWith<NoExtraStatuses>()(runtime, options);

/**
 * Same as {@link createKeel}, but with an {@link ExtraStatusProvider} that adds
 * app-specific status codes to every route's response schema.
 *
 * @example
 * ```ts
 * export const { router } = createKeelWith<HttpClientExtraStatuses>()(AppRuntime, {
 *   errorMappers: [httpClientErrorMapper],
 * });
 * ```
 */
export const createKeelWith =
  <StatusProvider extends ExtraStatusProvider>() =>
  <RuntimeContext, RuntimeError>(
    runtime: ManagedRuntime.ManagedRuntime<RuntimeContext, RuntimeError>,
    options?: KeelOptions,
  ): Keel<RuntimeContext, StatusProvider> => {
    const errorMappers = options?.errorMappers ?? [];

    const createDynamicRouteHandler = <R, E = never, AdditionalErrors = never>(
      requestProvider: (request: FastifyRequest) => Layer.Layer<R, E>,
    ): CreateRoute<RuntimeContext, StatusProvider, R, AdditionalErrors> =>
      (<Output, Errors, Input extends ControllerInput = {}>(
        handler: Controller<Input, Output, Errors, R | RuntimeContext, any>,
      ) => {
        return async function (
          request: FastifyRequest,
          reply: Parameters<
            SimpleRouteHandlerMethod<Readonly<Output>, Errors, Input>
          >[1],
        ) {
          const effect = handler
            .Default({
              body: request.body,
              params: request.params,
              querystring: request.query,
            } as Input)
            .pipe(
              Effect.map(readonly),
              Effect.annotateLogs("requestId", request.id),
              Effect.annotateLogs("requestPath", request.originalUrl),
            );

          const layers = requestProvider(request);

          const result = await runtime.runPromiseExit(
            effect.pipe(Effect.provide(layers)),
          );

          if (Exit.isSuccess(result)) {
            const value = result.value as any;
            if (value instanceof HttpResponse) {
              return reply
                .status(value.statusCode as any)
                .send(value.value as any);
            }
            return reply.send(value);
          }

          if (Cause.isFailType(result.cause)) {
            const cause = result.cause.error;

            if (isHttpError(cause)) {
              return reply
                .status(cause.statusCode as any)
                .send({ message: cause.message } as any);
            }

            for (const errorMapper of errorMappers) {
              const mapped = errorMapper(cause);
              if (mapped) {
                request.log.error(result.cause);
                return reply
                  .status(mapped.statusCode as any)
                  .send(mapped.body as any);
              }
            }
          }

          request.log.error(result.cause);

          reply.status(500).send({ message: "Internal server error" } as any);
        };
      }) as unknown as CreateRoute<
        RuntimeContext,
        StatusProvider,
        R,
        AdditionalErrors
      >;

    const createRouter =
      <R, E = never, AdditionalErrors = never>(
        requestProvider: (request: FastifyRequest) => Layer.Layer<R, E>,
        registerPlugins?: (
          app: Parameters<FastifyPluginAsyncEffect>[0],
        ) => Promise<void>,
      ): Router<RuntimeContext, StatusProvider, R, AdditionalErrors> =>
      (routerPlugin) => {
        return async (app) => {
          await registerPlugins?.(app);
          const createRoute = createDynamicRouteHandler<R, E, AdditionalErrors>(
            requestProvider,
          );
          return routerPlugin(app, createRoute);
        };
      };

    const createRouterWithErrors =
      <AdditionalErrors>() =>
      <R, E = never>(
        requestProvider: (request: FastifyRequest) => Layer.Layer<R, E>,
        registerPlugins?: (
          app: Parameters<FastifyPluginAsyncEffect>[0],
        ) => Promise<void>,
      ) =>
        createRouter<R, E, AdditionalErrors>(requestProvider, registerPlugins);

    const router = createRouter(() => {
      return Logger.replace(Logger.defaultLogger, PinoLogger);
    });

    return {
      createDynamicRouteHandler,
      createRouter,
      createRouterWithErrors,
      router,
    };
  };
