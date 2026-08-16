---
title: "Filters, sorting, pagination"
description: "Table query params decoded into Drizzle conditions, with paginated responses."
---

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
  sort: S.optional(S.Literals(["name", "email", "createdAt"])),
  filter: S.optional(parseJsonParam(userFilter.schema)),
});
export type UserQuery = S.Schema.Type<typeof UserQuerySchema>;
```

`StringOps` accepts `{ eq }`, `{ neq }`, `{ like }` and `{ in }`; `DateOps` accepts
`{ gte }`, `{ lte }` and `{ between }`. A field can also take any schema of your own,
as `role` does above. `filter` arrives JSON-encoded in the query string —
`parseJsonParam` decodes it, so `GET /users?filter={"role":"admin"}` is validated
against the schema. It also asks for the object to be documented via the standard
`contentSchema` keyword — see
[Install](/keel/install/#known-gap-annotations-on-transformations) for why that
part does not reach the document yet.

`tableQueryFields` is the flat set every list endpoint shares: `sort`, `dir`, `q`,
`page` (default 1) and `pageSize` (default 20, capped at 100). Spread it rather than
using `TableQuerySchema` directly whenever the route narrows `sort` to its own
columns, as above.

```ts
const userQuery = Effect.gen(function* () {
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
});

export class UserQueryService extends Context.Service<
  UserQueryService,
  Effect.Success<typeof userQuery>
>()("query/User") {
  static readonly layer = Layer.effect(UserQueryService, userQuery).pipe(
    Layer.provide(DatabaseService.layer),
  );
}
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
  [UserQueryService.layer],
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
