import { isHttpError } from "../http/index.ts";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  type ManagedRuntime,
  Result,
} from "effect";
import type { FastifyReply, FastifyRequest } from "fastify";

export type SseHandlerOptions<Context, RuntimeContext> = {
  authorize: (
    request: FastifyRequest,
  ) => Effect.Effect<
    Context,
    { statusCode: number; message: string },
    RuntimeContext
  >;
  buildStream: (
    context: Context,
    reply: FastifyReply,
  ) => Effect.Effect<void, never, RuntimeContext>;
};

/**
 * Binds the SSE handler factory to an application `ManagedRuntime`.
 *
 * `authorize` runs before the reply is hijacked, so a failure still goes out as a
 * regular JSON response with the right status. Once it succeeds the reply is
 * hijacked, the stream headers are flushed, and `buildStream` runs in a fiber that
 * is interrupted when the client disconnects.
 *
 * @example
 * ```ts
 * // shared/app/keel.ts
 * export const createSseHandler = createSseHandlerFactory(AppRuntime);
 * ```
 */
export const createSseHandlerFactory =
  <RuntimeContext, RuntimeError>(
    runtime: ManagedRuntime.ManagedRuntime<RuntimeContext, RuntimeError>,
  ) =>
  <Context>(
    options: SseHandlerOptions<Context, RuntimeContext>,
  ): ((request: FastifyRequest, reply: FastifyReply) => Promise<void>) => {
    return async function (request, reply) {
      const authExit = await runtime.runPromiseExit(options.authorize(request));

      if (Exit.isFailure(authExit)) {
        const failure = Cause.findFail(authExit.cause);
        if (Result.isSuccess(failure)) {
          const error: unknown = failure.success.error;
          if (isHttpError(error)) {
            return reply
              .status(error.statusCode as any)
              .send({ message: error.message } as any);
          }
        }
        return reply
          .status(500 as any)
          .send({ message: "Internal server error" } as any);
      }

      const context = authExit.value;

      // Copy headers set by Fastify plugins (e.g. CORS) to the raw response before
      // flushing — they would normally be written by Fastify's onSend lifecycle,
      // which is bypassed when hijacking the reply.
      for (const [key, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined)
          reply.raw.setHeader(key, value as string | string[] | number);
      }
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("X-Accel-Buffering", "no");
      reply.raw.flushHeaders();
      await reply.hijack();

      const fiber = await runtime.runFork(
        options.buildStream(context, reply).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (!reply.raw.writableEnded) reply.raw.end();
            }),
          ),
        ),
      );

      request.raw.on("close", () => {
        runtime.runPromise(Fiber.interrupt(fiber)).catch(() => {});
      });
    };
  };
