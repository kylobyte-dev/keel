---
title: "Runtime"
description: "The Pino↔Effect logger, memoizedConfig, and the small runtime helpers keel ships."
---

`@kylobyte/keel/runtime` is the small non-HTTP surface.

**Logging.** `pinoInstance` is the shared Pino logger — it redacts
`headers.authorization` and goes through `pino-pretty`. `PinoLogger` is the Effect
`Logger` that writes to it, mapping Effect's log levels onto Pino's and rendering
annotations, spans, fiber id and the full `Cause`. Every router built by keel replaces
the default Effect logger with it, and keel annotates each request's logs with
`requestId` and `requestPath`, so a log line inside a controller carries the request it
belongs to:

```ts
yield *
  Effect.logInfo("provisioning started").pipe(
    Effect.annotateLogs("nodeId", String(node.id)),
  );
```

**Config.** `memoizedConfig` runs an Effect built from `Config` descriptors once,
synchronously, and caches the result:

```ts
// shared/config/index.ts
import { memoizedConfig } from "@kylobyte/keel/runtime";
import { Config, Effect } from "effect";

export const getServerConfig = memoizedConfig(
  Effect.gen(function* () {
    const port = yield* Config.number("SERVER_PORT");
    const host = yield* Config.nonEmptyString("SERVER_HOST");

    return { port, host };
  }),
);
```

A missing or malformed variable throws at the first call rather than being threaded
through the request path as an error channel. Call the getter at boot — in the
entrypoint, or in a service's constructor Effect — so the failure happens at startup.

**Utilities.** `readonly(value)` is a type-level cast to `Readonly<T>` (keel applies it
to every controller result). `voidMemo(getter)` is the one-shot memoizer
`memoizedConfig` is built on.
