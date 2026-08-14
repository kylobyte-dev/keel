import { NotFoundError } from "../http/index.ts";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSseHandlerFactory } from "./createSseHandler.ts";

const AppRuntime = ManagedRuntime.make(Layer.empty);
const createSseHandler = createSseHandlerFactory(AppRuntime);

const silentLogger = () => {
  const logger: Record<string, unknown> = {
    level: "silent",
    silent: () => {},
    info: () => {},
    warn: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    error: () => {},
    child: () => logger,
  };

  return logger as unknown as FastifyBaseLogger;
};

let app: FastifyInstance;

beforeEach(() => {
  app = Fastify({
    loggerInstance: silentLogger(),
    forceCloseConnections: true,
  });
});

afterEach(async () => {
  await app.close();
});

describe("createSseHandler", () => {
  it("replies with the authorize failure's status, without hijacking", async () => {
    app.get(
      "/events",
      createSseHandler({
        authorize: () => Effect.fail(new NotFoundError("no stream here")),
        buildStream: () => Effect.void,
      }),
    );

    const response = await app.inject({ method: "GET", url: "/events" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ message: "no stream here" });
  });

  it("replies 500 when authorize dies", async () => {
    app.get(
      "/events",
      createSseHandler({
        authorize: () => Effect.die(new Error("boom")),
        buildStream: () => Effect.void,
      }),
    );

    const response = await app.inject({ method: "GET", url: "/events" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ message: "Internal server error" });
  });

  it("flushes the stream headers, keeping headers set by plugins", async () => {
    app.addHook("onRequest", async (_request, reply) => {
      reply.header("access-control-allow-origin", "https://example.test");
    });

    app.get(
      "/events",
      createSseHandler({
        authorize: () => Effect.succeed({}),
        buildStream: (_context, reply) =>
          Effect.sync(() => {
            reply.raw.write(": connected\n\n");
          }),
      }),
    );

    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const response = await fetch(`http://127.0.0.1:${port}/events`);

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://example.test",
    );
    expect(await response.text()).toBe(": connected\n\n");
  });

  it("interrupts the stream fiber when the client disconnects", async () => {
    const interrupted = await Effect.runPromise(Deferred.make<true>());

    app.get(
      "/events",
      createSseHandler({
        authorize: () => Effect.succeed({}),
        buildStream: (_context, reply) =>
          Effect.sync(() => {
            reply.raw.write(": connected\n\n");
          }).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, true)),
          ),
      }),
    );

    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/events`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();

    await expect(Effect.runPromise(Deferred.await(interrupted))).resolves.toBe(
      true,
    );
  });
});
