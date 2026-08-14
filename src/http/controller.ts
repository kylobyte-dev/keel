import { Effect, Layer } from "effect";

/**
 * Unique symbol to brand controller outputs.
 * This ensures that only properly constructed controllers can be used with createRouteHandler.
 */
const ControllerBrand = Symbol("brand/Controller");

/**
 * Input shape for route handlers
 */
export interface ControllerInput {
  body?: unknown;
  params?: Record<string, unknown>;
  querystring?: Record<string, unknown>;
}

/**
 * The branded controller type that is returned from the `controller` function.
 * - `Default` is the handler with provided dependencies, ready for use with createRouteHandler
 * - `DefaultWithoutDependencies` is the raw handler for testing purposes
 */
export interface Controller<I extends ControllerInput, O, E, R, OriginalR> {
  readonly [ControllerBrand]: typeof ControllerBrand;

  /**
   * The handler with dependencies provided. Use this with createRouteHandler.
   * Its requirements must be satisfiable by the app runtime's context.
   */
  readonly Default: (input: I) => Effect.Effect<O, E, R>;

  /**
   * The raw handler without dependencies. Use this for testing.
   */
  readonly DefaultWithoutDependencies: (
    input: I,
  ) => Effect.Effect<O, E, OriginalR>;
}

/**
 * Helper types to extract Layer information.
 * Uses distributive conditional types (no wrapping brackets) so that
 * union inputs like `Layer<A, E1, R1> | Layer<B, E2, R2>` correctly yield
 * `A | B`, `E1 | E2`, and `R1 | R2` respectively.
 */
type LayerContext<L> = L extends Layer.Layer<infer S, any, any> ? S : never;
type LayerError<L> = L extends Layer.Layer<any, infer E, any> ? E : never;
type LayerDeps<L> = L extends Layer.Layer<any, any, infer R> ? R : never;

/**
 * Creates a type-safe controller for route handlers.
 *
 * This function wraps a handler with a set of layers, ensuring that all dependencies
 * required by the handler are provided at the route level. It returns a branded
 * controller that contains both the handler with dependencies and the raw handler
 * for testing purposes.
 *
 * Layers are optional: services that live in the app runtime (so that every route
 * shares the same singleton instance) need no layer here.
 *
 * @example
 * ```ts
 * const getUser = controller(
 *   ({ params }: Params<{ id: bigint }>) =>
 *     Effect.gen(function* () {
 *       const userRepo = yield* UserRepositoryService;
 *       return yield* userRepo.findById(params.id);
 *     }),
 *   [UserRepositoryService.Default]
 * );
 * ```
 *
 * @param handler - A function that takes typed input (body, params, query) and returns an Effect.
 * @param layers - An array of Effect layers that provide the dependencies required by the handler.
 * @returns A branded Controller object with `Default` (bound) and `DefaultWithoutDependencies` (unbound) handlers.
 */
export const controller = <
  I extends ControllerInput,
  O,
  E,
  HandlerR,
  const Layers extends readonly Layer.Layer<any, any, any>[] = readonly [],
>(
  handler: (input: I) => Effect.Effect<O, E, HandlerR>,
  layers: Layers = [] as unknown as Layers,
) => {
  const mergedLayer =
    layers.length > 0 ? Layer.mergeAll(...(layers as any)) : Layer.empty;

  return {
    [ControllerBrand as typeof ControllerBrand]:
      ControllerBrand as typeof ControllerBrand,
    Default: (input: I) => handler(input).pipe(Effect.provide(mergedLayer)),
    DefaultWithoutDependencies: handler,
  } as Controller<
    I,
    O,
    E | LayerError<Layers[number]>,
    Exclude<HandlerR, LayerContext<Layers[number]>> | LayerDeps<Layers[number]>,
    HandlerR
  >;
};
