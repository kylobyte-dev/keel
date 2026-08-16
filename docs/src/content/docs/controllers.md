---
title: "Controllers"
description: "Controllers as Effect services: dependencies, request context, and what a handler returns."
---

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

Getting that split wrong compiles cleanly and misbehaves later — a stateful service in
a controller's layer list is rebuilt, empty, on every request. The third scope (the
router's request provider) and the rule for choosing between all three are in
[Architecture](/keel/architecture/#three-places-a-dependency-can-live).

`controller()` returns two handlers:

| Property                     | What it is                                             |
| ---------------------------- | ------------------------------------------------------ |
| `Default`                    | The handler with its layers provided — what routes use |
| `DefaultWithoutDependencies` | The raw handler — what tests provide mocks to          |

## What a controller returns

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

How that derivation works, and what it does _not_ check, is in
[Deriving a route's response schema](/keel/architecture/#deriving-a-routes-response-schema).
