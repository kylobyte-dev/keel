import { Schema as S } from "effect";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { NotFoundError } from "../response/errors.ts";
import { effectProviderPlugin } from "./effect.ts";
import { errorHandlerPlugin } from "./errors.ts";

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

beforeEach(async () => {
  app = Fastify({ loggerInstance: silentLogger() });
  await app.register(effectProviderPlugin);
  await app.register(errorHandlerPlugin);

  app.post(
    "/people",
    { schema: { body: S.Struct({ name: S.String }) } },
    async () => ({ ok: true }),
  );

  app.get("/missing", async () => {
    throw new NotFoundError("no such thing");
  });

  app.get("/boom", async () => {
    throw new Error("boom");
  });

  await app.ready();
});

describe("errorHandlerPlugin", () => {
  it("turns a validation failure into 400 with the issue details", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/people",
      payload: { name: 42 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      statusCode: 400,
      error: "Bad Request",
      message: "Validation failed",
    });
    expect(response.json().details).toHaveLength(1);
    expect(response.json().details[0]).toMatchObject({
      instancePath: "name",
    });
  });

  it("keeps the status of an HttpError thrown outside the Effect pipeline", async () => {
    const response = await app.inject({ method: "GET", url: "/missing" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      statusCode: 404,
      message: "no such thing",
    });
  });

  it("falls back to 500 for an unknown error", async () => {
    const response = await app.inject({ method: "GET", url: "/boom" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      statusCode: 500,
      error: "InternalServerError",
      message: "Internal Server Error",
    });
  });
});
