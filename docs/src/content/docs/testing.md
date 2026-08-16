---
title: "Testing"
description: "Unit-testing controllers as plain Effects, and driving routes through Fastify's inject."
---

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
