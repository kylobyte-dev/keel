---
title: "Install"
description: "Add @kylobyte/keel to a project: entry points, peer dependencies and why they are peers."
---

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
