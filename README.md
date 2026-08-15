# keel

Opinionated Fastify 5 + Effect backend framework — Effect Schema as type provider,
controllers as Effect services, tagged errors mapped to HTTP, Pino↔Effect logging, SSE.

Keel is glue only: no business logic, no application runtime. Your app builds its
own `ManagedRuntime` and hands it over.

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
| `@kylobyte/keel/sql`                | `createSql`, filters, table query params, `paginate`                               |
| `@kylobyte/keel/openapi`            | `openapiPlugin`, `createOpenapiMetaPlugin`                                         |
| `@kylobyte/keel/tsconfig.main.json` | The shared TypeScript config: `{ "extends": "@kylobyte/keel/tsconfig.main.json" }` |

`effect`, `fastify`, `pino`, `pino-pretty` and the `@fastify/*` plugins are **peer
dependencies**, never dependencies: two instances of `effect` in one process break
`Context.Tag` identity. `helmet`, `@fastify/helmet` and
`@scalar/fastify-api-reference` are optional peers — you only need them if you
import `/openapi`; `drizzle-orm`, `@effect/sql` and `@effect/sql-pg` are optional
peers for `/sql`.

`/sql` is built against `drizzle-orm@^1.0.0-beta.22`, whose Effect driver lives at
`drizzle-orm/effect-postgres`. Depend on an explicit beta range rather than the
`beta` dist-tag: the tag floats, and a new publish would otherwise land in your app
without a lockfile change.

## Bootstrap

Keel never owns the application runtime. Each app builds its own `ManagedRuntime` and
hands it to `createKeel`, which closes over it and returns the router helpers; the
runtime's context flows into every controller's requirements from there.

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
runtime behaviour.

## SQL

Same deal as the runtime: keel does not own the database connection. The app builds
its own Drizzle Effect service — it decides which variable holds the URL, how the
pool is configured, which `pg` type parsers are overridden — and hands the tag to
`createSql`, which closes over it and returns the helpers.

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

### Repositories

`buildRepository(table)` is write-only: `insert`, `update`, `delete`, keyed on the
table's `id` column. Reads — including simple ID lookups — belong in feature-specific
query services that use the database service directly, where the projection and the
joins are visible at the call site.

```ts
export class UserRepositoryService extends Effect.Service<UserRepositoryService>()(
  "repository/User",
  {
    effect: buildRepository(users),
    dependencies: [DatabaseService.Default],
  },
) {}
```

`withTx` reissues the same operations through a running transaction, so writes that
must land together stay in one:

```ts
const createPlan = (body: CreatePlanBody) =>
  Effect.gen(function* () {
    const database = yield* DatabaseService;

    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const plan = yield* planRepo.withTx(transaction).insert(body.plan);

        yield* priceRepo.withTx(transaction).insert({
          planId: plan.id,
          ...body.price,
        });

        return plan;
      }),
    );
  });
```

### Filters, sorting, pagination

`defineFilter` bundles an Effect Schema with a Drizzle condition per field. Adding a
field is one change: HTTP validation and SQL generation both follow.

```ts
const userFilter = defineFilter({
  name: field(StringOps, (op) => applyStringOp(users.name, op)),
  createdAt: field(DateOps, (op) => applyDateOp(users.createdAt, op)),
});

export const UserQuerySchema = S.Struct({
  ...tableQueryFields, // sort, dir, q, page, pageSize
  sort: S.optional(S.Literal("name", "createdAt")),
  filter: S.optional(parseJsonParam(userFilter.schema)),
});

const listUsers = (query: UserQuery) =>
  Effect.gen(function* () {
    const database = yield* DatabaseService;

    const where = userFilter.buildWhere(query.filter ?? {}, [
      query.q ? ilike(users.name, `%${escapeWildcards(query.q)}%`) : undefined,
    ]);

    return yield* paginate<DbUser>(
      database,
      database
        .select()
        .from(users)
        .where(where)
        .orderBy(buildOrderBy(getColumns(users), query) ?? asc(users.id)),
      query,
    );
  });
```

`paginate` runs the page and the total concurrently, counting over the filtered but
unpaginated query; `paginatedSchema(UserSchema)` is the matching response schema.
The column map passed to `buildOrderBy` is the allow-list — a `sort` naming anything
else falls back to the caller's default ordering instead of failing the request, and
user input reaching `ilike` goes through `escapeWildcards` so a search for `100%`
does not match every row.

### Migrations

Keel has no opinion here, and ships nothing: schema files, the migration directory
and the tooling that diffs them (Atlas, drizzle-kit, anything else) stay in the app,
next to the database they describe.

## Development

```bash
pnpm install       # `prepare` compiles the package
pnpm check-types   # tsc over sources and tests
pnpm test          # vitest
pnpm pack          # what would actually ship
```
