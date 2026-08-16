---
title: "Repositories"
description: "Repositories as Effect services, and transactions that roll back on tagged errors."
---

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
