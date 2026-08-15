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

## Development

```bash
pnpm install       # `prepare` compiles the package
pnpm check-types   # tsc over sources and tests
pnpm test          # vitest
pnpm pack          # what would actually ship
```
