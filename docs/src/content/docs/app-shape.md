---
title: "The shape of an app"
description: "How a keel application is laid out: layers, the managed runtime, and where each piece belongs."
---

Keel does not impose a directory layout, but everything below assumes the one it was
extracted from: global plugins in one place, and a folder per feature holding its
routes, controllers, services and schemas side by side.

This page is the map. [Architecture](/keel/architecture/) is the same picture from the
inside — what each part of keel does and how a request actually flows through it — and
[Your first app](/keel/tutorials/first-app/) builds this layout one file at a time.

```
src/
├── index.ts                        # Fastify instance, listen, graceful shutdown
├── server/
│   ├── index.ts                    # plugin + router autoloading
│   └── plugins/
│       ├── effect.global.ts        # effectProviderPlugin
│       ├── errors.global.ts        # errorHandlerPlugin
│       ├── openapi.global.ts       # openapiPlugin
│       ├── auth.ts                 # per-router: JWT verification
│       └── openapiMeta.ts          # per-router: OpenAPI tag
├── shared/
│   └── app/
│       ├── keel.ts                 # createKeel(AppRuntime) → routers
│       ├── sql.ts                  # createSql(DatabaseService) → repositories
│       └── effect/runtime.ts       # the app's ManagedRuntime
├── services/                       # cross-feature services (db, redis, queues, ...)
└── modules/
    └── user/
        ├── user.router.ts          # routes + schemas
        ├── user.controller.ts      # HTTP-shaped Effects
        ├── user.service.ts         # business logic
        ├── user.queries.ts         # reads: filters, sorting, pagination
        ├── user.schemas.ts         # Effect Schemas for body/params/response
        └── db/user.repository.ts   # writes
```

A request goes through:

1. **Fastify validation** — the route's `body`/`params`/`querystring` schemas are
   decoded by the Effect validator. A failure never reaches your code: it becomes a
   400 from the error handler plugin.
2. **The router's request provider** — a `Layer` built from the `FastifyRequest`
   (the authenticated user, a tenant, a request-scoped logger).
3. **The controller** — receives the decoded `{ body, params, querystring }` and
   returns an Effect, run on the app runtime with that layer provided.
4. **The reply** — a plain value is sent as 200, an `HttpResponse` carries its own
   status, a tagged failure becomes its `statusCode`, anything else is a 500.
5. **Fastify serialization** — the response schema for the status being sent encodes
   the body. A body that does not match the schema is a 500, not a silent drift.

Headers are deliberately absent from step 3: a controller only sees validated input.
Anything read off the raw request — a token, a signature, an `Accept-Language` — is
turned into a service by the router's request provider, so the controller stays a
function of its input and its dependencies. That constraint is
[load-bearing](/keel/design-decisions/#why-cant-a-controller-see-the-request), not
stylistic.

The step-by-step version of each of those five stages, with the piece of keel
responsible for it, is in
[the lifecycle of a request](/keel/architecture/#the-lifecycle-of-a-request).
