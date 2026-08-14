# keel

Opinionated Fastify 5 + Effect backend framework — Effect Schema as type provider,
controllers as Effect services, tagged errors mapped to HTTP, Pino↔Effect logging, SSE.

Keel is glue only: no business logic, no application runtime. Your app builds its
own `ManagedRuntime` and hands it over.

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
| `@kylobyte/keel/openapi`            | `openapiPlugin`, `createOpenapiMetaPlugin`                                         |
| `@kylobyte/keel/tsconfig.main.json` | The shared TypeScript config: `{ "extends": "@kylobyte/keel/tsconfig.main.json" }` |

`effect`, `fastify`, `pino`, `pino-pretty` and the `@fastify/*` plugins are **peer
dependencies**, never dependencies: two instances of `effect` in one process break
`Context.Tag` identity. `helmet`, `@fastify/helmet` and
`@scalar/fastify-api-reference` are optional peers — you only need them if you
import `/openapi`.

## Bootstrap

Keel never owns the application runtime. Each app builds its own `ManagedRuntime` and
hands it to `createKeel`, which closes over it and returns the router helpers; the
runtime's context flows into every controller's requirements from there.

```ts
// shared/app/keel.ts
import { createKeel } from "@kylobyte/keel";
import { createSseHandlerFactory } from "@kylobyte/keel/sse";
import { AppRuntime } from "./effect/runtime.ts";

export const { router, createRouter, createRouterWithErrors } =
  createKeel(AppRuntime);

export const createSseHandler = createSseHandlerFactory(AppRuntime);
```

```ts
// modules/people/people.router.ts
import { errorsSchemas } from "@kylobyte/keel";
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

A controller whose requirements the runtime cannot satisfy is a compile error at the
route definition — that inference is the point of the whole design.

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

export const { router } = createKeelWith<HttpClientExtraStatuses>()(
  AppRuntime,
  {
    errorMappers: [
      (error) =>
        isHttpClientError(error)
          ? { statusCode: 502, body: { message: "Bad Gateway" } }
          : undefined,
    ],
  },
);
```

The provider makes `502` a required key of the response schema of every route whose
controller can fail with that family, so the OpenAPI document cannot drift from the
runtime behaviour.

## Development

```bash
pnpm install       # `prepare` compiles the package
pnpm check-types   # tsc over sources and tests
pnpm test          # vitest
pnpm pack          # what would actually ship
```

## Releasing

Bump `version` in `package.json`, merge, then tag:

```bash
git tag v0.1.2 && git push origin v0.1.2
```

The Release workflow refuses to publish when the tag and `package.json` disagree,
then publishes with npm provenance — the tarball carries a signed attestation
binding it to the commit and the workflow run that produced it.

There is no npm token anywhere: the package is configured with a **trusted
publisher** (`kylobyte-dev/keel`, workflow `release.yml`, no environment) and the
workflow authenticates with the OIDC token minted by `id-token: write`. Two
consequences worth knowing before changing anything here:

- renaming `release.yml`, or adding an `environment:` to the publish job, breaks
  the match and the publish is rejected — update the trusted publisher first;
- publishing by hand still works (`npm publish`, which will ask for your 2FA
  code) but produces no provenance, since only CI can generate the attestation.
