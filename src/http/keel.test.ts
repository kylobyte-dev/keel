import {
  Context,
  Data,
  Effect,
  Layer,
  ManagedRuntime,
  Schema as S,
} from "effect";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { controller } from "./controller.ts";
import { createKeel, createKeelWith, isHttpError } from "./keel.ts";
import {
  errorSchemasDescriptions,
  makeErrorsSchemas,
  errorsSchemas,
} from "./parsing.ts";
import { effectProviderPlugin } from "./plugins/effect.ts";
import { HttpCreated } from "./response/success.ts";
import { NotFoundError, type HttpError } from "./response/errors.ts";
import type { ApplyExtraStatuses, ExtraStatusProvider } from "./routeTypes.ts";

class Clock extends Context.Tag("Clock")<Clock, { now: () => string }>() {}

const AppRuntime = ManagedRuntime.make(
  Layer.succeed(Clock, { now: () => "2026-08-13" }),
);

class UpstreamError extends Data.TaggedError("UpstreamError")<{
  message: string;
}> {}

const errorsSchemasWithGateway = makeErrorsSchemas<
  HttpError["statusCode"] | 502
>({
  ...errorSchemasDescriptions,
  502: "Bad Gateway",
});

const { router } = createKeel(AppRuntime, {
  errorMappers: [
    (error) =>
      error instanceof UpstreamError
        ? { statusCode: 502, body: { message: "Bad Gateway" } }
        : undefined,
  ],
});

const MessageSchema = S.Struct({ message: S.String });

const ok = controller(() =>
  Effect.gen(function* () {
    const clock = yield* Clock;
    return { message: clock.now() };
  }),
);

const created = controller(() =>
  Effect.succeed(new HttpCreated({ message: "created" })),
);

const missing = controller(() => new NotFoundError("nope").pipe(Effect.fail));

const upstream = controller(() =>
  Effect.fail(new UpstreamError({ message: "upstream is down" })),
);

const broken = controller((): Effect.Effect<{ message: string }> =>
  Effect.die(new Error("boom")),
);

const loggedErrors: unknown[] = [];

const testRoutes = router(async (app, createRoute) => {
  app.get(
    "/ok",
    { schema: { response: { 200: MessageSchema, 500: MessageSchema } } },
    createRoute(ok),
  );

  app.post(
    "/created",
    { schema: { response: { 201: MessageSchema, 500: MessageSchema } } },
    createRoute(created),
  );

  app.get(
    "/missing",
    { schema: { response: { ...errorsSchemas([404]), 200: MessageSchema } } },
    createRoute(missing),
  );

  app.get(
    "/upstream",
    {
      schema: {
        response: { ...errorsSchemasWithGateway([502]), 200: MessageSchema },
      },
    },
    createRoute(upstream),
  );

  app.get(
    "/broken",
    { schema: { response: { 200: MessageSchema, 500: MessageSchema } } },
    createRoute(broken),
  );
});

const collectingLogger = () => {
  const logger: Record<string, unknown> = {
    level: "error",
    silent: () => {},
    info: () => {},
    warn: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    error: (...args: unknown[]) => {
      loggedErrors.push(args[0]);
    },
    child: () => logger,
  };

  return logger as unknown as FastifyBaseLogger;
};

let app: FastifyInstance;

beforeEach(async () => {
  loggedErrors.length = 0;
  app = Fastify({ loggerInstance: collectingLogger() });
  await app.register(effectProviderPlugin);
  await app.register(testRoutes);
  await app.ready();
});

describe("createDynamicRouteHandler", () => {
  it("replies 200 with the controller's value", async () => {
    const response = await app.inject({ method: "GET", url: "/ok" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: "2026-08-13" });
  });

  it("honours the status carried by an HttpResponse", async () => {
    const response = await app.inject({ method: "POST", url: "/created" });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ message: "created" });
  });

  it("maps a tagged HttpError to its own status", async () => {
    const response = await app.inject({ method: "GET", url: "/missing" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ message: "nope" });
  });

  it("applies a custom error mapper (502 Bad Gateway)", async () => {
    const response = await app.inject({ method: "GET", url: "/upstream" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ message: "Bad Gateway" });
    // the mapped failure is still logged, cause and all
    expect(loggedErrors).toHaveLength(1);
  });

  it("replies 500 and logs the whole Cause on a defect", async () => {
    const response = await app.inject({ method: "GET", url: "/broken" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ message: "Internal server error" });
    expect(loggedErrors).toHaveLength(1);
    expect(String(loggedErrors[0])).toContain("boom");
  });

  it("does not run error mappers for failures already handled as HttpError", async () => {
    const response = await app.inject({ method: "GET", url: "/missing" });

    expect(response.statusCode).toBe(404);
    expect(loggedErrors).toHaveLength(0);
  });
});

describe("isHttpError", () => {
  it("accepts anything shaped like an HttpError", () => {
    expect(isHttpError(new NotFoundError())).toBe(true);
    expect(isHttpError({ statusCode: 418, message: "teapot" })).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isHttpError(new Error("boom"))).toBe(false);
    expect(isHttpError({ statusCode: "418" })).toBe(false);
    expect(isHttpError(null)).toBe(false);
    expect(isHttpError(undefined)).toBe(false);
  });
});

describe("extra statuses", () => {
  interface UpstreamStatuses extends ExtraStatusProvider {
    readonly statuses: [this["errors"]] extends [never]
      ? never
      : this["errors"] extends UpstreamError
        ? 502
        : never;
  }

  it("derives the extra statuses from the controller's error type", () => {
    expectTypeOf<
      ApplyExtraStatuses<UpstreamStatuses, UpstreamError>
    >().toEqualTypeOf<502>();
    expectTypeOf<
      ApplyExtraStatuses<UpstreamStatuses, NotFoundError>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      ApplyExtraStatuses<UpstreamStatuses, never>
    >().toEqualTypeOf<never>();
  });

  it("requires the extra status in the route's response schema", async () => {
    const { router: strictRouter } =
      createKeelWith<UpstreamStatuses>()(AppRuntime);

    const routes = strictRouter(async (app, createRoute) => {
      app.get(
        "/upstream",
        {
          schema: {
            // @ts-expect-error — 502 is missing from the response schema.
            response: { 200: MessageSchema, 500: MessageSchema },
          },
        },
        createRoute(upstream),
      );

      app.get(
        "/upstream-ok",
        {
          schema: {
            response: {
              ...errorsSchemasWithGateway([502]),
              200: MessageSchema,
            },
          },
        },
        createRoute(upstream),
      );
    });

    const strictApp = Fastify({ loggerInstance: collectingLogger() });
    await strictApp.register(effectProviderPlugin);
    await strictApp.register(routes);

    const response = await strictApp.inject({
      method: "GET",
      url: "/upstream-ok",
    });
    expect(response.statusCode).toBe(500);

    await strictApp.close();
  });
});
