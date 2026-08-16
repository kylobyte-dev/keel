# keel

Opinionated Fastify 5 + Effect backend framework — Effect Schema as type provider,
controllers as Effect services, tagged errors mapped to HTTP, Pino↔Effect logging, SSE.

Keel is glue only: no business logic, no application runtime. Your app builds its
own `ManagedRuntime` and hands it over.

**📖 [Documentation](https://kylobyte-dev.github.io/keel/)** — the full guide lives
there. The sources are in [`docs/`](./docs/src/content/docs) and the site is built
with Starlight.

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
`Context.Tag` identity. Which peers are optional, and why the `/sql` ones are
pinned to exact versions, is covered in
[Install](https://kylobyte-dev.github.io/keel/install/).

## Guide

| Page                                                                    | What's in it                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [The shape of an app](https://kylobyte-dev.github.io/keel/app-shape/)   | How the pieces fit together before writing any code                |
| [Bootstrap](https://kylobyte-dev.github.io/keel/bootstrap/)             | Building the runtime, handing it to keel, wiring Fastify           |
| [Controllers](https://kylobyte-dev.github.io/keel/controllers/)         | Controllers as Effect services, and what a handler returns         |
| [Routes](https://kylobyte-dev.github.io/keel/routes/)                   | Route declaration, and routers carrying request context            |
| [Errors](https://kylobyte-dev.github.io/keel/errors/)                   | Tagged errors mapped to HTTP, and app-specific statuses            |
| [Schemas at the boundary](https://kylobyte-dev.github.io/keel/schemas/) | Where decoding and encoding happen                                 |
| [Runtime](https://kylobyte-dev.github.io/keel/runtime/)                 | Pino↔Effect logging, `memoizedConfig`, helpers                     |
| [OpenAPI](https://kylobyte-dev.github.io/keel/openapi/)                 | Generating the document, serving the reference                     |
| [SSE](https://kylobyte-dev.github.io/keel/sse/)                         | Server-sent events over an Effect stream                           |
| [SQL](https://kylobyte-dev.github.io/keel/sql/)                         | Drizzle over `@effect/sql`: ids, repositories, filters, migrations |
| [Testing](https://kylobyte-dev.github.io/keel/testing/)                 | Unit-testing controllers, and driving routes through `inject`      |

## Development

```bash
pnpm install       # `prepare` compiles the package
pnpm check-types   # tsc over sources and tests
pnpm test          # vitest
pnpm pack          # what would actually ship
```

The documentation site is a separate project under [`docs/`](./docs), with its own
dependencies:

```bash
pnpm docs:install  # docs/ has its own lockfile — Astro never enters this one
pnpm docs:dev      # Starlight dev server
pnpm docs:build    # static build, and internal link validation
```
