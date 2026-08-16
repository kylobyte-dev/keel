---
title: "Migrations"
description: "Running Atlas against the Drizzle schema, and what CI checks."
---

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
