---
title: "OpenAPI"
description: "Generating an OpenAPI document from route schemas and serving the Scalar reference."
---

`openapiPlugin` wires `@fastify/swagger` to the Effect Schema transform and mounts the
Scalar UI. Register it globally, before the routers.

```ts
// server/plugins/openapi.global.ts
import { openapiPlugin } from "@kylobyte/keel/openapi";
import { tags } from "../../openapi/tags.ts";
import { getJWKSConfig } from "../../shared/config/index.ts";

export default openapiPlugin({
  info: {
    title: "Example API",
    version: "1.0.0",
    description: "What this service does.",
  },
  tags,
  servers: [
    { description: "Local server", url: "https://api.example.internal" },
  ],
  securitySchemes: {
    bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
  },
  skipList: [/^docs\//],
});
```

| Option               | Default | What it does                                                      |
| -------------------- | ------- | ----------------------------------------------------------------- |
| `info`               | —       | The document's `info` block                                       |
| `tags`               | —       | Tag catalogue, keyed by name, with descriptions and external docs |
| `servers`            | —       | The `servers` list                                                |
| `securitySchemes`    | —       | `components.securitySchemes`                                      |
| `skipList`           | `[]`    | Routes hidden from the document, by URL substring or regexp       |
| `routePrefix`        | `/docs` | Where the Scalar UI is mounted                                    |
| `cspDirectives`      | —       | CSP directives merged over the defaults Scalar needs              |
| `redirectRootToDocs` | `true`  | `GET /` → the docs                                                |

A route is hidden from the document either through `skipList` or with
`schema: { hide: true }`.

Tags are stamped per router rather than per route. Instantiate the plugin once over
the app's tag union, then register it at the top of each router:

```ts
// server/plugins/openapiMeta.ts
import { createOpenapiMetaPlugin } from "@kylobyte/keel/openapi";
import type { tags } from "../../openapi/tags.ts";

export const openapiMetaPlugin = createOpenapiMetaPlugin<keyof typeof tags>();
```

```ts
export default authenticatedRouter(async (app, createRoute) => {
  await app.register(openapiMetaPlugin, { tag: "User" });

  // every route defined below is tagged "User"
});
```

It works through an `onRoute` hook and **replaces** `schema.tags`, so a route cannot
opt into a second tag while the plugin is registered — one router, one tag.

The transform behind all this (`jsonSchemaTransform`, also exported from `/http` if you
need to build the Swagger registration yourself) runs `Schema.toJsonSchemaDocument`
per schema, folds its `definitions` back under `$defs`, and then inlines them. Effect emits reusable definitions as `$ref: "#/$defs/Name"`,
which resolves against the document root — where `$defs` does not exist, since it sits
nested inside the route schema. Scalar tolerates the dangling ref; strict bundlers like
`openapi-typescript` do not. Inlining makes every schema self-contained; a recursive
schema is left as-is rather than expanded forever.
