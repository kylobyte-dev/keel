---
title: "Design decisions"
description: "Why keel is built the way it is: the trade-offs behind the type provider, the branded controllers, the peer dependencies and the parts that were left out."
---

Most of keel's surface is small enough to read in an afternoon. What is not obvious
from reading it is _why_ each piece looks the way it does — several of them are the
second or third attempt at the same problem, and the shape they settled on only makes
sense with the discarded ones in view.

This page is that context. It assumes you have read
[Architecture](/keel/architecture/); it is organised as a list of questions rather
than a narrative, so it can be skimmed and linked to.

## The core

### Why does the app own the `ManagedRuntime`?

Because the alternative is keel owning your service graph, and there is no version of
that which stays out of the way.

If keel built the runtime, it would need an API for contributing layers to it, a
lifecycle for building it, an opinion on when it is disposed, and an escape hatch for
everything those three got wrong. Instead: you call `ManagedRuntime.make`, you pass the
result to `createKeel`, and keel closes over it. Your layer is whatever you want,
built whenever you want, disposed by you.

The payoff is type-level. `createKeel(AppRuntime)` captures `RuntimeContext`, so
`createRoute` can require that a controller's needs are satisfiable by _your_ runtime.
A controller that yields a service you never provided does not compile — at the route
definition, with your service's name in the error. That check exists precisely because
keel does not know or control what is in the layer.

### Why is `controller()` branded with a symbol?

To stop `createRoute` from inferring what it is supposed to be checking.

Without the brand, `createRoute` would accept any `{ Default, DefaultWithoutDependencies }`
object and infer `Output` and `Errors` from whatever was passed. Inference is
forgiving: a handler whose return type is `any` somewhere in the middle produces an
`Output` of `any`, which satisfies every response schema, and the route's contract
silently stops being checked. The brand makes `controller()` the only way to construct
the type, so the four parameters are always the ones `controller()` computed from the
handler and its layers.

It also gives a much better error message. Passing a bare function to `createRoute`
fails with "missing the `[brand/Controller]` property" instead of a page of failed
inference.

### Why can't a controller see the request?

Because a controller that reads headers is a controller you cannot call from a test
without constructing a `FastifyRequest`.

The input is built from exactly three fields — body, params, querystring — all of them
already decoded. Everything else about the request is the router's job: the request
provider gets the `FastifyRequest` and turns what it needs into services. A controller
therefore has one input type and a set of requirements, both visible in its signature,
and both trivially satisfiable in a test.

There is a second benefit that only shows up later. When the caller arrives as a
`CurrentUser` service rather than as `request.user`, moving a handler behind a
different authentication scheme is a change to one layer, not to every controller that
reads a token.

### Why two handlers, `Default` and `DefaultWithoutDependencies`?

They are the same function with different requirement types, and each is unusable for
the other's job.

`Default` has the controller's layers provided, so what remains in `R` is what the
runtime must supply — that is the thing `createRoute` checks.
`DefaultWithoutDependencies` has nothing provided, so `R` lists every service the
handler yields, which is exactly the set a test needs to mock. Testing through
`Default` would mean the real layers are already baked in and a mock cannot displace
them; routing through `DefaultWithoutDependencies` would mean the route stops checking
anything.

Two names, no configuration, and the wrong one fails to compile rather than doing
something subtle.

### Why derive the response schema from the controller, and not the other way round?

Because the direction determines what can drift.

Deriving the _controller's_ types from the route would mean writing schemas first and
having handler types follow — pleasant, but it makes the route the source of truth for
behaviour it cannot observe. A controller that starts failing with a new error would
keep compiling against an unchanged route, and the OpenAPI document would keep
promising the old set of statuses.

Deriving the _route's requirements_ from the controller inverts that: adding a
`ConflictError` to a controller breaks every route that uses it until a `409` schema is
declared. The document cannot fall behind the code, because the code is what generates
the obligation.

### Why is the rule one-directional — extra statuses allowed, missing ones not?

Because some statuses are produced by things the Effect pipeline cannot see.

An auth hook rejecting a request throws inside Fastify, long before any controller
runs. No controller's error type will ever mention that 401, but the route must
document it. Forbidding undeclared-but-produced statuses catches real drift; forbidding
declared-but-unproduced ones would make it impossible to document the framework's own
failure modes.

`createRouterWithErrors<UnauthorizedError>()` is the sanctioned way to make that
declaration mandatory for a whole router rather than a per-route reminder.

## Schemas and the wire

### Why Effect Schema as the type provider, instead of TypeBox or Zod?

Because the app is already written in Effect, and a second validation library means a
second way to express the same constraint.

The specific gain is _transformation_. Effect Schema has a decoded type and an encoded
type, and keel wires them to opposite ends of the request: `S.decodeUnknown` on the way
in, `S.encodeUnknown` on the way out. So a `bigint` id can be a `bigint` everywhere in
your code and a string on the wire, declared once, converted in two places you never
touch. TypeBox has no decoded/encoded distinction; Zod's transforms run one way.

The cost is that JSON Schema generation is lossier — the generator describes the
_encoded_ side and sometimes needs a hint, which is why `BigIntIdSchema` and
`parseJsonParam` exist at all. That was judged the cheaper problem.

### Why is serialization strict enough to 500 on a mismatch?

Because the alternative is a response the OpenAPI document does not describe, sent with
a 200.

A body that does not match its schema is a bug in the handler or a drifted schema. Sent
anyway, it becomes a client's problem, discovered in someone else's integration.
Encoded strictly, it becomes a 500 with the parse error in the log and a failing test
in CI. Loud and early beats quiet and downstream.

### Why do the validation `details` disappear from the 400 response?

They do not disappear — they are logged, and the response schema drops them.

`errorHandlerPlugin` sends `{ statusCode, error, message, details }`, but the route's
`400` schema is `HttpErrorSchema`, which has one field. Fastify encodes the body
through that schema before it goes out, so the client receives `{"message":"Validation
failed"}`.

That is intentional: `details` contains schema paths and issue tags, which describe the
server's internals rather than the caller's mistake. A route that genuinely wants to
return them declares its own richer `400` schema and gets them back — the default is
just the conservative one.

### Why `BigIntIdSchema` and `parseJsonParam` rather than plain schemas?

Both exist to name a codec correctly once, and to describe it for the reader.

A 64-bit id is a string on the wire, and the codec that decodes one is
`S.BigIntFromString` — plain `S.BigInt` validates a value that already is a `bigint`
and rejects the string that arrives. `BigIntIdSchema` is the right codec under a name
that says what it is for, so the choice is made once rather than at every route.

A JSON-encoded query param is the mirror image: `S.fromJsonString(Schema)` is a string
as far as the document is concerned, so `?filter={"role":"admin"}` reads as an opaque
string. `parseJsonParam` describes the inner schema through the standard
`contentSchema` keyword while Fastify still validates the decoded object.

Neither is magic, and neither is required — they are the schema you would otherwise
spell out by hand on every id and every JSON param. Both currently lose their
annotations in the generated document; see [the known
gap](/keel/install/#known-gap-annotations-on-transformations).

### Why inline the `$defs` in the OpenAPI document?

Because Effect emits `$ref: "#/$defs/Name"`, and in an OpenAPI document that path does
not exist.

The generator hoists reusable definitions into a separate `definitions` map, which
keel folds back into a local `$defs` block, referenced from the root of _that_
schema. But the schema is nested inside the route's
`response` object, so the `#/` prefix resolves against the document root, where no
`$defs` block was ever written. Scalar tolerates the dangling reference; strict
consumers like `openapi-typescript` fail on it.

Inlining makes every schema self-contained. The cost is a bigger document with repeated
definitions, which is the right trade for a file that is read by tools far more often
than by people. Recursive schemas are left alone rather than expanded forever.

## Errors

### Why tagged errors carrying a `statusCode`, rather than an exception hierarchy?

Because the error channel is typed, and the type is what drives the route's contract.

`Data.TaggedError` gives three things at once: a `_tag` for `catchTag` to narrow on,
structural equality (so a test can assert `Exit.fail(new NotFoundError("nope"))`), and a
union member in the Effect's `E` channel. That last one is what
`ResponseSchema<Output, Errors>` reads to compute required status keys. An exception
class hierarchy carries none of that into the type system — you would be back to
`instanceof` checks and a route contract nobody can verify.

The `statusCode` field, rather than a registry mapping error types to statuses, keeps
the mapping local: `isHttpError` is a structural check for `typeof statusCode ===
"number"`, so _any_ error carrying one is mapped, including ones your app defines
without telling keel.

### Why do app-specific statuses need both a mapper and a type provider?

Because they solve different halves and neither implies the other.

The `ErrorMapper` is runtime: given a failure keel does not recognise, produce a status
and a body. The `ExtraStatusProvider` is compile-time: given a controller's error union,
declare which extra status keys its route must have. Keel cannot derive one from the
other — a mapper is a function on values, and the provider is a function on types, and
TypeScript will not run the former at type level.

The duplication is real and is the accepted cost. Keeping both in the same file, as the
[Errors](/keel/errors/) page does, is the mitigation.

### Why does a defect become a flat 500 with no detail?

Because a defect is, by definition, something you did not model — and an unmodelled
failure's message is written for you, not for the caller.

The whole `Cause` is passed to `request.log.error`, so the stack, the fiber, and any
nested causes are in the log with the `requestId` attached. The client gets
`{ message: "Internal server error" }`. Anything more would be leaking internals on the
one path where you have the least control over what the internals say.

## Packaging

### Why are `effect` and `fastify` peer dependencies?

Because two copies of `effect` in one process is a bug with no error message.

Service key identity is per-module-instance. If keel bundled its own `effect` and
your app had another, a service your app provides and a service keel resolves would be
_different tags with the same name_, and every `yield* SomeService` inside a controller
would fail to find a provider it can see in the layer. Fastify has the same problem
with plugin symbols and decorators.

Peer dependencies push that resolution to the package manager, where a duplicate is a
warning you see at install time instead of a runtime mystery.

### Why are the `/sql` peers pinned to exact versions?

Because `drizzle-orm/effect-postgres` is prerelease and moves in lockstep with
Effect's SQL layer, which moves fast on its own.

A caret range would let a combination keel has never compiled against resolve into your
app, and the failure mode is a type error deep inside Drizzle's builder types rather
than anything actionable. Exact pins mean the set of versions in your `node_modules` is
the set CI type-checked against. Bumping them is a keel release — deliberately, so the
bump is visible in a changelog rather than in a lockfile diff.

### Why six entry points instead of one?

So that the peer dependencies of a feature are only required by the apps that use it.

`/openapi` needs Scalar and `helmet`; `/sql` needs Drizzle and the `@effect/sql-pg`
driver. Behind a single entry point, importing `controller` would pull the module
graph for all of them and every app would need all of them installed. Separate exports
keep each optional peer genuinely optional — the module is never loaded if it is never
imported.

## SQL

### Why are repositories write-only?

Because the generic read is the one that is always almost right.

`insert`, `update` and `delete` keyed on the primary key are the same three statements
in every table, and a generic version of them saves real repetition. Reads are not like
that: the projection differs, the joins differ, the ordering differs, and a generic
`findAll` grows options until it is a worse query builder than the one underneath. What
you get is a `findById` that selects every column of a table with twelve of them,
called from a handler that needed two.

So reads go in feature-specific query services that use the database service directly,
where the SQL is visible at the call site — and `paginate`, `defineFilter` and
`buildOrderBy` are there to make writing them short. Even ID lookups: a `findById`
whose projection is written out is worth more than one that is inherited.

### Why does `paginate` take the count subquery before applying `limit`?

Because Drizzle's builder mutates in place, and the two orderings differ silently.

`.as("paginated")` snapshots the SQL as it stands; `.limit()` and `.offset()` modify the
same builder object rather than returning a new one. Take the subquery first and the
count runs over the filtered, unpaginated set, which is what `total` means. Take it
after and the count runs over the page — so `total` equals `items.length` on every
page, the pagination controls look correct on page one, and nobody notices until a
second page exists.

The comment in `paginate.ts` says so at the line, because the fix is a two-line swap
that reads like a harmless reordering.

### Why are snowflake ids a default and not a requirement?

Because nothing in `/sql` depends on them, and pretending otherwise would be a
constraint with no cause.

`buildRepository` reads the type of the `id` column off the Drizzle table, so a `uuid`
or `text` key works with no configuration. `snowflakeId()` is offered because
application-side generation has two properties worth defaulting to — an insert knows
its own id before the round trip, and ids sort by creation time — but an app that wants
`uuid` just does not import it. The `snowyflake` peer is optional for the same reason.

## The rest

### Why is an SSE handler not a controller?

Because a controller returns a value and keel sends it, and a stream never returns.

An SSE handler hijacks the reply and writes frames itself for as long as the client
stays connected. Nothing about the controller contract — one input, one output, one
status, a response schema — describes that. Forcing it into the same shape would mean
inventing a "streaming controller" variant of every piece of the machinery.

So `createSseHandler` produces a plain Fastify handler that goes on the route directly,
without `createRoute`. What it does keep from the Effect side is the part that matters:
`buildStream` runs in a fiber that is interrupted on disconnect, so a scoped
subscription is released without any cleanup code of yours.

### Why does SSE split into `authorize` and `buildStream`?

Because there is exactly one moment when the reply is hijacked, and error handling
works differently on each side of it.

Before hijacking, a failure can still be a normal JSON response with a real status —
which is why `authorize` fails with `{ statusCode, message }`. After hijacking, the
headers are flushed and the status line is already sent; a failure has nowhere to go.
That is why `buildStream` is typed `Effect<void, never, R>`: not because errors are
impossible, but because keel has no way to report them and would rather you handle them
inside than have them vanish.

### Why is the OpenAPI tag per router, not per route?

Because it is applied by an `onRoute` hook, and the hook is the reason it is worth
having.

Tagging per route means a `tags: ["User"]` on every schema object, which is repetition
that drifts the moment somebody copies a route. `createOpenapiMetaPlugin` registers
inside a router's encapsulated scope and stamps every route defined after it. The
limitation is that it _replaces_ `schema.tags` rather than merging, so a route cannot
opt into a second tag — one router, one tag. That matched how routers were already
organised, and the escape hatch is to not register the plugin and set tags by hand.

### Why does `memoizedConfig` throw instead of returning an Effect?

Because configuration is read at boot, and at boot there is no error channel worth
threading it through.

A missing `SERVER_PORT` is not a failure a request should handle; it is a process that
should not have started. `memoizedConfig` runs the Effect synchronously on first call
and caches the result, so `getServerConfig()` is a plain function returning a plain
object — callable from a Fastify plugin, a constructor, or the entrypoint, none of
which are Effects. Call it at boot and a bad variable takes the process down before the
first request instead of turning into a 500 on some unlucky path.

If you want the failure in an error channel, keep the `Config` descriptors and yield
them inside a layer — nothing stops you, and `memoizedConfig` is just the shortcut for
the common case.
