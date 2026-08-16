---
title: "Troubleshooting"
description: "The compile errors keel's type machinery produces, the runtime surprises it can cause, and what each one actually means."
---

Most of keel's checks fire at compile time, which is the point — but a type error
mentioning `ResponseSchema<Output, Errors, ExtraStatuses>` is not self-explanatory the
first time you see it. This page is a symptom index: what you saw, why it happens, what
to change.

## It does not compile

### `Property '[brand/Controller]' is missing`

**You wrote** a handler and passed it straight to `createRoute`, or built the
`{ Default, DefaultWithoutDependencies }` object by hand.

**Why** `createRoute` accepts only values carrying the brand symbol that `controller()`
attaches. Structural equivalence is not enough — [on
purpose](/keel/design-decisions/#why-is-controller-branded-with-a-symbol), because the
brand is what carries the type parameters the route derivation reads.

**Fix** wrap the handler: `controller(handler)`, or `controller(handler, [layers])`.

### `Property '404' is missing in type … but required in type 'ResponseSchema<…>'`

**Why** the controller can fail with an error carrying `statusCode: 404`, so the route
must declare a schema for it. The number in the message is the status you are missing.

**Fix** add it to the route: `response: { ...errorsSchemas([404]), 200: … }`.

If you did not expect that error to be reachable, look at what the controller actually
yields — a service whose error channel includes a `NotFoundError` propagates it into
the controller's type even if the controller never constructs one. Either declare the
status or handle it (`Effect.catchTag`) so it leaves the error channel.

### `Property '201' is missing` — but nothing fails with 201

**Why** success statuses come from the controller's _return_ type, not its error type.
Returning `new HttpCreated(value)` requires a `201` key; `new HttpNoContent()` requires
`204`; a union of returns requires all of them.

**Fix** declare the key, paired with the right schema — `204` goes with `S.Void`.

### The controller argument "is not assignable" and the diff mentions a service

**You saw** something like:

```
Argument of type 'Controller<{}, User, never, UserService, …>' is not assignable to
parameter of type 'Controller<{}, User, never, DatabaseService, …>'
```

**Why** `createRoute` requires the controller's remaining requirements to be satisfiable
by the runtime's context plus the router's request layer. The service named in the error
is provided by neither.

**Fix** one of three, depending on what the service is:

- shared or stateful → add it to the runtime layer in `ManagedRuntime.make`;
- derived from the request → provide it from the router's request provider;
- feature-local → add `[TheService.Default]` to the controller's layer list.

That decision is the [three-scope
rule](/keel/architecture/#three-places-a-dependency-can-live); picking the wrong scope
compiles fine and misbehaves later, so it is worth a moment.

### The controller needs `CurrentUser` and the route will not take it

**Why** you mounted it on `router` (or another router whose provider does not build
`CurrentUser`) rather than on the authenticated one. The requirement is unsatisfiable
there, which is authentication being enforced by the compiler.

**Fix** move the route to the router whose request provider supplies the tag.

### `params.id` is a `string`, the controller wants a `bigint`

**Why** the input type of a controller is a _constraint on the route_: `Params<{ id:
bigint }>` demands a `params` schema that decodes to a `bigint`.

**Fix** use `BigIntIdSchema` (or `S.BigInt`) in the route's `params`, not `S.String`.
Remember the decoded type is what the controller sees — the wire is still a string.

### `errorsSchemas([502])` will not type-check

**Why** keel's `errorsSchemas` is built over the statuses keel's own tagged errors map
to. `502` is not one of them.

**Fix** build your own helper once and import that everywhere instead:

```ts
export const errorsSchemas = makeErrorsSchemas<HttpError["statusCode"] | 502>({
  ...errorSchemasDescriptions,
  502: "Bad Gateway",
});
```

Full setup — including the `ExtraStatusProvider` that makes `502` _required_ rather than
merely allowed — is on the [Errors](/keel/errors/#app-specific-statuses) page.

### Every route on a router suddenly wants a `401`

**Why** the router was built with `createRouterWithErrors<UnauthorizedError>()`. That is
what it does: the error is added to every route's type so the status gets documented,
even though no controller produces it.

**Fix** declare it — `errorsSchemas([401, …])`. If a route on that router genuinely
cannot 401, it belongs on a different router.

## The response is not what you expected

### 500 with `ResponseSerializationError` in the logs

**Why** the value the controller returned does not encode against the response schema
for the status being sent. Serialization is strict [by
design](/keel/design-decisions/#why-is-serialization-strict-enough-to-500-on-a-mismatch).

**Fix** read the parse error logged just above it — it names the failing path. The usual
causes:

- returning the database row where the API resource was expected (an extra column, or a
  `null` where the schema says `string`);
- `S.String` on a column that is nullable in the database — use `S.NullOr(S.String)`;
- a numeric column arriving as a string (Drizzle's `numeric` decodes to `string`) or the
  reverse;
- the wrong status: returning a plain value where the route only declares `201`.

### A tagged error came back as 500 instead of its own status

**Why** two possibilities, and the second is easy to miss.

The failure was not a plain `Fail` cause. `createRoute` inspects
`Cause.isFailType(cause)`, which matches a direct failure but not a composite one — and
a typed error escaping a _concurrent_ combinator arrives wrapped:

```ts
// cause is `Parallel`, so the mapping is skipped and this is a 500
Effect.all([mightFail, somethingElse], { concurrency: 2 });
Effect.race(a, b);
```

Sequential `Effect.all`, `Effect.gen`, finalizers and scopes all produce a plain `Fail`
and map correctly. Only concurrency and racing wrap the cause.

**Fix** flatten the failure before it leaves the controller:

```ts
Effect.all([mightFail, somethingElse], { concurrency: 2 }).pipe(
  Effect.catchAll((error) => Effect.fail(error)),
);
```

`catchAll` extracts the failure value and re-raises it as a plain `Fail`, which maps as
expected. `Effect.catchTag("SomeError", Effect.fail)` works the same way when you want
to be selective.

The other possibility is simply that it was a _defect_, not a failure — `Effect.die`, or
a thrown exception inside `Effect.sync`. Those are always a 500; the whole `Cause` is in
the log.

### The 400 has no `details`

**Why** `errorHandlerPlugin` sends them, and the route's `400` schema drops them:
`HttpErrorSchema` has one field, and the body is encoded through it on the way out. The
details are in the logs.

**Fix** nothing, unless you want them on the wire — in which case declare a richer `400`
schema on the route instead of `errorsSchemas`. The [reasoning behind the
default](/keel/design-decisions/#why-do-the-validation-details-disappear-from-the-400-response)
is that schema paths describe your internals, not the caller's mistake.

### Validation is not happening at all

**Symptom** a body that should be rejected sails through, or Fastify complains about
your schema in JSON-Schema terms.

**Why** the router was registered before `effectProviderPlugin`. Fastify reads the
validator and serializer compilers _when a route is added_, so routes added earlier use
the default JSON Schema compiler and never see your Effect Schemas.

**Fix** register the two global plugins first, always. See
[Bootstrap](/keel/bootstrap/#wiring-fastify).

### An id comes back as a number, or as `1n`, or not at all

**Why** the encoded type is what travels. A raw `S.BigInt` encodes to a string but is
_documented_ as the decoded type; a plain `S.Number` on a `bigint` column will not
encode at all.

**Fix** use `BigIntIdSchema` for 64-bit ids. Assert on the encoded shape in a test that
goes through `inject` — that is the only level where the wire format is visible.

## Boot and runtime

### A service is missing at runtime, but everything compiled

**Why** almost always two copies of `effect` in the process. `Context.Tag` identity is
per module instance, so your app's tag and the tag keel resolves are different objects
with the same name, and the layer that clearly provides the service does not satisfy
the lookup.

**Fix** check for duplicates and dedupe:

```bash
pnpm why effect
pnpm why fastify
```

Peer dependencies exist precisely to make this a
[install-time warning](/keel/design-decisions/#why-are-effect-and-fastify-peer-dependencies)
rather than a runtime mystery — a `pnpm-workspace.yaml` override or a corrected version
range in one package usually resolves it.

### A missing environment variable blows up on the first request, not at boot

**Why** `memoizedConfig` runs its Effect on the _first call_ to the getter. If nothing
calls it during startup, the first caller is a request.

**Fix** call the getter at boot — the entrypoint reads `getServerConfig()` before
`listen`, and a service that needs config reads it in its constructor Effect. Also keep
`await AppRuntime.runPromise(Effect.void)` before `listen`, which forces the whole layer
to build (and so proves the database is reachable) while the process can still fail
loudly.

### In-memory state resets on every request

**Why** the service holding it is in a controller's layer list, and controller layers
are built per request. You are getting a fresh instance each time.

**Fix** move it into the runtime layer, where it is built once and shared.

### Effect logs are not in the Pino format on some routes

**Why** supplying your own request provider to `createRouter` _replaces_ the default
one, and the default is what installs `PinoLogger`.

**Fix** merge it back in:

```ts
Layer.merge(Logger.replace(Logger.defaultLogger, PinoLogger), yourLayer);
```

Routes on the plain `router` are unaffected — it does exactly this for you.

### Fastify's logs and Effect's logs look different

**Why** the Fastify instance was created without keel's Pino instance, so there are two
loggers with two formats.

**Fix** `Fastify({ loggerInstance: pinoInstance as FastifyBaseLogger })`.

### Connections stay open after a deploy

**Why** `AppRuntime.dispose()` was never called, so nothing the layer acquired is
released.

**Fix** wire it into shutdown alongside `fastify.close()` — a `SIGTERM` handler, or
whatever your platform calls.

## SQL

### `total` always equals `items.length`

**Why** the count subquery was taken after `limit`/`offset` were applied. Drizzle's
builder mutates in place, so the count ends up running over the page instead of the
filtered set. Page one looks right, which is why this survives review.

**Fix** hand `paginate` the query _before_ any page bounds — it takes the subquery
itself, in the right order. If you rolled your own, `.as()` first, then `.limit()`.

### Columns in Postgres are `createdAt`, not `created_at`

**Why** Drizzle only derives a column name from the property when the name argument is
left blank.

**Fix** spell it: `timestamp("created_at", …)`. Then regenerate the migration and read
the SQL — a rename reaches Atlas as a drop plus an add, which loses data.

### Searching for `100%` returns every row

**Why** `%` and `_` are `LIKE` wildcards, and user input reaching `ilike` unescaped is a
pattern rather than data.

**Fix** `escapeWildcards(value)` before interpolating. `applyStringOp` already does it
for `{ like }`; free-text `q` conditions you write yourself do not.

### A `sort` value is silently ignored

**Why** by design. `buildOrderBy` treats its column map as an allow-list and returns
`undefined` for anything outside it, so the caller's default ordering applies instead of
the request failing.

**Fix** add the column to the map. To reject unknown values instead, narrow the schema:
`sort: S.optional(S.Literal("name", "createdAt"))`.

### `drizzle-orm` types explode after an install

**Why** `drizzle-orm/effect-postgres` is prerelease and moves with `@effect/sql`. A
version combination keel has not compiled against usually surfaces as an error deep in
Drizzle's builder types.

**Fix** pin the exact versions from the [SQL overview](/keel/sql/), and check
`pnpm why drizzle-orm @effect/sql` for a transitive bump.

## OpenAPI

### The document is empty, or routes are missing

**Why** either the routes were registered before the swagger plugin, or they match the
`skipList`, or they carry `schema: { hide: true }`.

**Fix** register `openapiPlugin` with the other globals, before the routers, and check
the `skipList` patterns — a bare string matches any URL _containing_ it.

### `openapi-typescript` fails on an unresolvable `$ref`

**Why** `JSONSchema.make` emits `$ref: "#/$defs/Name"`, which resolves against the
document root where no `$defs` block exists. Keel's `jsonSchemaTransform` inlines them
to avoid exactly this.

**Fix** make sure the transform is actually installed. `openapiPlugin` does it for you;
if you registered `@fastify/swagger` yourself, pass
`transform: jsonSchemaTransform(skipList)` from `@kylobyte/keel/http`.

### A field is documented as the wrong type

**Why** `JSONSchema.make` describes the encoded side, and for a transformation it
sometimes cannot infer a useful representation — a `S.BigInt`, a `S.Date`, a
`S.parseJson(…)`.

**Fix** annotate:

- ids → `BigIntIdSchema`;
- JSON query params → `parseJsonParam(schema)`;
- anything else → `S.annotations({ jsonSchema: { … } })` on the schema, once, where it
  is defined.

### A route needs two tags

**Why** `createOpenapiMetaPlugin` works through an `onRoute` hook that _replaces_
`schema.tags`. One router, one tag.

**Fix** do not register the plugin on that router and set `tags` per route by hand.

## SSE

### Events arrive in a batch, or not until the connection closes

**Why** a proxy is buffering. Keel sets `X-Accel-Buffering: no` and `Cache-Control:
no-cache`, which covers nginx, but other proxies and CDNs need their own configuration.

**Fix** check the proxy in front of the app, and confirm the response headers survive it.

### The stream ends immediately and nothing is logged

**Why** `buildStream` is typed `Effect<void, never, R>`. An error inside it has nowhere
to go — the reply was hijacked and the status line is already sent — so the stream just
ends.

**Fix** handle failures inside `buildStream`: log them, send an error frame, or both. If
the failure can happen before the first frame, move that work into `authorize`, which
runs before the hijack and can still produce a real status.

### An `EventSource` cannot authenticate

**Why** browsers cannot set headers on `EventSource`, so there is no `Authorization`
header to verify.

**Fix** the single-use ticket pattern in the [SSE](/keel/sse/) page: a short-lived token
issued by a normal authenticated `POST`, passed as a query param, consumed by
`authorize`.

## Still stuck

The package ships its `src/` alongside the compiled output, so "go to definition" lands
on real code. Two files answer most questions:

- `src/http/keel.ts` — everything that happens between the request and the reply;
- `src/http/routeTypes.ts` — every compile error that mentions a response schema.

If neither helps, [open an issue](https://github.com/kylobyte-dev/keel/issues) with the
controller's signature and the route's `schema` object — that pair is usually enough to
reproduce a type error.
