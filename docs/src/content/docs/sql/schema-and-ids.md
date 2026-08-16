---
title: "Schema and ids"
description: "Drizzle table definitions, snake_case columns, and snowflake ids as bigint."
---

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
