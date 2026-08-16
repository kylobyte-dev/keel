---
title: "Adding authentication"
description: "Step by step: a verification hook, the caller as an Effect service, an authenticated router, and 401s that the OpenAPI document knows about."
---

Authentication in a keel app is split across two mechanisms that look unrelated until
you have written it once:

- a **Fastify hook** rejects anyone without a valid credential, before Effect is
  involved at all;
- a **request layer** turns the surviving credential into a service, so controllers ask
  for `CurrentUser` instead of reading a header.

This tutorial builds both, plus the piece that ties them together — making every route
on the router document its `401` even though no controller can produce one.

**Starting point** is an app from [Your first app](/keel/tutorials/first-app/). The
token verification here uses `jose` against a JWKS endpoint; any other scheme swaps
into the same slot.

```bash
pnpm add jose
```

## Step 1 — verify the token in a hook

```ts
// src/server/plugins/auth.ts
import { UnauthorizedError } from "@kylobyte/keel";
import type { FastifyPluginAsync } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getAuthConfig } from "../../shared/config.ts";

declare module "fastify" {
  interface FastifyRequest {
    user: { sub: string; scope: string };
  }
}

const jwks = createRemoteJWKSet(new URL(getAuthConfig().jwksUrl));

export const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest("user", null);

  fastify.addHook("onRequest", async (request) => {
    const header = request.headers.authorization;

    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedError("Missing bearer token");
    }

    try {
      const { payload } = await jwtVerify(
        header.slice("Bearer ".length),
        jwks,
        {
          issuer: getAuthConfig().issuer,
          audience: getAuthConfig().audience,
        },
      );

      request.user = { sub: payload.sub!, scope: String(payload.scope ?? "") };
    } catch {
      throw new UnauthorizedError("Invalid token");
    }
  });
};
```

Three things here are deliberate and easy to get wrong.

**It is not wrapped in `fastify-plugin`.** The two global plugins are, because they must
apply to the whole instance. This one must _not_ be: `fastify-plugin` breaks
encapsulation, so a wrapped version would add its hook to every route in the app,
including the public ones. Plain plugin, scoped to whoever registers it.

**It throws an `UnauthorizedError`.** That is one of keel's tagged errors, and it
carries `statusCode: 401`. The throw happens outside any Effect, so
`errorHandlerPlugin` catches it and — because the error carries a numeric `statusCode`
— replies with a 401 rather than a 500. Any error object with a `statusCode` works the
same way.

**`decorateRequest` runs at registration.** Declaring the property up front lets
Fastify keep its request objects on a single hidden class; assigning to an undeclared
property in a hook is slower and does not type-check against the module augmentation.

## Step 2 — declare the caller as a service

```ts
// src/shared/app/current-user.ts
import { Context } from "effect";

export class CurrentUser extends Context.Tag("CurrentUser")<
  CurrentUser,
  {
    readonly id: bigint;
    readonly email: string | null;
    readonly permissions: ReadonlySet<string>;
  }
>() {}
```

Note what this type is _not_: it has no `sub`, no token, no header, no scope string. The
JWT is a transport detail; `CurrentUser` is the domain concept. Keeping them separate is
what lets you change identity providers without touching a single controller.

## Step 3 — build the authenticated router

This is where the two halves meet:

```ts
// src/shared/app/keel.ts
import { createKeel, UnauthorizedError } from "@kylobyte/keel";
import { PinoLogger } from "@kylobyte/keel/runtime";
import { Effect, Layer, Logger } from "effect";
import { authPlugin } from "../../server/plugins/auth.ts";
import { UserService } from "../../modules/user/user.service.ts";
import { AppRuntime } from "./runtime.ts";
import { CurrentUser } from "./current-user.ts";

export const { router, createRouter, createRouterWithErrors } =
  createKeel(AppRuntime);

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
            permissions: new Set(user.roles.flatMap(permissionsFor)),
          };
        }).pipe(Effect.orDie),
      ).pipe(Layer.provide(UserService.Default)),
    ),
  async (app) => {
    await app.register(authPlugin);
  },
);
```

Read it as its four parts:

1. **`createRouterWithErrors<UnauthorizedError>()`** adds that error to _every_ route on
   the router at the type level. No controller will ever produce it — the hook rejects
   long before Effect runs — but every route on this router now requires a `401` key in
   its response schema. That is the only way the OpenAPI document can describe a status
   the Effect pipeline cannot see.
2. **The request provider** maps `FastifyRequest` to a `Layer`. It is the one place with
   access to the raw request, and it runs per request, before the controller.
3. **`Effect.orDie`** is not laziness. By the time this layer builds, the hook has
   already rejected anyone unauthenticated — so a failure loading the caller means the
   database is down or the code is wrong. That is a defect (500), not a business error,
   and turning it into one keeps `CurrentUser` out of every controller's error type.
4. **`registerPlugins`** is the second argument. It registers `authPlugin` on the
   router's own scope, before any routes are defined, so the hook covers this router and
   nothing else.

`Logger.replace(…, PinoLogger)` is merged in because supplying your own request provider
replaces the default one, and the default is what installs the Pino logger. Forget it
and Effect logs from these routes go to Effect's default logger instead of your Pino
stream.

## Step 4 — use the caller in a controller

```ts
// src/modules/user/user.controller.ts
import { controller, ForbiddenError } from "@kylobyte/keel";
import { Effect } from "effect";
import { CurrentUser } from "../../shared/app/current-user.ts";
import { UserService } from "./user.service.ts";

export const getMe = controller(
  () =>
    Effect.gen(function* () {
      const { id } = yield* CurrentUser;
      const users = yield* UserService;

      return yield* users.findById(id);
    }),
  [UserService.Default],
);

export const listAllUsers = controller(
  () =>
    Effect.gen(function* () {
      const { permissions } = yield* CurrentUser;

      if (!permissions.has("users:read")) {
        return yield* new ForbiddenError("Missing users:read");
      }

      const users = yield* UserService;

      return yield* users.list();
    }),
  [UserService.Default],
);
```

No `request`, no header parsing, no parameter threading — the caller is just another
service to `yield*`. And because `CurrentUser` is in the controller's requirements, a
controller that reads it cannot be mounted on the plain `router`: the requirement is
unsatisfiable there, and `createRoute` says so at compile time. Authentication is
enforced by the type system, not by remembering.

Authorization is a different matter and stays explicit. `ForbiddenError` enters the
error channel like any other tagged error, so it lands in the controller's type and the
route must declare a `403`. A 401 is "we do not know who you are" and belongs to the
hook; a 403 is "we know, and no" and belongs to the code that knows what the permission
means.

## Step 5 — the routes

```ts
// src/modules/user/user.router.ts
import { errorsSchemas } from "@kylobyte/keel";
import { Schema as S } from "effect";
import { authenticatedRouter } from "../../shared/app/keel.ts";
import { getMe, listAllUsers } from "./user.controller.ts";
import { UserSchema } from "./user.schemas.ts";

export default authenticatedRouter(async (app, createRoute) => {
  app.get(
    "/me",
    {
      schema: {
        summary: "The authenticated user",
        security: [{ bearerAuth: [] }],
        response: { ...errorsSchemas([401]), 200: UserSchema },
      },
    },
    createRoute(getMe),
  );

  app.get(
    "/users",
    {
      schema: {
        summary: "List users",
        security: [{ bearerAuth: [] }],
        response: {
          ...errorsSchemas([401, 403]),
          200: S.Array(UserSchema),
        },
      },
    },
    createRoute(listAllUsers),
  );
});
```

Drop the `401` from either route and it stops compiling — that is
`createRouterWithErrors<UnauthorizedError>()` doing its job. Drop the `403` from the
second and the same happens, this time because the controller itself can produce it.

`security` is passed through to the OpenAPI document untouched; declare the scheme it
refers to on the plugin:

```ts
// src/server/plugins/openapi.global.ts
export default openapiPlugin({
  info: { title: "Notes API", version: "1.0.0" },
  securitySchemes: {
    bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
  },
});
```

## Step 6 — test it

**A controller that reads `CurrentUser`** needs one more provided service and nothing
else:

```ts
const caller = {
  id: 1n,
  email: "ada@example.com",
  permissions: new Set<string>(),
};

const exit = await Effect.runPromiseExit(
  listAllUsers
    .DefaultWithoutDependencies({})
    .pipe(
      Effect.provideService(CurrentUser, caller),
      Effect.provide(userService()),
    ),
);

expect(exit).toStrictEqual(Exit.fail(new ForbiddenError("Missing users:read")));
```

That is the payoff of step 2: testing an authorization rule needs a plain object, not a
signed token.

**The hook itself** is tested through `inject`, which is the only level where it
actually runs:

```ts
const response = await app.inject({ method: "GET", url: "/api/me" });

expect(response.statusCode).toBe(401);
expect(response.json()).toEqual({ message: "Missing bearer token" });
```

Note the body: `errorHandlerPlugin` sends `{ statusCode, message }`, and the route's
`401` schema — `HttpErrorSchema` — keeps only `message` on the way out. That is the
[intended trade-off](/keel/design-decisions/#why-do-the-validation-details-disappear-from-the-400-response),
and it is why asserting on the encoded body is worth doing.

For tests that need to be _past_ the hook, register the router with a stub plugin that
sets `request.user` directly instead of verifying anything. The request provider — the
part you actually want to exercise — runs either way.

## Variations

**Several authenticated routers.** Machine-to-machine calls with a different token
shape, an admin router with a stricter hook: build one `createRouterWithErrors` per
shape. They can share the `CurrentUser` tag if they resolve to the same domain type,
which keeps controllers usable from both.

**Optional authentication.** A route that behaves differently for anonymous callers
wants a `Layer` producing `CurrentUser | null`, and no hook — or a hook that tolerates a
missing header. Do not reach for two routers and duplicated routes.

**Per-route permissions.** Keep them in the controller, as above. A hook cannot see the
resource being requested, so anything beyond "is this token valid" ends up needing the
handler's context anyway.

## Next

- [Routes](/keel/routes/) — the full reference on routers and request providers.
- [Errors](/keel/errors/) — how a status raised outside the Effect pipeline is handled.
- [SSE](/keel/sse/) — authenticating an `EventSource`, which cannot send headers at all.
