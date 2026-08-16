---
title: "Bootstrap"
description: "Build the runtime, hand it to keel, and wire Fastify — plugins, hooks and shutdown."
---

Keel never owns the application runtime. Each app builds its own `ManagedRuntime` and
hands it to `createKeel`, which closes over it and returns the router helpers; the
runtime's context flows into every controller's requirements from there.

```ts
// shared/app/effect/runtime.ts
import { Layer, ManagedRuntime } from "effect";
import { DatabaseService } from "../../../services/database/database.service.ts";
import { RedisService } from "../../../services/redis/redis.service.ts";

const layer = Layer.mergeAll(DatabaseService.Default, RedisService.Default);

export const AppRuntime = ManagedRuntime.make(layer);
export type AppRuntimeContext =
  typeof AppRuntime extends ManagedRuntime.ManagedRuntime<infer R, any>
    ? R
    : never;
```

Everything in that layer is a process-wide singleton: one connection pool, one Redis
client, one queue producer, shared by every request. Services that are cheap and
request-scoped go on the controller instead (see [Controllers](/keel/controllers/)).

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

## Wiring Fastify

Two global plugins are mandatory, and both must be registered before any router:
`effectProviderPlugin` installs Effect Schema as the validator and serializer, and
`errorHandlerPlugin` catches everything raised outside the Effect pipeline.

```ts
// server/plugins/effect.global.ts
export { effectProviderPlugin as default } from "@kylobyte/keel";

// server/plugins/errors.global.ts
export { errorHandlerPlugin as default } from "@kylobyte/keel";
```

```ts
// server/index.ts
import AutoLoad from "@fastify/autoload";
import Cors from "@fastify/cors";
import Helmet from "@fastify/helmet";
import type { FastifyInstance } from "fastify";
import path from "node:path";

export async function createServer(fastify: FastifyInstance) {
  await fastify.register(Helmet, {
    global: true,
    contentSecurityPolicy: false,
  });
  await fastify.register(Cors, {
    origin:
      process.env.CORS_ORIGIN?.split(",").map((origin) => origin.trim()) ??
      false,
    credentials: true,
  });

  await fastify.register(AutoLoad, {
    dir: path.join(import.meta.dirname, "plugins"),
    dirNameRoutePrefix: false,
    matchFilter: (filePath) => /\.global\.(ts|js)$/.test(filePath),
  });

  await fastify.register(AutoLoad, {
    dir: path.join(import.meta.dirname, "../modules"),
    dirNameRoutePrefix: false,
    options: { prefix: "/api" },
    matchFilter: (filePath) => /\.router\.(ts|js)$/.test(filePath),
  });

  return fastify;
}
```

Autoloading is a convenience, not a requirement — a router is a plain Fastify plugin,
so `fastify.register(peopleRouter, { prefix: "/api" })` works just as well. What does
matter is the order: the type provider first, then the routers.

The entrypoint owns the Fastify instance, and hands keel's Pino instance to it so
Fastify's own logs and the Effect logs land in the same stream:

```ts
// index.ts
import { pinoInstance } from "@kylobyte/keel/runtime";
import { Effect } from "effect";
import Fastify, { type FastifyBaseLogger } from "fastify";
import { randomUUID } from "node:crypto";
import { createServer } from "./server/index.ts";
import { AppRuntime } from "./shared/app/effect/runtime.ts";
import { getServerConfig } from "./shared/config/index.ts";

const fastify = Fastify({
  loggerInstance: pinoInstance as FastifyBaseLogger,
  genReqId: (request) =>
    (request.headers["request-id"] as string) ?? randomUUID(),
});

await createServer(fastify);
await AppRuntime.runPromise(Effect.void); // build the layer before serving

const { port, host } = getServerConfig();
await fastify.listen({ port, host });
```

Running `Effect.void` on the runtime forces the layer to build at boot: a missing
environment variable or an unreachable database fails there, loudly, instead of on the
first request. On the way out, `AppRuntime.dispose` releases everything the layer
acquired — wire it into whatever handles shutdown (`@gquittet/graceful-server`,
`process.on("SIGTERM")`, your platform's hook).
