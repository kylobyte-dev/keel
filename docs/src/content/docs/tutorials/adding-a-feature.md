---
title: "Adding a feature"
description: "A complete feature module against Postgres, step by step: table, repository, query service, schemas, controller, routes and tests."
---

[Your first app](/keel/tutorials/first-app/) kept everything in memory. This one adds a
real feature to an existing app: a `products` resource backed by Postgres, with a
filtered and paginated list endpoint, a transactional create, and tests.

It is the loop you will run for every feature after this, so it is written as a
checklist you can follow rather than a story. Each step says which file changes and
what would go wrong if you skipped it.

**You will need** a keel app already bootstrapped (steps 1–12 of the first tutorial),
a Postgres you can reach, and the `/sql` peers:

```bash
pnpm add drizzle-orm@1.0.0-beta.22 @effect/sql@0.48.6 @effect/sql-pg@0.49.7 snowyflake@2.0.1
pnpm add -D drizzle-kit
```

Those versions are exact rather than ranges, and
[deliberately so](/keel/design-decisions/#why-are-the-sql-peers-pinned-to-exact-versions).

## The shape of what you are about to write

Nine files, in dependency order. It looks like a lot the first time and takes about ten
minutes the fifth time.

```
src/
├── services/database/database.service.ts   # once per app
├── shared/app/sql.ts                        # once per app
└── modules/product/
    ├── db/product.table.ts                  # Drizzle table
    ├── db/product.repository.ts             # writes
    ├── product.queries.ts                   # reads: filter, sort, paginate
    ├── product.schemas.ts                   # the HTTP resource
    ├── product.service.ts                   # business logic
    ├── product.controller.ts                # HTTP-shaped Effects
    └── product.router.ts                    # routes
```

The first two are app-wide and you write them once. Everything under `modules/product/`
is the per-feature part.

## Step 1 — the database service (once per app)

Keel does not own the connection. Your app decides which variable holds the URL, how
the pool is configured, and which `pg` type parsers are overridden:

```ts
// src/services/database/database.service.ts
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

Add it to the runtime layer — a connection pool is the textbook singleton:

```ts
// src/shared/app/runtime.ts
const layer = Layer.mergeAll(DatabaseService.Default /* , … */);
```

Because it is in the runtime layer, `AppRuntime.runPromise(Effect.void)` at boot now
also proves the database is reachable before the first request arrives.

## Step 2 — bind the SQL helpers (once per app)

```ts
// src/shared/app/sql.ts
import { createSql } from "@kylobyte/keel/sql";
import { DatabaseService } from "../../services/database/database.service.ts";

export const { buildRepository } = createSql(DatabaseService);
```

Same pattern as `createKeel(AppRuntime)`: you hand over your tag, keel closes over it,
and the tag flows into the requirements of every repository built from it. This is the
file every module imports `buildRepository` from.

## Step 3 — the table

```ts
// src/modules/product/db/product.table.ts
import { snowflakeId } from "@kylobyte/keel/sql";
import {
  boolean,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const products = pgTable("products", {
  id: snowflakeId(),
  name: text().notNull(),
  sku: text().notNull().unique(),
  price: numeric({ precision: 12, scale: 2 }).notNull(),
  active: boolean().notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DbProduct = typeof products.$inferSelect;
```

Ordinary Drizzle, with two things worth pausing on:

- **`snowflakeId()`** is a `bigint` primary key defaulted to a Snowflake minted in the
  application, so an insert knows its own id before the round trip and ids sort by
  creation time. It is a default, not a requirement — `uuid().defaultRandom()` works
  with everything else on this page.
- **`timestamp("created_at")`** spells the column name out. Drizzle only infers a name
  from the property when you leave the argument blank, so a multi-word property without
  it becomes a camelCase column in Postgres.

Then generate and apply the migration — see [Migrations](/keel/sql/migrations/) for the
Atlas setup this assumes:

```bash
pnpm migrate:diff add_products
pnpm migrate:apply:local
```

Read the generated SQL before applying it. Every time.

## Step 4 — the repository (writes)

```ts
// src/modules/product/db/product.repository.ts
import { Effect } from "effect";
import { DatabaseService } from "../../../services/database/database.service.ts";
import { buildRepository } from "../../../shared/app/sql.ts";
import { products } from "./product.table.ts";

export class ProductRepositoryService extends Effect.Service<ProductRepositoryService>()(
  "repository/Product",
  {
    effect: buildRepository(products),
    dependencies: [DatabaseService.Default],
  },
) {}
```

That is the whole file. `buildRepository` gives you `insert`, `update` and `delete`
keyed on the table's `id`, plus `withTx` to reissue them inside a transaction.

`insert` and `update` return the written row, or `null` when nothing was written — an
update against an id that no longer exists is not an error, it is a `null` you decide
what to do with.

There is no `findById` here, and that is
[the point](/keel/design-decisions/#why-are-repositories-write-only): reads go in the
next file, where the projection stays visible.

## Step 5 — the query service (reads)

This is where a list endpoint's filtering, sorting and pagination live.

```ts
// src/modules/product/product.queries.ts
import { parseJsonParam } from "@kylobyte/keel";
import {
  applyDateOp,
  applyStringOp,
  buildOrderBy,
  DateOps,
  defineFilter,
  escapeWildcards,
  field,
  paginate,
  StringOps,
  tableQueryFields,
} from "@kylobyte/keel/sql";
import { asc, eq, ilike, or } from "drizzle-orm";
import { Effect, Schema as S } from "effect";
import { DatabaseService } from "../../services/database/database.service.ts";
import { products, type DbProduct } from "./db/product.table.ts";

const productFilter = defineFilter({
  name: field(StringOps, (op) => applyStringOp(products.name, op)),
  sku: field(StringOps, (op) => applyStringOp(products.sku, op)),
  active: field(S.Boolean, (value) => eq(products.active, value)),
  createdAt: field(DateOps, (op) => applyDateOp(products.createdAt, op)),
});

const sortable = {
  name: products.name,
  price: products.price,
  createdAt: products.createdAt,
};

export const ProductQuerySchema = S.Struct({
  ...tableQueryFields,
  sort: S.optional(S.Literal("name", "price", "createdAt")),
  filter: S.optional(parseJsonParam(productFilter.schema)),
});
export type ProductQuery = S.Schema.Type<typeof ProductQuerySchema>;

export class ProductQueryService extends Effect.Service<ProductQueryService>()(
  "query/Product",
  {
    effect: Effect.gen(function* () {
      const database = yield* DatabaseService;

      return {
        listPaginated: (query: ProductQuery) => {
          const where = productFilter.buildWhere(query.filter ?? {}, [
            query.q
              ? or(
                  ilike(products.name, `%${escapeWildcards(query.q)}%`),
                  ilike(products.sku, `%${escapeWildcards(query.q)}%`),
                )
              : undefined,
          ]);

          return paginate<DbProduct>(
            database,
            database
              .select()
              .from(products)
              .where(where)
              .orderBy(buildOrderBy(sortable, query) ?? asc(products.id)),
            query,
          );
        },

        findById: (id: bigint) =>
          database
            .select()
            .from(products)
            .where(eq(products.id, id))
            .limit(1)
            .pipe(Effect.map((rows) => rows[0] ?? null)),
      };
    }),
    dependencies: [DatabaseService.Default],
  },
) {}
```

Four decisions in that file are the ones that repeat for every resource:

1. **`defineFilter` pairs a schema with a SQL builder per field.** Adding a filterable
   field is one line, and HTTP validation and SQL generation both follow from it. There
   is no second place to update.
2. **The `sortable` map is an allow-list.** `buildOrderBy` returns `undefined` for a
   `sort` naming anything outside it, so the caller's default ordering applies — an
   unknown column can neither fail the request nor reach the query.
3. **Free text goes through `escapeWildcards`.** Without it a search for `100%` matches
   every row, because `%` is a `LIKE` wildcard.
4. **`paginate` is handed the query _before_ `limit`/`offset`.** It snapshots the
   subquery for the count first, then applies the page bounds — the Drizzle builder
   mutates in place, so
   [the order matters](/keel/design-decisions/#why-does-paginate-take-the-count-subquery-before-applying-limit).

[Filters, sorting, pagination](/keel/sql/queries/) has the full reference for the
operators available.

## Step 6 — the HTTP schemas

The database row and the API resource are two different things, and keeping them
separate is what lets you add a column without changing the API.

```ts
// src/modules/product/product.schemas.ts
import { BigIntIdSchema } from "@kylobyte/keel";
import { Schema as S } from "effect";

export const ProductSchema = S.Struct({
  id: BigIntIdSchema,
  name: S.String,
  sku: S.String,
  price: S.String,
  active: S.Boolean,
  createdAt: S.Date.pipe(
    S.annotations({ jsonSchema: { type: "string", format: "date-time" } }),
  ),
});
export type Product = S.Schema.Type<typeof ProductSchema>;

export const CreateProductBodySchema = S.Struct({
  name: S.NonEmptyString,
  sku: S.NonEmptyString.pipe(S.pattern(/^[A-Z0-9-]+$/)),
  price: S.String.pipe(S.pattern(/^\d+\.\d{2}$/)),
});
export type CreateProductBody = S.Schema.Type<typeof CreateProductBodySchema>;
```

`price` is a `string` because Drizzle's `numeric` is: sending it as a JavaScript
`number` would silently lose precision on the way through. Serialization is strict, so
a mismatch here is a 500 in a test rather than a rounding bug in production.

## Step 7 — the service

Business logic goes here, and this file imports nothing from keel:

```ts
// src/modules/product/product.service.ts
import { Effect } from "effect";
import { ConflictError } from "@kylobyte/keel";
import { DatabaseService } from "../../services/database/database.service.ts";
import { ProductRepositoryService } from "./db/product.repository.ts";
import { ProductQueryService } from "./product.queries.ts";
import type { CreateProductBody } from "./product.schemas.ts";

export class ProductService extends Effect.Service<ProductService>()(
  "ProductService",
  {
    effect: Effect.gen(function* () {
      const database = yield* DatabaseService;
      const repository = yield* ProductRepositoryService;
      const queries = yield* ProductQueryService;

      return {
        list: queries.listPaginated,
        findById: queries.findById,

        create: (body: CreateProductBody) =>
          database.transaction((transaction) =>
            Effect.gen(function* () {
              const product = yield* repository
                .withTx(transaction)
                .insert(body);

              if (!product)
                return yield* new ConflictError("Product already exists");

              return product;
            }),
          ),
      };
    }),
    dependencies: [
      DatabaseService.Default,
      ProductRepositoryService.Default,
      ProductQueryService.Default,
    ],
  },
) {}
```

One import from keel — `ConflictError` — because the status is a business decision the
service is the right place to make. A failure anywhere inside the transaction callback
rolls it back, tagged errors included, so there is no cleanup path to write.

The transaction is overkill for a single insert; it is here because the second write
you add (a price history row, an audit entry) belongs inside the same one, and
retrofitting it later is where mistakes happen.

## Step 8 — the controller

```ts
// src/modules/product/product.controller.ts
import {
  controller,
  HttpCreated,
  NotFoundError,
  type Body,
  type Params,
  type Query,
} from "@kylobyte/keel";
import { Effect } from "effect";
import type { CreateProductBody } from "./product.schemas.ts";
import type { ProductQuery } from "./product.queries.ts";
import { ProductService } from "./product.service.ts";

export const listProducts = controller(
  ({ querystring }: Query<ProductQuery>) =>
    Effect.gen(function* () {
      const products = yield* ProductService;

      return yield* products.list(querystring);
    }),
  [ProductService.Default],
);

export const getProduct = controller(
  ({ params }: Params<{ id: bigint }>) =>
    Effect.gen(function* () {
      const products = yield* ProductService;
      const product = yield* products.findById(params.id);

      if (!product) return yield* new NotFoundError("Product not found");

      return product;
    }),
  [ProductService.Default],
);

export const createProduct = controller(
  ({ body }: Body<CreateProductBody>) =>
    Effect.gen(function* () {
      const products = yield* ProductService;

      return new HttpCreated(yield* products.create(body));
    }),
  [ProductService.Default],
);
```

`[ProductService.Default]` is the layer list, and this is the case it exists for.
`ProductService` is cheap to build and only these routes use it, so it does not belong
in the runtime layer — the runtime keeps the connection pool, and this gets built per
request on top of it. Note that `ProductService.Default` already carries its own
`dependencies`, so listing it once is enough.

Compare with `DatabaseService`, which is in the runtime: one pool for the process,
never rebuilt. That is the whole
[three-scope rule](/keel/architecture/#three-places-a-dependency-can-live) applied to
one feature.

## Step 9 — the routes

```ts
// src/modules/product/product.router.ts
import { BigIntIdSchema, errorsSchemas } from "@kylobyte/keel";
import { paginatedSchema } from "@kylobyte/keel/sql";
import { Schema as S } from "effect";
import { router } from "../../shared/app/keel.ts";
import {
  createProduct,
  getProduct,
  listProducts,
} from "./product.controller.ts";
import { ProductQuerySchema } from "./product.queries.ts";
import { CreateProductBodySchema, ProductSchema } from "./product.schemas.ts";

export default router(async (app, createRoute) => {
  app.get(
    "/products",
    {
      schema: {
        summary: "List products",
        querystring: ProductQuerySchema,
        response: {
          ...errorsSchemas([400]),
          200: paginatedSchema(ProductSchema),
        },
      },
    },
    createRoute(listProducts),
  );

  app.get(
    "/products/:id",
    {
      schema: {
        summary: "Get a product",
        params: S.Struct({ id: BigIntIdSchema }),
        response: { ...errorsSchemas([404]), 200: ProductSchema },
      },
    },
    createRoute(getProduct),
  );

  app.post(
    "/products",
    {
      schema: {
        summary: "Create a product",
        body: CreateProductBodySchema,
        response: { ...errorsSchemas([400, 409]), 201: ProductSchema },
      },
    },
    createRoute(createProduct),
  );
});
```

Register it next to the other routers, and the feature is live:

```ts
// src/server/index.ts
await fastify.register(productRouter, { prefix: "/api" });
```

`paginatedSchema(ProductSchema)` describes `{ items, total, page, pageSize }` — the
exact shape `paginate` returns. The `409` on the create route is required because
`ProductService.create` can fail with `ConflictError`; drop it and the route stops
compiling.

## Step 10 — test it

Two levels, testing two different things.

**The controller, with a mocked service.** No HTTP, no database:

```ts
// src/modules/product/product.controller.test.ts
import { NotFoundError } from "@kylobyte/keel";
import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { getProduct } from "./product.controller.ts";
import { ProductService } from "./product.service.ts";

const product = {
  id: 1n,
  name: "Anvil",
  sku: "ANVIL-1",
  price: "19.99",
  active: true,
  createdAt: new Date(0),
};

const productService = (overrides: Partial<ProductService> = {}) =>
  Layer.succeed(
    ProductService,
    ProductService.make({
      list: () =>
        Effect.succeed({ items: [product], total: 1, page: 1, pageSize: 20 }),
      findById: () => Effect.succeed(product),
      create: () => Effect.succeed(product),
      ...overrides,
    }),
  );

describe("getProduct", () => {
  it("fails with 404 when the product does not exist", async () => {
    const exit = await Effect.runPromiseExit(
      getProduct
        .DefaultWithoutDependencies({ params: { id: 9n } })
        .pipe(
          Effect.provide(
            productService({ findById: () => Effect.succeed(null) }),
          ),
        ),
    );

    expect(exit).toStrictEqual(
      Exit.fail(new NotFoundError("Product not found")),
    );
  });
});
```

**The wiring, through `inject`.** This is the level where the encoded body is visible —
and the only place a wrong wire format shows up:

```ts
const response = await app.inject({ method: "GET", url: "/api/products/1" });

expect(response.statusCode).toBe(200);
expect(response.json()).toEqual({
  id: "1", // bigint encoded as a string
  name: "Anvil",
  sku: "ANVIL-1",
  price: "19.99",
  active: true,
  createdAt: "1970-01-01T00:00:00.000Z",
});
```

The filter and pagination layer is worth a test of its own, against a real database:
`?filter={"active":true}&sort=name&page=2` exercises `defineFilter`, `buildOrderBy` and
`paginate` at once, and asserting that `total` is larger than `items.length` on page two
catches the one pagination bug that is easy to write.

## The checklist

For the next feature, in order:

1. **Table** — Drizzle, snake_case column names spelled out, then `migrate:diff` and
   read the SQL.
2. **Repository** — `buildRepository(table)` as an `Effect.Service`.
3. **Queries** — `defineFilter`, the sortable allow-list, `paginate`.
4. **Schemas** — the HTTP resource, separate from the row, annotated where the encoded
   type needs a hint.
5. **Service** — business logic and transactions; tagged errors for business outcomes.
6. **Controller** — `controller()`, feature layers in the second argument.
7. **Router** — routes, with a response schema for every status the controller can
   produce.
8. **Tests** — the controller with mocks, the route through `inject`.

## Next

- [Adding authentication](/keel/tutorials/authentication/) — putting this feature behind
  an authenticated router.
- [SQL](/keel/sql/) — the reference for everything used here.
- [Troubleshooting](/keel/troubleshooting/) — for when step 9 does not compile.
