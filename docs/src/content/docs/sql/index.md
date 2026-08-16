---
title: "SQL"
description: "The optional /sql entry point: Drizzle over @effect/sql, and what keel adds on top."
---

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

The pages that follow are the reference for each piece.
[Adding a feature](/keel/tutorials/adding-a-feature/) uses all of them at once, in
order, to build one complete module — start there if you would rather see the shape
before the details.
