# keel

Opinionated Fastify 5 + Effect backend framework — Effect Schema as type provider,
controllers as Effect services, tagged errors mapped to HTTP, Pino↔Effect logging, SSE.

Extracted from the three apps that had been carrying the same micro-framework by
copy-paste: [`nexus-server`](https://github.com/kylobyte-dev/nexus-server),
[`reach`](https://github.com/kylobyte-dev/reach) and `legion`. Keel holds the glue
only — no business logic, no application runtime.

## Packages

| Package          | What's in it                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `@keel/tsconfig` | The shared `tsconfig.main.json`                                                               |
| `@keel/runtime`  | Pino↔Effect logger bridge (`pinoInstance`, `PinoLogger`), `memoizedConfig`, `readonly`/`voidMemo` |
| `@keel/http`     | Schema type provider, `controller()`, routers, response/error types, Fastify plugins           |
| `@keel/sse`      | `createSseHandlerFactory` — server-sent events bound to an app runtime                        |

## Install

Keel is consumed as a git dependency pinned to a tag, one entry per package:

```json
{
  "dependencies": {
    "@keel/http": "github:kylobyte-dev/keel#v0.1.0&path:/packages/http",
    "@keel/runtime": "github:kylobyte-dev/keel#v0.1.0&path:/packages/runtime",
    "@keel/sse": "github:kylobyte-dev/keel#v0.1.0&path:/packages/sse"
  },
  "pnpm": {
    "onlyBuiltDependencies": ["@keel/http", "@keel/runtime", "@keel/sse"]
  }
}
```

Two things are load-bearing here:

- **Every package you use must be listed**, even the ones you never import directly:
  keel's packages depend on each other through `peerDependencies`, so pnpm resolves
  `@keel/runtime` from _your_ dependency graph. One copy of the logger, one copy of
  `effect`, one set of `Context.Tag` identities.
- **`onlyBuiltDependencies`** — pnpm 10 refuses to run a git dependency's build script
  unless it is allow-listed, and keel compiles itself at install time (`prepare`).

`@keel/tsconfig` goes in `devDependencies` (no build script, no allow-list needed):

```json
{ "extends": "@keel/tsconfig/tsconfig.main.json" }
```

`effect`, `fastify`, `pino`, `pino-pretty` and the `@fastify/*` plugins are peer
dependencies — never dependencies. Two instances of `effect` in one process break
`Context.Tag` identity.

## Bootstrap

Keel never owns the application runtime. Each app builds its own `ManagedRuntime` and
hands it to `createKeel`, which closes over it and returns the router helpers; the
runtime's context flows into every controller's requirements from there.

```ts
// shared/app/keel.ts
import { createKeel } from "@keel/http";
import { createSseHandlerFactory } from "@keel/sse";
import { AppRuntime } from "./effect/runtime.ts";

export const { router, createRouter, createRouterWithErrors } =
  createKeel(AppRuntime);

export const createSseHandler = createSseHandlerFactory(AppRuntime);
```

```ts
// modules/people/people.router.ts
import { errorsSchemas } from "@keel/http";
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

export const { router } = createKeelWith<HttpClientExtraStatuses>()(AppRuntime, {
  errorMappers: [
    (error) =>
      isHttpClientError(error)
        ? { statusCode: 502, body: { message: "Bad Gateway" } }
        : undefined,
  ],
});
```

The provider makes `502` a required key of the response schema of every route whose
controller can fail with that family, so the OpenAPI document cannot drift from the
runtime behaviour.

## Development

```bash
pnpm install
pnpm build   # turbo build + check-types (tsc -b, project references)
pnpm test    # vitest
```

Internal cross-package links use `file:../<package>` in `devDependencies` (npm
understands it, so it also works when pnpm builds the package from git) plus tsconfig
`paths` pointing at the sibling's `dist`, so `tsc -b` always type-checks against
freshly built declarations.

## Releasing

Tag the commit; consumers move at their own pace:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Consumers switch to a registry later without touching a single import.
