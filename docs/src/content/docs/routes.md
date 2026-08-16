---
title: "Routes"
description: "Declaring routes with Effect Schema as the type provider, and routers carrying request context."
---

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

## Routers with request context

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

export class CurrentUser extends Context.Service<
  CurrentUser,
  { id: bigint; email: string | null; permissions: ReadonlySet<string> }
>()("CurrentUser") {}

export const authenticatedRouter = createRouterWithErrors<UnauthorizedError>()(
  (request) =>
    Layer.merge(
      Logger.layer([PinoLogger]),
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
      ).pipe(Layer.provide(UserService.layer)),
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
  [UserService.layer],
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

Note the `Logger.replace(…, PinoLogger)` merged into the layer above: supplying your own
request provider replaces the default one, and the default is what installs the Pino
logger. Leave it out and Effect logs from that router's routes stop going to your Pino
stream.

[Adding authentication](/keel/tutorials/authentication/) builds this whole setup step by
step — the verification hook, the tag, the router and the tests.
