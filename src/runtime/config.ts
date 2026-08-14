import { Effect } from "effect";
import { voidMemo } from "./utils.ts";

/**
 * Reads a configuration Effect once, synchronously, and memoizes the result.
 *
 * This is the pattern every keel-based app uses for its config getters: the
 * Effect is built from `Config` descriptors and run eagerly the first time the
 * getter is called, so a missing or malformed variable fails loudly at the
 * first use instead of being threaded through the request path.
 *
 * @example
 * ```ts
 * export const getServerConfig = memoizedConfig(
 *   Effect.gen(function* () {
 *     const port = yield* Config.number("SERVER_PORT");
 *     const host = yield* Config.nonEmptyString("SERVER_HOST");
 *
 *     return { port, host };
 *   }),
 * );
 * ```
 */
export const memoizedConfig = <A, E>(effect: Effect.Effect<A, E>) =>
  voidMemo(() => Effect.runSync(effect));
