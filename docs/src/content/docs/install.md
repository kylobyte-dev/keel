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
service key identity. `helmet`, `@fastify/helmet` and
`@scalar/fastify-api-reference` are optional peers — you only need them if you
import `/openapi`; `drizzle-orm` and `@effect/sql-pg` are optional peers for
`/sql`, plus `snowyflake` if you use its id helper.

The `/sql` peers are pinned to exact versions rather than ranges. Drizzle's Effect
driver (`drizzle-orm/effect-postgres`) is prerelease and moves with Effect's own
SQL layer, which moves fast itself: a range would let a combination keel has never
compiled against resolve into your app. Bumping them is a keel release.

## Versions

Two lines ship in parallel, under two npm dist-tags:

| Install               | Version        | Effect | Drizzle         |
| --------------------- | -------------- | ------ | --------------- |
| `@kylobyte/keel`      | `0.1.x`        | 3.x    | `1.0.0-beta.22` |
| `@kylobyte/keel@beta` | `0.2.0-beta.x` | 4.x rc | `1.0.0-rc.5`    |

```bash
pnpm add @kylobyte/keel@beta
```

`latest` stays on the Effect 3 line. The `0.2` line is an experiment: it tracks
Effect 4 while Effect 4 is itself a release candidate, and its API may move
between betas. **These docs describe the `0.2` line.**

Effect 4 moved its SQL layer into the core package, so `@effect/sql` is gone from
the peers — only the driver, `@effect/sql-pg`, is still separate.

### The 0.2 line needs exact prerelease peers

Both sides are pre-1.0 and the published dist-tags do not currently agree with
each other:

```jsonc
{
  "effect": "4.0.0-rc.109",
  "@effect/sql-pg": "4.0.0-rc.109",
  "drizzle-orm": "1.0.0-rc.5-ab785fc", // NOT the `rc` dist-tag
}
```

Drizzle's `rc` dist-tag (`1.0.0-rc.4`) was built against an earlier Effect beta
and calls `Schema.TaggedErrorClass`, which the Effect release candidate renamed to
`Schema.TaggedError`. Installing it fails at import time with
`TypeError: Schema$1.TaggedErrorClass is not a function` — a message that looks
like a broken install rather than a version mismatch. Use the exact `rc.5` build
above.

### Known gap: annotations on transformations

Effect 4 rc.109 keeps only the annotations attached to leaf schemas when it
generates a JSON Schema; those on a transformation are dropped. Three of keel's
helpers annotate a transformation, so their OpenAPI output degrades:
`BigIntIdSchema` loses its description, `DateSchema` its `date-time` format, and
`parseJsonParam` the structure of the object it carries. Decoding and encoding are
unaffected — the wire contract is right, the document is just less descriptive.

A second generator quirk works the other way round, overstating rather than
understating: a schema carrying a decoding default (`S.withDecodingDefaultType`)
is documented with a `null` branch the decoder rejects. `page` and `pageSize` in
`tableQueryFields` are the two fields keel ships in that shape. The related
`S.optional` case is avoidable and covered in [Schemas at the
boundary](/keel/schemas/#two-effect-4-defaults-that-leak-onto-the-wire).

Installed? [Your first app](/keel/tutorials/first-app/) goes from here to a running,
documented service in about twenty minutes.
