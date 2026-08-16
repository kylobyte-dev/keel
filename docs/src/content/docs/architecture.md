---
title: "Architecture"
description: "What each part of keel does, how a request actually flows through it, and the type-level machinery that holds it together."
---

[The shape of an app](/keel/app-shape/) shows where your files go. This page is about
what keel itself is made of: which module owns what, what happens between the socket
and your controller, and how the compiler is made to check the parts a test would
otherwise have to.

Read it once before writing an app, or come back to it when something does not
compile and the error mentions a type you did not write.

## What keel is, and what it refuses to be

Keel is glue between two libraries that were not designed for each other. Fastify
owns the socket, the routing table, the lifecycle hooks and the serializer; Effect
owns dependency injection, the error channel, structured concurrency and the logger.
Every piece of keel exists to make one of Fastify's extension points speak Effect.

| Fastify extension point        | What keel plugs into it                                    |
| ------------------------------ | ---------------------------------------------------------- |
| Validator compiler             | `S.decodeUnknown` — schemas become Effect Schemas          |
| Serializer compiler            | `S.encodeUnknown` — responses are encoded, not stringified |
| Type provider                  | `EffectTypeProvider` — decoded types reach the handler     |
| Route handler                  | `createRoute(controller)` — runs an Effect on your runtime |
| `setErrorHandler`              | `errorHandlerPlugin` — failures raised outside Effect      |
| `@fastify/swagger` `transform` | `jsonSchemaTransform` — Effect Schema → JSON Schema        |

What it deliberately does **not** own:

- **The application runtime.** You build the `ManagedRuntime`; keel closes over it.
  Keel has no opinion on what is in your layer and no way to add to it.
- **Business logic.** There is no service base class, no repository interface you must
  implement, no lifecycle to hook into.
- **The Fastify instance.** Your entrypoint creates it, listens on it, and disposes of
  it. Keel contributes plugins and handlers.
- **The database.** `/sql` is a set of helpers bound to _your_ database service tag.

That boundary is the reason the package stays small enough to read. When something
feels missing, the answer is usually that it belongs in your app — see
[Design decisions](/keel/design-decisions/) for the cases where that was a deliberate
call rather than an omission.

## The module map

One package, six entry points. They are separate because their peer dependencies are:
importing `/openapi` should not force an app to install Scalar, and importing keel at
all should not force it to install Drizzle.

| Entry point | Source         | What lives there                                                                                       | Needs                                |
| ----------- | -------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `/http`     | `src/http`     | Type provider, `controller()`, `createKeel`, routers, response and error types, the two global plugins | `fastify`, `effect`                  |
| `/runtime`  | `src/runtime`  | `pinoInstance`, `PinoLogger`, `memoizedConfig`, `readonly`, `voidMemo`                                 | `effect`, `pino`, `pino-pretty`      |
| `.`         | `src/index.ts` | Everything from `/http` plus `/runtime` — the import most app files use                                | the above                            |
| `/openapi`  | `src/openapi`  | `openapiPlugin`, `createOpenapiMetaPlugin`                                                             | `@fastify/swagger`, Scalar, `helmet` |
| `/sse`      | `src/sse`      | `createSseHandlerFactory`                                                                              | `fastify`, `effect`                  |
| `/sql`      | `src/sql`      | `createSql`, filters, operators, table query params, `paginate`, `snowflakeId`                         | `drizzle-orm`, `@effect/sql-pg`      |

Inside `/http`, the split is by responsibility rather than by feature:

```
src/http/
├── typeProvider.ts    # decode in, encode out, and Effect Schema → JSON Schema
├── controller.ts      # the `controller()` brand and its two handlers
├── keel.ts            # createKeel: binds the runtime, builds routers, runs the Exit
├── routeTypes.ts      # the type-level derivation of a route's response schema
├── parsing.ts         # schema helpers: BigIntIdSchema, parseJsonParam, errorsSchemas
├── response/
│   ├── success.ts     # HttpResponse and its 201/202/204 subclasses
│   └── errors.ts      # the tagged HttpErrors, each carrying its statusCode
├── errors.ts          # ResponseSerializationError (a Fastify error, not an Effect one)
└── plugins/
    ├── effect.ts      # installs the compilers — mandatory, register first
    └── errors.ts      # setErrorHandler — mandatory, catches non-Effect failures
```

Two files carry most of the weight. `keel.ts` is the only place where an Effect is
actually run, and `routeTypes.ts` is the only place where a route's contract is
computed. Everything else is either a helper or a plain data class.

## The lifecycle of a request

Here is what happens between a socket read and a socket write, with the piece
responsible for each step.

```
  ┌─ Fastify router ─────────── matches the route
  │
  ├─ validatorCompiler ───────── S.decodeUnknown(body | params | querystring)
  │     │                        typeProvider.ts
  │     └─ failure ────────────► errorHandlerPlugin → 400 (never reaches your code)
  │
  ├─ route handler ──────────── built by createRoute(controller)
  │     │                        keel.ts
  │     ├─ builds the input     { body, params, querystring } — no headers
  │     ├─ controller.Default   provides the controller's own layers
  │     ├─ annotateLogs         requestId, requestPath
  │     ├─ Effect.provide       the router's request layer, built for this request
  │     └─ runtime.runPromiseExit
  │
  ├─ Exit ────────────────────── success → HttpResponse ? its status : 200
  │                              Fail + statusCode → that status, { message }
  │                              Fail + a matching ErrorMapper → its status and body
  │                              anything else → 500, whole Cause logged
  │
  ├─ serializerCompiler ─────── S.encodeUnknown(the schema for that status)
  │     │                        typeProvider.ts
  │     └─ failure ────────────► ResponseSerializationError → 500
  │
  └─ socket write
```

A few properties of that path are worth stating outright, because they are the ones
that shape how app code ends up being written.

**Your controller never sees an invalid request.** Decoding happens before the handler
is called, and a decode failure is a Fastify error, so it goes to `errorHandlerPlugin`,
not to your error channel. There is no "validate then handle" branch to write.

**Your controller never sees the raw request either.** The handler builds the input
from `request.body`, `request.params` and `request.query` and nothing else. Headers,
cookies, the socket, the reply — none of them are reachable from inside a controller.
Anything you need from them is turned into a service by the router's request provider,
which keeps the controller a function of `(validated input, services)`.

**The runtime is the only thing that runs Effects.** `runtime.runPromiseExit` is called
once per request. Its context is the app's layer, so every service in it is a
process-wide singleton shared across requests; the request layer and the controller's
layers are provided _on top_ of it, per request.

**Nothing throws.** The handler inspects an `Exit`, so a defect (`Effect.die`, a thrown
exception inside an Effect) reaches the same branch as a failure — logged in full,
answered with a flat 500. The client learns nothing about it; the log has the whole
`Cause`.

### The two mandatory plugins

`effectProviderPlugin` and `errorHandlerPlugin` are both registered with
`fastify-plugin`, so they apply to the whole instance rather than to an encapsulated
scope. Both must be registered before any router:

- the compilers are read by Fastify when a route is _added_, so a router registered
  first gets no Effect Schema support and quietly treats your schemas as JSON Schema;
- the error handler is what turns a decode failure into a 400 instead of Fastify's
  default error shape.

Everything else keel exposes is optional.

### Where a failure can come from

There are exactly three, and they are handled in three different places. Knowing which
one you are looking at is most of the work of debugging a wrong status code.

| Origin                                                    | Handled by                  | Result                                       |
| --------------------------------------------------------- | --------------------------- | -------------------------------------------- |
| The Effect's error channel (`yield* new NotFoundError()`) | `createRoute`'s Exit branch | The error's `statusCode`, body `{ message }` |
| A defect inside the Effect (`die`, a throw)               | `createRoute`'s Exit branch | 500, whole `Cause` logged                    |
| Outside the Effect: validation, a hook, a plugin          | `errorHandlerPlugin`        | 400 / the thrown error's status / 500        |

The middle column matters for a subtle reason: the two handlers produce _different
body shapes_. `createRoute` sends `{ message }`; `errorHandlerPlugin` sends
`{ statusCode, error, message, details? }`. Both are then encoded by the response
schema for that status, and `HttpErrorSchema` keeps only `message` — which is how the
extra fields disappear before reaching the client. See
[Errors](/keel/errors/) for the whole story.

## Three places a dependency can live

This is the decision app code makes most often, and the one with the least obvious
answer. Keel gives you three scopes, with three different lifetimes.

| Scope                    | Declared in                     | Built            | Use for                                                             |
| ------------------------ | ------------------------------- | ---------------- | ------------------------------------------------------------------- |
| **Runtime layer**        | `ManagedRuntime.make(layer)`    | Once, at boot    | Anything that must be a singleton, or is shared by most routes      |
| **Router request layer** | `createRouter(requestProvider)` | Once per request | Anything derived from the request: the caller, a tenant, a trace id |
| **Controller layers**    | `controller(handler, [layers])` | Once per request | Services specific to one feature, cheap to construct                |

They compose in that order: the runtime's context is the base, the request layer is
provided on top of it, and the controller's layers are provided innermost. A service
in a controller layer can therefore depend on a service in the runtime layer, but not
the other way round.

**Runtime layer** — a connection pool, a Redis client, a queue producer, a cache. One
instance for the process; acquired at boot and released by `AppRuntime.dispose`. If a
second instance would be wrong (or expensive), it goes here.

```ts
const layer = Layer.mergeAll(DatabaseService.layer, RedisService.layer);
export const AppRuntime = ManagedRuntime.make(layer);
```

**Router request layer** — the only place with access to the `FastifyRequest`. This is
where you translate HTTP into domain terms exactly once, so controllers never have to:

```ts
export const authenticatedRouter = createRouterWithErrors<UnauthorizedError>()(
  (request) =>
    Layer.effect(
      CurrentUser,
      Effect.gen(function* () {
        /* read request.user, load the caller */
      }).pipe(Effect.orDie),
    ),
);
```

Built fresh for every request, so it may close over request state safely. It runs
_before_ the controller, and a failure in it fails the request — which is why the
example above uses `Effect.orDie`: an unresolvable caller past the auth hook is a bug,
not a business outcome.

**Controller layers** — the second argument to `controller()`. Also per request, but
scoped to the one controller, and visible in the controller's own type. Their purpose
is to keep a feature's services out of the global layer: `UserService.layer` does
not need to exist for a route that never touches users.

The rule of thumb: **shared or expensive → runtime; derived from the request → router;
everything else → controller.**

## The type-level machinery

The runtime behaviour above is only half of keel. The other half is a set of types
whose job is to make a mismatch between a route and its controller a compile error.
Nothing here runs; all of it disappears at build time.

### The type provider

Fastify's type providers are interfaces with a `this["schema"]` self-reference — a
type-level function. `EffectTypeProvider` maps a schema to its **decoded** type:

```ts
export interface EffectTypeProvider extends FastifyTypeProvider {
  validator: this["schema"] extends S.Schema<any> ? S.Schema.Type<this["schema"]> : never;
  serializer: /* the same */;
  response: /* the same */;
}
```

That single mapping is why a `S.BigIntFromString` in a params schema arrives in your
controller as a `bigint` while travelling as a string: `S.Schema.Type` is the decoded side,
`S.Schema.Encoded` is the wire side, and the compilers do the conversion at runtime in
the same two places.

### The controller brand

`controller()` returns an object carrying a unique symbol:

```ts
const ControllerBrand = Symbol("brand/Controller");
```

`createRoute` accepts only values with that symbol. A hand-written
`{ Default, DefaultWithoutDependencies }` is rejected even though it is structurally
identical — because the brand is also what carries the four type parameters
(`Input`, `Output`, `Errors`, `R`) that the route derivation reads. An unbranded object
would have inferred them from usage, which is exactly the inference this design exists
to prevent.

The two handlers are the same function with different requirements:

- `Default` has the controller's layers provided, so its `R` is the runtime's job to
  satisfy;
- `DefaultWithoutDependencies` is the raw handler, so its `R` is every service it
  yields — which is what makes [testing](/keel/testing/) a matter of providing mocks.

### Deriving a route's response schema

`ResponseSchema<Output, Errors, ExtraStatuses>` in `routeTypes.ts` is the heart of it.
Given a controller, it computes the object the route's `response` key must satisfy:

1. **Success statuses from `Output`.** Anything that is not an `HttpResponse` maps to
   `200`. Each `HttpResponse<V, S>` in the union contributes `{ [S]: S.Schema<V> }`,
   and a union of returns is turned into an intersection of requirements — so
   `Effect<User | HttpNoContent>` demands both a `200` and a `204` key.
2. **`500`, always.** Any route can die.
3. **Error statuses from `Errors`.** Every member of the error union that extends
   `HttpError` contributes its `statusCode` as a required key.
4. **Extra statuses**, computed by the app's `ExtraStatusProvider` from the same error
   union.

Because these are _required keys of the schema object_, forgetting one is a type error
at `createRoute(controller)`, pointing at the route. Declaring a status the controller
cannot produce is allowed — the rule is one-directional on purpose, so a route can
document a `401` raised by an auth hook that no controller mentions.

### Extra statuses, without keel knowing your errors

Keel cannot enumerate your error families. `ExtraStatusProvider` is the same
self-reference trick Fastify uses, turned into a hook:

```ts
export interface ExtraStatusProvider {
  readonly errors: unknown;
  readonly statuses: number;
}

export type ApplyExtraStatuses<
  Provider extends ExtraStatusProvider,
  Errors,
> = (Provider & { readonly errors: Errors })["statuses"];
```

An app declares an interface that reads `this["errors"]` and returns the statuses that
family maps to, then passes it to `createKeelWith`. `ApplyExtraStatuses` instantiates
it against each route's concrete error union. The runtime half is an `ErrorMapper` in
`KeelOptions`; the type half is the provider. Register one without the other and you
get either a documented status that never happens, or a status that happens and is not
documented — which is why [Errors](/keel/errors/) insists on both.

### What is not checked

Being explicit about the gaps is more useful than implying there are none:

- **Request schemas are not derived from the controller.** The input type is a
  _constraint_: declaring `Params<{ id: bigint }>` forces the route's `params` schema
  to decode to that shape, but a route can decode fields the controller ignores.
- **Status codes on `HttpResponse(207, …)` are not validated against a list.** Any
  number is accepted; the schema key just has to match.
- **The `errorMappers` array is not type-checked against the `ExtraStatusProvider`.**
  Nothing forces them to agree; keeping them in the same file is the mitigation.
- **A schema's encoded type is not checked against what clients expect.** Only a test
  that goes through `inject` sees the wire format.

## Reading the source

The package ships its `src/` alongside `dist/`, so an editor's "go to definition"
lands on the real implementation rather than on a `.d.ts`. If you want to follow one
thread end to end, `src/http/keel.ts` is the ninety lines where a request becomes an
Effect and an `Exit` becomes a reply — everything else in `/http` is either feeding it
types or feeding it schemas.

## Next

- [Design decisions](/keel/design-decisions/) — why each of these calls was made.
- [Your first app](/keel/tutorials/first-app/) — the same picture, built one file at a time.
- [Troubleshooting](/keel/troubleshooting/) — what the compile errors from all this actually mean.
