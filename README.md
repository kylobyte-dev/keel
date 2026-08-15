# keel

Opinionated Fastify 5 + Effect backend framework — Effect Schema as type provider,
controllers as Effect services, tagged errors mapped to HTTP, Pino↔Effect logging, SSE.

Keel is glue only: no business logic, no application runtime. Your app builds its
own `ManagedRuntime` and hands it over.

- [Install](#install)
- [The shape of an app](#the-shape-of-an-app)
- [Bootstrap](#bootstrap)
- [Controllers](#controllers)
- [Routes](#routes)
- [Errors](#errors)
- [Schemas at the boundary](#schemas-at-the-boundary)
- [Runtime](#runtime)
- [OpenAPI](#openapi)
- [SSE](#sse)
- [SQL](#sql)
- [Testing](#testing)
- [Development](#development)

## Install

```bash
pnpm add @kylobyte/keel
```

One package, one version. Entry points:

| Import                              | What's in it                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `@kylobyte/keel`                    | The common surface: everything from `/http` plus `/runtime`                        |
| `@kylobyte/keel/http`               | Schema type provider, `controller()`, routers, response/error types                |
| `@kylobyte/keel/runtime`            | Pino↔Effect logger, `memoizedConfig`, `readonly`/`voidMemo`                        |
| `@kylobyte/keel/sse`                | `createSseHandlerFactory`                                                          |
| `@kylobyte/keel/sql`                | `createSql`, repositories, filters, table query params, `paginate`                 |
| `@kylobyte/keel/openapi`            | `openapiPlugin`, `createOpenapiMetaPlugin`                                         |
| `@kylobyte/keel/tsconfig.main.json` | The shared TypeScript config: `{ "extends": "@kylobyte/keel/tsconfig.main.json" }` |

`effect`, `fastify`, `pino`, `pino-pretty` and the `@fastify/*` plugins are **peer
dependencies**, never dependencies: two instances of `effect` in one process break
`Context.Tag` identity. `helmet`, `@fastify/helmet` and
`@scalar/fastify-api-reference` are optional peers — you only need them if you
import `/openapi`; `drizzle-orm`, `@effect/sql` and `@effect/sql-pg` are optional
peers for `/sql`, plus `snowyflake` if you use its id helper.

The `/sql` peers are pinned to exact versions rather than ranges. Drizzle's Effect
driver (`drizzle-orm/effect-postgres`) is prerelease and moves with `@effect/sql`,
which moves fast itself: a range would let a combination keel has never compiled
against resolve into your app. Bumping them is a keel release.

## The shape of an app

Keel does not impose a directory layout, but everything below assumes the one it was
extracted from: global plugins in one place, and a folder per feature holding its
routes, controllers, services and schemas side by side.

```
src/
├── index.ts                        # Fastify instance, listen, graceful shutdown
├── server/
│   ├── index.ts                    # plugin + router autoloading
│   └── plugins/
│       ├── effect.global.ts        # effectProviderPlugin
│       ├── errors.global.ts        # errorHandlerPlugin
│       ├── openapi.global.ts       # openapiPlugin
│       ├── auth.ts                 # per-router: JWT verification
│       └── openapiMeta.ts          # per-router: OpenAPI tag
├── shared/
│   └── app/
│       ├── keel.ts                 # createKeel(AppRuntime) → routers
│       ├── sql.ts                  # createSql(DatabaseService) → repositories
│       └── effect/runtime.ts       # the app's ManagedRuntime
├── services/                       # cross-feature services (db, redis, queues, ...)
└── modules/
    └── user/
        ├── user.router.ts          # routes + schemas
        ├── user.controller.ts      # HTTP-shaped Effects
        ├── user.service.ts         # business logic
        ├── user.queries.ts         # reads: filters, sorting, pagination
        ├── user.schemas.ts         # Effect Schemas for body/params/response
        └── db/user.repository.ts   # writes
```

A request goes through:

1. **Fastify validation** — the route's `body`/`params`/`querystring` schemas are
   decoded by the Effect validator. A failure never reaches your code: it becomes a
   400 from the error handler plugin.
2. **The router's request provider** — a `Layer` built from the `FastifyRequest`
   (the authenticated user, a tenant, a request-scoped logger).
3. **The controller** — receives the decoded `{ body, params, querystring }` and
   returns an Effect, run on the app runtime with that layer provided.
4. **The reply** — a plain value is sent as 200, an `HttpResponse` carries its own
   status, a tagged failure becomes its `statusCode`, anything else is a 500.
5. **Fastify serialization** — the response schema for the status being sent encodes
   the body. A body that does not match the schema is a 500, not a silent drift.

Headers are deliberately absent from step 3: a controller only sees validated input.
Anything read off the raw request — a token, a signature, an `Accept-Language` — is
turned into a service by the router's request provider, so the controller stays a
function of its input and its dependencies.

## Bootstrap

Keel never owns the application runtime. Each app builds its own `ManagedRuntime` and
hands it to `createKeel`, which closes over it and returns the router helpers; the
runtime's context flows into every controller's requirements from there.

```ts
// shared/app/effect/runtime.ts
import { Layer, ManagedRuntime } from "effect";
import { DatabaseService } from "../../../services/database/database.service.ts";
import { RedisService } from "../../../services/redis/redis.service.ts";

const layer = Layer.mergeAll(DatabaseService.Default, RedisService.Default);

export const AppRuntime = ManagedRuntime.make(layer);
export type AppRuntimeContext =
  typeof AppRuntime extends ManagedRuntime.ManagedRuntime<infer R, any>
    ? R
    : never;
```

Everything in that layer is a process-wide singleton: one connection pool, one Redis
client, one queue producer, shared by every request. Services that are cheap and
request-scoped go on the controller instead (see [Controllers](#controllers)).

```ts
// shared/app/keel.ts
import { createKeel } from "@kylobyte/keel";
import { createSseHandlerFactory } from "@kylobyte/keel/sse";
import { AppRuntime } from "./effect/runtime.ts";

export const { router, createRouter, createRouterWithErrors } =
  createKeel(AppRuntime);

export const createSseHandler = createSseHandlerFactory(AppRuntime);
```

```ts
// modules/people/people.router.ts
import { errorsSchemas } from "@kylobyte/keel";
import { router } from "../../shared/app/keel.ts";
import { getPerson } from "./people.controller.ts";

export default router(async (app, createRoute) => {
  app.get(
    "/people/:id",
    { schema: { response: { ...errorsSchemas([404]), 200: PersonSchema } } },
    createRoute(getPerson),
  );
});
```

A controller whose requirements the runtime cannot satisfy is a compile error at the
route definition — that inference is the point of the whole design.

### Wiring Fastify

Two global plugins are mandatory, and both must be registered before any router:
`effectProviderPlugin` installs Effect Schema as the validator and serializer, and
`errorHandlerPlugin` catches everything raised outside the Effect pipeline.

```ts
// server/plugins/effect.global.ts
export { effectProviderPlugin as default } from "@kylobyte/keel";

// server/plugins/errors.global.ts
export { errorHandlerPlugin as default } from "@kylobyte/keel";
```

```ts
// server/index.ts
import AutoLoad from "@fastify/autoload";
import Cors from "@fastify/cors";
import Helmet from "@fastify/helmet";
import type { FastifyInstance } from "fastify";
import path from "node:path";

export async function createServer(fastify: FastifyInstance) {
  await fastify.register(Helmet, {
    global: true,
    contentSecurityPolicy: false,
  });
  await fastify.register(Cors, {
    origin:
      process.env.CORS_ORIGIN?.split(",").map((origin) => origin.trim()) ??
      false,
    credentials: true,
  });

  await fastify.register(AutoLoad, {
    dir: path.join(import.meta.dirname, "plugins"),
    dirNameRoutePrefix: false,
    matchFilter: (filePath) => /\.global\.(ts|js)$/.test(filePath),
  });

  await fastify.register(AutoLoad, {
    dir: path.join(import.meta.dirname, "../modules"),
    dirNameRoutePrefix: false,
    options: { prefix: "/api" },
    matchFilter: (filePath) => /\.router\.(ts|js)$/.test(filePath),
  });

  return fastify;
}
```

Autoloading is a convenience, not a requirement — a router is a plain Fastify plugin,
so `fastify.register(peopleRouter, { prefix: "/api" })` works just as well. What does
matter is the order: the type provider first, then the routers.

The entrypoint owns the Fastify instance, and hands keel's Pino instance to it so
Fastify's own logs and the Effect logs land in the same stream:

```ts
// index.ts
import { pinoInstance } from "@kylobyte/keel/runtime";
import { Effect } from "effect";
import Fastify, { type FastifyBaseLogger } from "fastify";
import { randomUUID } from "node:crypto";
import { createServer } from "./server/index.ts";
import { AppRuntime } from "./shared/app/effect/runtime.ts";
import { getServerConfig } from "./shared/config/index.ts";

const fastify = Fastify({
  loggerInstance: pinoInstance as FastifyBaseLogger,
  genReqId: (request) =>
    (request.headers["request-id"] as string) ?? randomUUID(),
});

await createServer(fastify);
await AppRuntime.runPromise(Effect.void); // build the layer before serving

const { port, host } = getServerConfig();
await fastify.listen({ port, host });
```

Running `Effect.void` on the runtime forces the layer to build at boot: a missing
environment variable or an unreachable database fails there, loudly, instead of on the
first request. On the way out, `AppRuntime.dispose` releases everything the layer
acquired — wire it into whatever handles shutdown (`@gquittet/graceful-server`,
`process.on("SIGTERM")`, your platform's hook).

## Controllers

A controller is an Effect built from validated input, plus the layers it needs.
`controller()` brands the result so only a real controller can be handed to
`createRoute`.

```ts
// modules/user/user.controller.ts
import {
  controller,
  HttpCreated,
  NotFoundError,
  type Body,
  type Params,
} from "@kylobyte/keel";
import { Effect } from "effect";
import { UserService } from "./user.service.ts";

export const getUser = controller(
  ({ params }: Params<{ id: bigint }>) =>
    Effect.gen(function* () {
      const users = yield* UserService;
      const user = yield* users.findById(params.id);

      if (!user) return yield* new NotFoundError("User not found");

      return user;
    }),
  [UserService.Default],
);

export const createUser = controller(
  ({ body }: Body<CreateUserBody>) =>
    Effect.gen(function* () {
      const users = yield* UserService;

      return new HttpCreated(yield* users.create(body));
    }),
  [UserService.Default],
);
```

`Params<T>`, `Query<T>` and `Body<T>` are the input shapes, and they intersect for a
route that uses more than one:

```ts
({ params, body }: Params<{ id: bigint }> & Body<UpdateUserBody>) => ...
```

The input type is the contract with the route: `params.id` is a `bigint` here because
the route's `params` schema decodes to one. Declare a field the schema does not
produce and the route stops compiling.

The second argument is the layer list. It is optional, and it is not where every
dependency goes:

- **In the runtime layer** — anything that must be a singleton (connection pools,
  queues, event buses) or is shared by most routes.
- **In the controller's layers** — services specific to this feature. They are built
  per request, which is what you want for something cheap that closes over
  request-scoped state.

`controller()` returns two handlers:

| Property                     | What it is                                             |
| ---------------------------- | ------------------------------------------------------ |
| `Default`                    | The handler with its layers provided — what routes use |
| `DefaultWithoutDependencies` | The raw handler — what tests provide mocks to          |

### What a controller returns

A plain value is sent with status 200. Anything else is an `HttpResponse`:

| Return                         | Status | Body    |
| ------------------------------ | ------ | ------- |
| `value`                        | 200    | `value` |
| `new HttpCreated(value)`       | 201    | `value` |
| `new HttpAccepted(value)`      | 202    | `value` |
| `new HttpNoContent()`          | 204    | empty   |
| `new HttpResponse(207, value)` | 207    | `value` |

The status is not a runtime detail: the response schema of the route is derived from
the controller's return type, so a controller that can return `HttpCreated` forces the
route to declare a `201` schema (`204` pairs with `S.Void`). A union of returns —
`Effect<User | HttpNoContent>` — requires both keys.

## Routes

A router is an async function over `(app, createRoute)`, exported as the module's
default. `app` is a Fastify instance typed with the Effect type provider, so route
schemas are Effect Schemas and their decoded types flow into the handler.

```ts
// modules/user/user.router.ts
import { errorsSchemas, BigIntIdSchema } from "@kylobyte/keel";
import { paginatedSchema } from "@kylobyte/keel/sql";
import { Schema as S } from "effect";
import { router } from "../../shared/app/keel.ts";
import {
  createUser,
  deleteUser,
  getUser,
  listUsers,
} from "./user.controller.ts";
import {
  CreateUserBodySchema,
  UserQuerySchema,
  UserSchema,
} from "./user.schemas.ts";

export default router(async (app, createRoute) => {
  app.get(
    "/users",
    {
      schema: {
        summary: "List users",
        querystring: UserQuerySchema,
        response: { ...errorsSchemas([400]), 200: paginatedSchema(UserSchema) },
      },
    },
    createRoute(listUsers),
  );

  app.get(
    "/users/:id",
    {
      schema: {
        summary: "Get user",
        params: S.Struct({ id: BigIntIdSchema }),
        response: { ...errorsSchemas([404]), 200: UserSchema },
      },
    },
    createRoute(getUser),
  );

  app.post(
    "/users",
    {
      schema: {
        summary: "Create user",
        body: CreateUserBodySchema,
        response: { ...errorsSchemas([400, 409]), 201: UserSchema },
      },
    },
    createRoute(createUser),
  );

  app.delete(
    "/users/:id",
    {
      schema: {
        summary: "Delete user",
        params: S.Struct({ id: BigIntIdSchema }),
        response: { ...errorsSchemas([404]), 204: S.Void },
      },
    },
    createRoute(deleteUser),
  );
});
```

`createRoute(controller)` is where the whole design pays off. It checks three things
at compile time:

- the controller's **requirements** are satisfied by the runtime plus the router's
  request provider;
- the controller's **return type** matches the success schemas declared on the route;
- every status the controller's **error type** maps to has a schema on the route.

So a controller that can fail with `NotFoundError` and whose route forgets
`404` does not compile, and the OpenAPI document cannot drift from what the code
actually does.

### Routers with request context

`createRouter(requestProvider, registerPlugins?)` builds a router whose controllers
receive extra services derived from the request. `requestProvider` maps a
`FastifyRequest` to a `Layer`; `registerPlugins` registers Fastify plugins (auth
hooks, rate limits) on the router's scope before the routes are defined.

```ts
// shared/app/keel.ts
import { Context, Effect, Layer, Logger } from "effect";
import { PinoLogger } from "@kylobyte/keel/runtime";
import { UnauthorizedError } from "@kylobyte/keel";
import { authPlugin } from "../../server/plugins/auth.ts";
import { UserService } from "../../modules/user/user.service.ts";

export class CurrentUser extends Context.Tag("CurrentUser")<
  CurrentUser,
  { id: bigint; email: string | null; permissions: ReadonlySet<string> }
>() {}

export const authenticatedRouter = createRouterWithErrors<UnauthorizedError>()(
  (request) =>
    Layer.merge(
      Logger.replace(Logger.defaultLogger, PinoLogger),
      Layer.effect(
        CurrentUser,
        Effect.gen(function* () {
          const users = yield* UserService;
          const user = yield* users.findOrCreate(request.user.sub);

          return {
            id: user.id,
            email: user.email,
            permissions: permissionsFor(user),
          };
        }).pipe(Effect.orDie),
      ).pipe(Layer.provide(UserService.Default)),
    ),
  async (app) => {
    await app.register(authPlugin);
  },
);
```

Controllers on that router `yield* CurrentUser` and get the caller, with no parameter
threading and no `request` in sight:

```ts
export const getMe = controller(
  () =>
    Effect.gen(function* () {
      const { id } = yield* CurrentUser;
      const users = yield* UserService;

      return yield* users.findById(id);
    }),
  [UserService.Default],
);
```

The layer is built per request, and `Effect.orDie` is deliberate: a failure while
resolving the caller is a defect (500), not a business error — the auth plugin has
already rejected anyone who is not authenticated.

`createRouterWithErrors<E>()` is the same factory with a fixed error type added to
every route on the router. Authentication fails in a Fastify hook, outside the Effect
pipeline, so no controller's error type mentions it; declaring it on the router is
what forces every route to carry a `401` schema.

`router` is the plain factory: no request context beyond the Pino logger, and no
extra errors. Use it for public routes.

## Errors

A controller fails with a tagged error. Keel maps any failure carrying a numeric
`statusCode` to that status, with `{ message }` as the body:

| Error                 | Status |
| --------------------- | ------ |
| `BadRequestError`     | 400    |
| `UnauthorizedError`   | 401    |
| `ForbiddenError`      | 403    |
| `NotFoundError`       | 404    |
| `ConflictError`       | 409    |
| `InternalServerError` | 500    |

Each takes an optional message and defaults to the reason phrase. They are
`Data.TaggedError`s, so `yield* new NotFoundError("User not found")` fails the Effect
and, in a `catchTag`, narrows by `_tag`.

`errorsSchemas([404, 409])` builds the matching response schemas — `500` is always
included, since any route can die. The type-level rule is one-directional: a status
the controller can produce **must** be declared, but declaring an extra one is
allowed, which is how a route documents a 401 raised by an auth hook.

Anything that fails outside the Effect pipeline — schema validation, a throw inside a
plugin or hook — is caught by `errorHandlerPlugin`:

- a validation failure → 400, `{ statusCode, error, message, details }`, where
  `details` lists the offending paths;
- a thrown error carrying a `statusCode` (an `UnauthorizedError` from an auth hook) →
  that status;
- anything else → 500, logged in full.

One consequence worth knowing: when the route declares a response schema for that
status, the body is encoded through it before it goes out, and `HttpErrorSchema` keeps
only `message`. A 400 from validation reaches the client as `{"message":"Validation
failed"}` — the `details` are in the logs, not on the wire. That is the intended
trade-off (no schema internals leak to callers); a route that wants to return them
declares its own richer 400 schema.

### App-specific statuses

An app that maps its own error family to a status teaches keel about it in two places —
a runtime `ErrorMapper` and a type-level `ExtraStatusProvider`:

```ts
interface HttpClientExtraStatuses extends ExtraStatusProvider {
  readonly statuses: [this["errors"]] extends [never]
    ? never
    : this["errors"] extends HttpClientError
      ? 502
      : never;
}

export const { router } = createKeelWith<HttpClientExtraStatuses>()(
  AppRuntime,
  {
    errorMappers: [
      (error) =>
        isHttpClientError(error)
          ? { statusCode: 502, body: { message: "Bad Gateway" } }
          : undefined,
    ],
  },
);
```

The provider makes `502` a required key of the response schema of every route whose
controller can fail with that family, so the OpenAPI document cannot drift from the
runtime behaviour. Mappers run in order, after the `statusCode` check and before the
500 fallback; the first to return a value wins, and the original cause is logged.

The schema side needs widening too, since `errorsSchemas` only knows keel's statuses:

```ts
// shared/parsing.ts
export const errorsSchemas = makeErrorsSchemas<HttpError["statusCode"] | 502>({
  ...errorSchemasDescriptions,
  502: "Bad Gateway",
});
```

Import that helper instead of keel's throughout the app, and `errorsSchemas([502])`
starts type-checking.

## Schemas at the boundary

`effectProviderPlugin` makes Effect Schema the validator and the serializer:
`S.decodeUnknown` on the way in, `S.encodeUnknown` on the way out. So the schema's
**decoded** type is what controllers see, and the **encoded** type is what travels —
a `S.BigInt` field is a `bigint` in your code and a string on the wire, and the
transformation happens in one place.

Serialization is strict. A response that does not match its schema throws
`ResponseSerializationError` (500) with the parse error logged, rather than sending a
body the OpenAPI document does not describe.

Two helpers exist because JSON Schema generation needs a hint:

```ts
import { BigIntIdSchema, parseJsonParam } from "@kylobyte/keel";

// A 64-bit id: `bigint` in code, string in JSON, documented as a string
params: S.Struct({ id: BigIntIdSchema }),

// GET /users?filter={"role":"admin"} — validated as an object, documented as one
querystring: S.Struct({ filter: S.optional(parseJsonParam(UserFilterSchema)) }),
```

Without the annotations, the generated document would describe the decoded `bigint`
and a bare `string` respectively.

Schemas are also where response shaping happens. Keep a schema per resource in
`*.schemas.ts` and derive the types from it, so the response type and the document
stay one artifact:

```ts
export const UserSchema = S.Struct({
  id: BigIntIdSchema,
  name: S.String,
  email: S.NullOr(S.String),
  createdAt: S.Date,
});
export type User = S.Schema.Type<typeof UserSchema>;
```

## Runtime

`@kylobyte/keel/runtime` is the small non-HTTP surface.

**Logging.** `pinoInstance` is the shared Pino logger — it redacts
`headers.authorization` and goes through `pino-pretty`. `PinoLogger` is the Effect
`Logger` that writes to it, mapping Effect's log levels onto Pino's and rendering
annotations, spans, fiber id and the full `Cause`. Every router built by keel replaces
the default Effect logger with it, and keel annotates each request's logs with
`requestId` and `requestPath`, so a log line inside a controller carries the request it
belongs to:

```ts
yield *
  Effect.logInfo("provisioning started").pipe(
    Effect.annotateLogs("nodeId", String(node.id)),
  );
```

**Config.** `memoizedConfig` runs an Effect built from `Config` descriptors once,
synchronously, and caches the result:

```ts
// shared/config/index.ts
import { memoizedConfig } from "@kylobyte/keel/runtime";
import { Config, Effect } from "effect";

export const getServerConfig = memoizedConfig(
  Effect.gen(function* () {
    const port = yield* Config.number("SERVER_PORT");
    const host = yield* Config.nonEmptyString("SERVER_HOST");

    return { port, host };
  }),
);
```

A missing or malformed variable throws at the first call rather than being threaded
through the request path as an error channel. Call the getter at boot — in the
entrypoint, or in a service's constructor Effect — so the failure happens at startup.

**Utilities.** `readonly(value)` is a type-level cast to `Readonly<T>` (keel applies it
to every controller result). `voidMemo(getter)` is the one-shot memoizer
`memoizedConfig` is built on.

## OpenAPI

`openapiPlugin` wires `@fastify/swagger` to the Effect Schema transform and mounts the
Scalar UI. Register it globally, before the routers.

```ts
// server/plugins/openapi.global.ts
import { openapiPlugin } from "@kylobyte/keel/openapi";
import { tags } from "../../openapi/tags.ts";
import { getJWKSConfig } from "../../shared/config/index.ts";

export default openapiPlugin({
  info: {
    title: "Example API",
    version: "1.0.0",
    description: "What this service does.",
  },
  tags,
  servers: [
    { description: "Local server", url: "https://api.example.internal" },
  ],
  securitySchemes: {
    bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
  },
  skipList: [/^docs\//],
});
```

| Option               | Default | What it does                                                      |
| -------------------- | ------- | ----------------------------------------------------------------- |
| `info`               | —       | The document's `info` block                                       |
| `tags`               | —       | Tag catalogue, keyed by name, with descriptions and external docs |
| `servers`            | —       | The `servers` list                                                |
| `securitySchemes`    | —       | `components.securitySchemes`                                      |
| `skipList`           | `[]`    | Routes hidden from the document, by URL substring or regexp       |
| `routePrefix`        | `/docs` | Where the Scalar UI is mounted                                    |
| `cspDirectives`      | —       | CSP directives merged over the defaults Scalar needs              |
| `redirectRootToDocs` | `true`  | `GET /` → the docs                                                |

A route is hidden from the document either through `skipList` or with
`schema: { hide: true }`.

Tags are stamped per router rather than per route. Instantiate the plugin once over
the app's tag union, then register it at the top of each router:

```ts
// server/plugins/openapiMeta.ts
import { createOpenapiMetaPlugin } from "@kylobyte/keel/openapi";
import type { tags } from "../../openapi/tags.ts";

export const openapiMetaPlugin = createOpenapiMetaPlugin<keyof typeof tags>();
```

```ts
export default authenticatedRouter(async (app, createRoute) => {
  await app.register(openapiMetaPlugin, { tag: "User" });

  // every route defined below is tagged "User"
});
```

It works through an `onRoute` hook and **replaces** `schema.tags`, so a route cannot
opt into a second tag while the plugin is registered — one router, one tag.

The transform behind all this (`jsonSchemaTransform`, also exported from `/http` if you
need to build the Swagger registration yourself) runs `JSONSchema.make` per schema and
then inlines local `$defs`. Effect emits reusable definitions as `$ref: "#/$defs/Name"`,
which resolves against the document root — where `$defs` does not exist, since it sits
nested inside the route schema. Scalar tolerates the dangling ref; strict bundlers like
`openapi-typescript` do not. Inlining makes every schema self-contained; a recursive
schema is left as-is rather than expanded forever.

## SSE

`createSseHandlerFactory(runtime)` returns a factory for Server-Sent Events handlers.
An SSE handler is a plain Fastify handler, not a controller: it hijacks the reply and
writes frames itself, so it goes on the route directly, without `createRoute`.

```ts
// shared/app/keel.ts
export const createSseHandler = createSseHandlerFactory(AppRuntime);
```

```ts
// modules/events/events.stream.ts
import { Effect, Stream } from "effect";
import { createSseHandler } from "../../shared/app/keel.ts";
import { EventBusService } from "../../services/events/event-bus.service.ts";
import { TicketService } from "./ticket.service.ts";

export const eventsStreamHandler = createSseHandler({
  authorize: (request) =>
    Effect.gen(function* () {
      const { ticket } = request.query as { ticket: string };
      const tickets = yield* TicketService;
      const userId = yield* tickets.consume(ticket);

      if (!userId) {
        return yield* Effect.fail({
          statusCode: 401,
          message: "Invalid or expired ticket",
        });
      }

      return { userId };
    }),

  buildStream: (context, reply) =>
    Effect.scoped(
      Effect.gen(function* () {
        const bus = yield* EventBusService;
        const dequeue = yield* bus.subscribe(context.userId);

        yield* Stream.fromQueue(dequeue).pipe(
          Stream.tap((event) =>
            Effect.sync(() =>
              reply.raw.write(
                `event: status\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            ),
          ),
          Stream.runDrain,
        );
      }),
    ),
});
```

```ts
// modules/events/events.router.ts
export default router(async (app) => {
  app.get(
    "/events",
    {
      schema: {
        summary: "Stream events",
        querystring: S.Struct({ ticket: S.String }),
        response: { ...errorsSchemas([401]) },
      },
    },
    eventsStreamHandler,
  );
});
```

The split between the two callbacks is the point:

- `authorize` runs **before** the reply is hijacked, so a failure still goes out as a
  normal JSON response with the right status. It fails with
  `{ statusCode, message }`; anything else becomes a 500.
- `buildStream` runs **after**, in a fiber. When the client disconnects the fiber is
  interrupted, which releases everything the scope acquired — the queue subscription
  above included. It cannot fail (`Effect<void, never, R>`): handle errors inside, or
  the stream ends silently.

Headers set by other plugins (CORS, for one) are copied onto the raw response before
the headers are flushed, since hijacking bypasses Fastify's `onSend` lifecycle. Keel
sets `text/event-stream`, `no-cache` and `X-Accel-Buffering: no`, and closes the
response when the stream ends.

Two things keel does not do: framing (write `event:`/`data:` lines yourself — the shape
is up to your protocol) and authentication via headers. Browsers cannot set headers on
an `EventSource`, hence the single-use ticket in the example: a short-lived token
issued by a normal authenticated `POST`, spent by the stream.

## SQL

`@kylobyte/keel/sql` is Drizzle over `@effect/sql-pg`: a write-only repository
builder, and a query layer that turns HTTP query params into filtered, sorted,
paginated SQL. It needs three optional peers, and a fourth for the id helper:

```bash
pnpm add drizzle-orm@1.0.0-beta.22 @effect/sql@0.48.6 @effect/sql-pg@0.49.7
pnpm add snowyflake@2.0.1   # only if you use snowflakeId()
```

`pg` comes along as a dependency of `@effect/sql-pg`; install it directly only if
your own code imports it — overriding type parsers, say.

Same deal as the runtime: keel does not own the connection. The app builds its own
Drizzle Effect service — it decides which variable holds the URL, how the pool is
configured, which `pg` type parsers are overridden — and hands the tag to
`createSql`, which closes over it and returns the helpers. The tag then flows into
the requirements of every repository built from it.

```ts
// services/database/database.service.ts
import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Config, Effect } from "effect";

const PgClientLive = PgClient.layerConfig({
  url: Config.redacted("DATABASE_URL"),
});

export class DatabaseService extends Effect.Service<DatabaseService>()(
  "DatabaseService",
  {
    effect: PgDrizzle.make().pipe(Effect.provide(PgDrizzle.DefaultServices)),
    dependencies: [PgClientLive],
  },
) {}
```

```ts
// shared/app/sql.ts
import { createSql } from "@kylobyte/keel/sql";
import { DatabaseService } from "../../services/database/database.service.ts";

export const { buildRepository } = createSql(DatabaseService);
```

### Schema and ids

Ordinary Drizzle. The one keel-flavoured piece is `snowflakeId()`: a `bigint`
primary key defaulted to a Snowflake minted in the application, so an insert knows
its own id before the round trip and ids sort by creation time. It needs the
`snowyflake` peer.

```ts
import { snowflakeId } from "@kylobyte/keel/sql";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: snowflakeId(),
  name: text().notNull(),
  email: text(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DbUser = typeof users.$inferSelect;
```

Drizzle only infers a column name from the property when you leave it blank, so
multi-word columns need the snake_case name spelled out — `timestamp("created_at")`
above, not `timestamp()` — or camelCase leaks into the database.

Snowflakes are a default, not a requirement: nothing else in `/sql` refers to them.
`buildRepository` reads the type of the `id` column off the table, so a `uuid` or
`text` key works with no configuration — just don't import the helper.

```ts
export const sessions = pgTable("sessions", {
  id: uuid().defaultRandom().primaryKey(),
  token: text().notNull(),
});
```

The shared generator uses worker id 0 and process id 0, which two processes writing
in the same millisecond would eventually collide on. A deployment that writes from
several processes passes one generator per process:

```ts
const ids = new Snowyflake({ workerId: BigInt(process.env.WORKER_ID!) });

export const events = pgTable("events", {
  id: snowflakeId(() => ids.nextId()),
});
```

On the wire, a 64-bit id travels as a string — JSON has no integer wide enough —
which is what `BigIntIdSchema` from `@kylobyte/keel` encodes, annotation included so
the OpenAPI document says `string` rather than describing the decoded `bigint`.

### Repositories

`buildRepository(table)` is write-only: `insert`, `update`, `delete`, keyed on the
table's `id` column. Reads — including simple ID lookups — belong in feature-specific
query services that use the database service directly, where the projection and the
joins stay visible at the call site.

```ts
// modules/user/db/user.repository.ts
export class UserRepositoryService extends Effect.Service<UserRepositoryService>()(
  "repository/User",
  {
    effect: buildRepository(users),
    dependencies: [DatabaseService.Default],
  },
) {}
```

`insert` and `update` return the written row, or `null` when nothing was written —
an `update` against an id that no longer exists is not an error, it is a `null` the
caller decides what to do with.

Extend the repository with anything the generic three cannot express:

```ts
export class UserRepositoryService extends Effect.Service<UserRepositoryService>()(
  "repository/User",
  {
    effect: Effect.gen(function* () {
      const repository = yield* buildRepository(users);

      return {
        ...repository,
        setSftpCredentials: (id: bigint, sftpUsername: string) =>
          repository.update(id, { sftpUsername }),
      };
    }),
    dependencies: [DatabaseService.Default],
  },
) {}
```

`withTx` reissues the same operations through a running transaction, so writes that
must land together do:

```ts
const createPlan = (body: CreatePlanBody) =>
  Effect.gen(function* () {
    const database = yield* DatabaseService;
    const planRepo = yield* PlanRepositoryService;
    const priceRepo = yield* PlanPriceRepositoryService;

    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const plan = yield* planRepo.withTx(transaction).insert(body.plan);

        if (!plan) return yield* new ConflictError("Failed to create plan");

        yield* priceRepo.withTx(transaction).insert({
          planId: plan.id,
          ...body.price,
        });

        return plan;
      }),
    );
  });
```

A failure inside the callback rolls the transaction back, tagged errors included.

### Filters, sorting, pagination

`defineFilter` bundles an Effect Schema with a Drizzle condition per field. Adding a
field is one change: HTTP validation and SQL generation both follow from it.

```ts
// modules/user/user.queries.ts
const userFilter = defineFilter({
  name: field(StringOps, (op) => applyStringOp(users.name, op)),
  createdAt: field(DateOps, (op) => applyDateOp(users.createdAt, op)),
  role: field(RoleSchema, (role) => eq(users.role, role)),
});

export const UserQuerySchema = S.Struct({
  ...tableQueryFields, // sort, dir, q, page, pageSize
  sort: S.optional(S.Literal("name", "email", "createdAt")),
  filter: S.optional(parseJsonParam(userFilter.schema)),
});
export type UserQuery = S.Schema.Type<typeof UserQuerySchema>;
```

`StringOps` accepts `{ eq }`, `{ neq }`, `{ like }` and `{ in }`; `DateOps` accepts
`{ gte }`, `{ lte }` and `{ between }`. A field can also take any schema of your own,
as `role` does above. `filter` arrives JSON-encoded in the query string —
`parseJsonParam` decodes it and keeps the OpenAPI document showing the object rather
than a bare string, so `GET /users?filter={"role":"admin"}` is both validated and
documented.

`tableQueryFields` is the flat set every list endpoint shares: `sort`, `dir`, `q`,
`page` (default 1) and `pageSize` (default 20, capped at 100). Spread it rather than
using `TableQuerySchema` directly whenever the route narrows `sort` to its own
columns, as above.

```ts
export class UserQueryService extends Effect.Service<UserQueryService>()(
  "query/User",
  {
    effect: Effect.gen(function* () {
      const database = yield* DatabaseService;

      return {
        listPaginated: (query: UserQuery) => {
          const where = userFilter.buildWhere(query.filter ?? {}, [
            query.q
              ? or(
                  ilike(users.name, `%${escapeWildcards(query.q)}%`),
                  ilike(users.email, `%${escapeWildcards(query.q)}%`),
                )
              : undefined,
          ]);

          return paginate<DbUser>(
            database,
            database
              .select()
              .from(users)
              .where(where)
              .orderBy(buildOrderBy(getColumns(users), query) ?? asc(users.id)),
            query,
          );
        },
      };
    }),
    dependencies: [DatabaseService.Default],
  },
) {}
```

`buildWhere` ANDs the decoded fields together, skipping the absent ones, and takes
extra conditions the schema cannot express — the free-text `q` above. It returns
`undefined` when there is nothing to filter by, which `.where()` accepts as "no
filter".

Three things worth knowing:

- The column map handed to `buildOrderBy` is the allow-list. A `sort` naming anything
  outside it yields `undefined` and the caller's default ordering applies, so an
  unknown column cannot fail the request or reach the query.
- User input reaching `ilike` goes through `escapeWildcards`, or a search for `100%`
  matches every row.
- `paginate` counts over the filtered but unpaginated query, concurrently with the
  page itself. It takes the count subquery before applying `limit`/`offset` — those
  mutate the Drizzle builder in place, and a swap of the two lines would make `total`
  quietly agree with `items.length` on every page.

The route ties it together, `paginatedSchema` describing the response:

```ts
// modules/user/user.controller.ts
export const listUsers = controller(
  ({ querystring }: Query<UserQuery>) =>
    Effect.gen(function* () {
      const users = yield* UserQueryService;

      return yield* users.listPaginated(querystring);
    }),
  [UserQueryService.Default],
);

// modules/user/user.router.ts
export default router(async (app, createRoute) => {
  app.get(
    "/users",
    {
      schema: {
        querystring: UserQuerySchema,
        response: {
          ...errorsSchemas([401, 403]),
          200: paginatedSchema(UserSchema),
        },
      },
    },
    createRoute(listUsers),
  );
});
```

### Migrations

Keel ships nothing here — no schema, no migration directory, no CLI. The setup below
is the one `/sql` is designed to sit on: **drizzle-kit** describes the schema,
**Atlas** diffs it and versions the SQL. Swap either half if you prefer something
else; `/sql` neither knows nor cares.

```bash
pnpm add -D drizzle-kit
curl -sSf https://atlasgo.sh | sh   # or: go install ariga.io/atlas/cmd/atlas@latest
```

drizzle-kit's only job is to export the schema for Atlas to read:

```ts
// drizzle.config.ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  dialect: "postgresql",
});
```

```hcl
# atlas.hcl
data "external_schema" "drizzle" {
  program = ["pnpm", "exec", "drizzle-kit", "export"]
}

env "local" {
  src = data.external_schema.drizzle.url
  url = "postgresql://postgres:postgres@localhost:5432/app?sslmode=disable"
  dev = "docker://postgres/16/dev?search_path=public"
  migration {
    dir    = "file://migrations"
    format = atlas
  }
}

env "production" {
  src = data.external_schema.drizzle.url
  url = getenv("DATABASE_URL")
  dev = "docker://postgres/16/dev?search_path=public"
  migration {
    dir    = "file://migrations"
    format = atlas
  }
}
```

`url` is the database being migrated; `dev` is a throwaway one Atlas starts to
compute the diff against, and discards.

```jsonc
// package.json
"migrate:diff":        "atlas migrate diff --env local",
"migrate:apply:local": "atlas migrate apply --env local",
"migrate:apply":       "atlas migrate apply --env production",
"migrate:status":      "atlas migrate status --env local",
"migrate:lint":        "atlas migrate lint --env local --git-base main",
"migrate:hash":        "atlas migrate hash --env local",
```

The loop: edit the Drizzle schema, generate the migration, read the SQL it wrote,
apply it.

```bash
pnpm migrate:diff add_user_email   # writes migrations/<timestamp>_add_user_email.sql
pnpm migrate:apply:local
pnpm migrate:status
```

Atlas keeps a checksum of the directory in `migrations/atlas.sum`, and refuses to
apply anything once a file stops matching it. So a migration edited or written by
hand — which is the only option where no database is reachable, as in CI — has to be
followed by `pnpm migrate:hash`, and the `.sql` file and `atlas.sum` committed
together.

Read the generated SQL before applying it. A rename reaches Atlas as a drop plus an
add, which is a silent way to lose a column's data; `pnpm migrate:lint` flags that
class of change against the base branch.

## Testing

A controller is an Effect, so it is tested without HTTP: run
`DefaultWithoutDependencies` and provide mocks for exactly the services it uses. What
`Default` provides is irrelevant here — that is the point of the two handlers.

```ts
// modules/user/user.controller.test.ts
import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { NotFoundError } from "@kylobyte/keel";
import { getUser } from "./user.controller.ts";
import { UserService } from "./user.service.ts";

const makeUserService = (overrides: Partial<UserService> = {}) =>
  Layer.succeed(
    UserService,
    UserService.make({
      findById: () => Effect.succeed(mockUser),
      ...overrides,
    }),
  );

describe("getUser", () => {
  it("returns the user", async () => {
    const result = await Effect.runPromise(
      getUser
        .DefaultWithoutDependencies({ params: { id: 1n } })
        .pipe(Effect.provide(makeUserService())),
    );

    expect(result).toEqual(mockUser);
  });

  it("fails with 404 when the user does not exist", async () => {
    const exit = await Effect.runPromiseExit(
      getUser
        .DefaultWithoutDependencies({ params: { id: 1n } })
        .pipe(
          Effect.provide(
            makeUserService({ findById: () => Effect.succeed(null) }),
          ),
        ),
    );

    expect(exit).toStrictEqual(Exit.fail(new NotFoundError("User not found")));
  });
});
```

Request-scoped context is provided the same way: `Effect.provideService(CurrentUser, …)`
for a controller that reads the caller.

For the wiring itself — status codes, serialization, validation — build a Fastify
instance and use `inject`. This is the level at which a route's response schema, its
error mapping and its 400s are actually exercised:

```ts
const app = Fastify({ loggerInstance: silentLogger() });
await app.register(effectProviderPlugin);
await app.register(errorHandlerPlugin);
await app.register(userRouter);
await app.ready();

const response = await app.inject({ method: "GET", url: "/users/1" });

expect(response.statusCode).toBe(200);
expect(response.json()).toEqual({ id: "1", name: "Ada", email: null });
```

Note the id: `inject` gives you the encoded body, so this is also where you catch a
schema whose wire format is not what the client expects.

## Development

```bash
pnpm install       # `prepare` compiles the package
pnpm check-types   # tsc over sources and tests
pnpm test          # vitest
pnpm pack          # what would actually ship
```
