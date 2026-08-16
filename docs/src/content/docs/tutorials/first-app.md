---
title: "Your first app"
description: "Build a keel service from an empty directory: runtime, plugins, a controller, a route, OpenAPI and a test."
---

This is the whole picture built one file at a time. At the end you will have a small
notes API that validates its input, serves an OpenAPI document, and has a test — about
120 lines of application code, no database.

Every step says what it does and _why the file exists_, so the result is something you
can extend rather than a template you own without understanding. If you would rather
see the architecture first, read [Architecture](/keel/architecture/) and come back.

**You will need** Node 24 (or Node 22 with `--experimental-strip-types`), pnpm, and
about twenty minutes.

## 1. Scaffold the project

```bash
mkdir notes-api && cd notes-api
pnpm init
```

Keel is a peer-dependency-heavy package on purpose — see
[why](/keel/design-decisions/#why-are-effect-and-fastify-peer-dependencies) — so its
runtime companions are installed alongside it, not underneath it:

```bash
pnpm add @kylobyte/keel effect fastify fastify-plugin pino pino-pretty \
         @fastify/error @fastify/swagger
pnpm add -D typescript @types/node
```

Set `"type": "module"` in `package.json` and add the two scripts you will use:

```json
{
  "name": "notes-api",
  "type": "module",
  "scripts": {
    "dev": "node --watch src/index.ts",
    "check-types": "tsc --noEmit"
  }
}
```

Node runs the TypeScript directly by stripping the types — there is no build step in
this tutorial. `tsc` is only there to check them.

## 2. Point TypeScript at keel's config

```json
// tsconfig.json
{
  "extends": "@kylobyte/keel/tsconfig.main.json",
  "include": ["src/**/*.ts"],
  "compilerOptions": {
    "types": ["node"]
  }
}
```

Sharing the config is not cosmetic. It sets `erasableSyntaxOnly` (so Node's type
stripping never chokes), `rewriteRelativeImportExtensions` (so you write `./foo.ts` in
imports, as every example in these docs does), `verbatimModuleSyntax`, and `strict`
with `noUncheckedIndexedAccess`. Effect's inference is far more useful under strict
mode, and several of keel's compile-time checks are only checks at all when `strict` is
on.

Create the directory layout now — it is the one from
[The shape of an app](/keel/app-shape/), trimmed to what this tutorial uses:

```bash
mkdir -p src/shared/app src/server/plugins src/modules/notes
```

## 3. Read the configuration once, at boot

```ts
// src/shared/config.ts
import { memoizedConfig } from "@kylobyte/keel/runtime";
import { Config, Effect } from "effect";

export const getServerConfig = memoizedConfig(
  Effect.gen(function* () {
    const port = yield* Config.number("SERVER_PORT").pipe(
      Config.withDefault(3000),
    );
    const host = yield* Config.nonEmptyString("SERVER_HOST").pipe(
      Config.withDefault("0.0.0.0"),
    );

    return { port, host };
  }),
);
```

`memoizedConfig` runs the Effect synchronously the first time the getter is called and
caches the result, so `getServerConfig()` is a plain function you can call from
anywhere — including from code that is not an Effect, like the entrypoint. A malformed
variable throws there, at boot, instead of becoming a 500 on some unlucky request.

## 4. Write a service

Nothing about this file is keel-specific: it is an ordinary Effect service. That is
the point — your business logic does not import the framework.

```ts
// src/modules/notes/notes.service.ts
import { Context, Effect, Layer } from "effect";
import type { CreateNoteBody, Note } from "./notes.schemas.ts";

const make = Effect.gen(function* () {
  const notes = new Map<bigint, Note>();
  let nextId = 1n;

  return {
    list: () => Effect.succeed([...notes.values()]),

    findById: (id: bigint) => Effect.succeed(notes.get(id) ?? null),

    create: (input: CreateNoteBody) =>
      Effect.sync(() => {
        const note: Note = {
          id: nextId++,
          ...input,
          createdAt: new Date(),
        };
        notes.set(note.id, note);

        return note;
      }),

    remove: (id: bigint) => Effect.sync(() => notes.delete(id)),
  };
});

export class NotesService extends Context.Service<
  NotesService,
  Effect.Success<typeof make>
>()("NotesService") {
  static readonly layer = Layer.effect(NotesService, make);
}
```

The shape is written out by the `Context.Service` type parameters — here derived from
the effect that builds it, so the two cannot drift — and the layer that provides it is
a static on the class.

An in-memory `Map` stands in for a database. It also makes one decision concrete: this
service **holds state**, so there must be exactly one of it for the whole process. That
is what decides where it goes in the next step.

## 5. Build the runtime

```ts
// src/shared/app/runtime.ts
import { Layer, ManagedRuntime } from "effect";
import { NotesService } from "../../modules/notes/notes.service.ts";

const layer = Layer.mergeAll(NotesService.layer);

export const AppRuntime = ManagedRuntime.make(layer);
```

This is the file keel does not own. You choose what is in the layer, when it is built,
and when it is disposed; keel closes over the result and never adds to it.

Everything in this layer is a process-wide singleton — built once, shared by every
request. `NotesService` belongs here because of its `Map`: put it in a controller's
layer list instead and each request would build a fresh, empty one. That is the whole
of the [scoping rule](/keel/architecture/#three-places-a-dependency-can-live) —
stateful or expensive things go in the runtime, request-derived things go on the
router, feature-local cheap things go on the controller.

## 6. Bind keel to the runtime

```ts
// src/shared/app/keel.ts
import { createKeel } from "@kylobyte/keel";
import { AppRuntime } from "./runtime.ts";

export const { router, createRouter, createRouterWithErrors } =
  createKeel(AppRuntime);
```

Three lines, and they are what makes the rest of the app type-safe. `createKeel`
captures your runtime's context, so from here on a controller that needs a service the
runtime does not provide is a compile error at the route that uses it — not a failure
at request time.

Most apps never need more than this file, and every module imports `router` from it.

## 7. Register the two mandatory plugins

```ts
// src/server/plugins/effect.global.ts
export { effectProviderPlugin as default } from "@kylobyte/keel";
```

```ts
// src/server/plugins/errors.global.ts
export { errorHandlerPlugin as default } from "@kylobyte/keel";
```

`effectProviderPlugin` installs Effect Schema as Fastify's validator and serializer.
`errorHandlerPlugin` catches everything raised outside the Effect pipeline — a schema
that failed to decode, a throw inside a hook — and turns it into a proper response.

Both must be registered **before any router**, because Fastify reads the compilers when
a route is added. A router registered first would silently treat your Effect Schemas as
JSON Schema and validate nothing.

## 8. Describe the resource

```ts
// src/modules/notes/notes.schemas.ts
import { BigIntIdSchema } from "@kylobyte/keel";
import { Schema as S } from "effect";

const IsoDate = S.DateFromString;

export const NoteSchema = S.Struct({
  id: BigIntIdSchema,
  title: S.String,
  body: S.String,
  createdAt: IsoDate,
});
export type Note = S.Schema.Type<typeof NoteSchema>;

export const CreateNoteBodySchema = S.Struct({
  title: S.NonEmptyString,
  body: S.String,
});
export type CreateNoteBody = S.Schema.Type<typeof CreateNoteBodySchema>;
```

One schema per resource, types derived from it. The response type and the OpenAPI
document are then the same artifact and cannot drift apart.

Two of these lines are about the _encoded_ side — the shape that actually travels:

- `BigIntIdSchema` wraps `S.BigIntFromString`. Your code sees `bigint`, the wire sees
  `"1"`, and the document says `string` rather than trying to describe a 64-bit integer
  JSON has no room for.
- `IsoDate` is `S.DateFromString`, which decodes the ISO string on the way in and
  encodes a `Date` back out.

Note the `FromString` suffix on both. Under Effect 4 plain `S.BigInt` and `S.Date`
_validate_ a value that already has that type rather than decoding the string that
arrives over HTTP — and both spellings type-check, so the wrong one fails only when a
request hits it.

That decoded/encoded distinction is the core of
[Schemas at the boundary](/keel/schemas/).

## 9. Write the controllers

```ts
// src/modules/notes/notes.controller.ts
import {
  controller,
  HttpCreated,
  HttpNoContent,
  NotFoundError,
  type Body,
  type Params,
} from "@kylobyte/keel";
import { Effect } from "effect";
import type { CreateNoteBody } from "./notes.schemas.ts";
import { NotesService } from "./notes.service.ts";

export const listNotes = controller(() =>
  Effect.gen(function* () {
    const notes = yield* NotesService;

    return yield* notes.list();
  }),
);

export const getNote = controller(({ params }: Params<{ id: bigint }>) =>
  Effect.gen(function* () {
    const notes = yield* NotesService;
    const note = yield* notes.findById(params.id);

    if (!note) return yield* new NotFoundError("Note not found");

    return note;
  }),
);

export const createNote = controller(({ body }: Body<CreateNoteBody>) =>
  Effect.gen(function* () {
    const notes = yield* NotesService;

    return new HttpCreated(yield* notes.create(body));
  }),
);

export const deleteNote = controller(({ params }: Params<{ id: bigint }>) =>
  Effect.gen(function* () {
    const notes = yield* NotesService;
    const deleted = yield* notes.remove(params.id);

    if (!deleted) return yield* new NotFoundError("Note not found");

    return new HttpNoContent();
  }),
);
```

Four things to notice, because each is a rule you will keep using:

1. **No second argument.** The layer list is optional, and `NotesService` already lives
   in the runtime — adding `[NotesService.layer]` here would build a second, empty
   one per request.
2. **The input type is a contract.** `Params<{ id: bigint }>` says the route's `params`
   schema must decode to a `bigint`. Declare a field the schema does not produce and
   the _route_ stops compiling.
3. **The return type is the status.** A plain value is a 200; `new HttpCreated(value)`
   is a 201; `new HttpNoContent()` is a 204. Each forces the matching schema key on the
   route.
4. **`NotFoundError` goes in the error channel.** `yield*` on it fails the Effect, and
   the error's `statusCode` becomes the response status. It also becomes part of the
   controller's type, which is what forces the route to declare a `404`.

## 10. Declare the routes

```ts
// src/modules/notes/notes.router.ts
import { BigIntIdSchema, errorsSchemas } from "@kylobyte/keel";
import { Schema as S } from "effect";
import { router } from "../../shared/app/keel.ts";
import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
} from "./notes.controller.ts";
import { CreateNoteBodySchema, NoteSchema } from "./notes.schemas.ts";

const IdParams = S.Struct({ id: BigIntIdSchema });

export default router(async (app, createRoute) => {
  app.get(
    "/notes",
    {
      schema: {
        summary: "List notes",
        response: { ...errorsSchemas([]), 200: S.Array(NoteSchema) },
      },
    },
    createRoute(listNotes),
  );

  app.get(
    "/notes/:id",
    {
      schema: {
        summary: "Get a note",
        params: IdParams,
        response: { ...errorsSchemas([404]), 200: NoteSchema },
      },
    },
    createRoute(getNote),
  );

  app.post(
    "/notes",
    {
      schema: {
        summary: "Create a note",
        body: CreateNoteBodySchema,
        response: { ...errorsSchemas([400]), 201: NoteSchema },
      },
    },
    createRoute(createNote),
  );

  app.delete(
    "/notes/:id",
    {
      schema: {
        summary: "Delete a note",
        params: IdParams,
        response: { ...errorsSchemas([404]), 204: S.Void },
      },
    },
    createRoute(deleteNote),
  );
});
```

A router is a plain Fastify plugin with an extra argument. `app` is typed with the
Effect type provider, so the `schema` keys take Effect Schemas.

`createRoute(controller)` is where the design pays off. Try breaking one of these on
purpose — it is the fastest way to understand what the compiler is doing for you:

- delete `404` from the `getNote` route → **error**, the controller can produce it;
- change `201` to `200` on the create route → **error**, `HttpCreated` says 201;
- change `IdParams` to `S.Struct({ id: S.String })` → **error**, the controller asked
  for a `bigint`;
- add `409` to any route → **fine**, declaring more than you produce is allowed, which
  is how a route documents a status raised by a hook.

`errorsSchemas([])` still emits a `500` — every route can die, so that key is always
required. The `400` on the create route is not produced by the controller at all: it
comes from the validator rejecting a bad body, and declaring it is how the document
tells the truth about that.

## 11. Assemble the server

```ts
// src/server/index.ts
import type { FastifyInstance } from "fastify";
import effectProviderPlugin from "./plugins/effect.global.ts";
import errorHandlerPlugin from "./plugins/errors.global.ts";
import notesRouter from "../modules/notes/notes.router.ts";

export async function createServer(fastify: FastifyInstance) {
  await fastify.register(effectProviderPlugin);
  await fastify.register(errorHandlerPlugin);

  await fastify.register(notesRouter, { prefix: "/api" });

  return fastify;
}
```

Registering routers by hand is fine and stays readable for a while. Once there are
enough of them, `@fastify/autoload` picks them up by filename — the
[Bootstrap](/keel/bootstrap/) page has that version. What never changes is the order:
plugins first, routers second.

Keeping this separate from the entrypoint is what makes the test in step 14 possible:
tests build a Fastify instance and call `createServer` on it, without ever listening on
a port.

## 12. Write the entrypoint

```ts
// src/index.ts
import { pinoInstance } from "@kylobyte/keel/runtime";
import { Effect } from "effect";
import Fastify, { type FastifyBaseLogger } from "fastify";
import { randomUUID } from "node:crypto";
import { createServer } from "./server/index.ts";
import { getServerConfig } from "./shared/config.ts";
import { AppRuntime } from "./shared/app/runtime.ts";

const fastify = Fastify({
  loggerInstance: pinoInstance as FastifyBaseLogger,
  genReqId: (request) =>
    (request.headers["request-id"] as string) ?? randomUUID(),
});

await createServer(fastify);

// Build the layer before serving: a bad config or an unreachable dependency
// fails here, loudly, instead of on the first request.
await AppRuntime.runPromise(Effect.void);

const { port, host } = getServerConfig();
await fastify.listen({ port, host });

const shutdown = async () => {
  await fastify.close();
  await AppRuntime.dispose();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
```

Three things happen here that are easy to skip and unpleasant to debug later:

- **Fastify gets keel's Pino instance.** Fastify's own request logs and your Effect
  logs then land in the same stream, with the same format.
- **`genReqId` honours an inbound `request-id`.** Keel annotates every Effect log with
  `requestId` and `requestPath`, so a log line from inside a controller can be traced
  back to the caller's id.
- **`AppRuntime.dispose` runs on the way out.** It releases everything the layer
  acquired — pools, subscriptions, background fibers. Without it, a rolling deploy
  leaves connections behind.

## 13. Run it

```bash
pnpm dev
```

```bash
curl -X POST localhost:3000/api/notes \
  -H 'content-type: application/json' \
  -d '{"title":"First","body":"Hello"}'
# 201 {"id":"1","title":"First","body":"Hello","createdAt":"2026-…"}

curl localhost:3000/api/notes/1
# 200 {"id":"1",…}

curl localhost:3000/api/notes/99
# 404 {"message":"Note not found"}

curl -X POST localhost:3000/api/notes \
  -H 'content-type: application/json' -d '{"title":""}'
# 400 {"message":"Validation failed"}

curl -i -X DELETE localhost:3000/api/notes/1
# 204, empty body
```

Look at the id in that first response: `"1"`, a string, while your controller was
handling a `bigint`. That is `BigIntIdSchema` encoding on the way out — one schema, two
representations, converted in a place you never had to write.

The 400 is worth a second look too. The controller never ran: the body failed to decode
and `errorHandlerPlugin` answered. The specific issue is in the logs, not in the
response, [on purpose](/keel/design-decisions/#why-do-the-validation-details-disappear-from-the-400-response).

## 14. Add OpenAPI

```bash
pnpm add @fastify/helmet @scalar/fastify-api-reference helmet
```

```ts
// src/server/plugins/openapi.global.ts
import { openapiPlugin } from "@kylobyte/keel/openapi";

export default openapiPlugin({
  info: {
    title: "Notes API",
    version: "1.0.0",
    description: "Notes, for a tutorial.",
  },
  servers: [{ url: "http://localhost:3000", description: "Local" }],
});
```

Register it with the other global plugins, before the routers:

```ts
// src/server/index.ts
import openapiPlugin from "./plugins/openapi.global.ts";

await fastify.register(effectProviderPlugin);
await fastify.register(errorHandlerPlugin);
await fastify.register(openapiPlugin);
```

Restart, and `http://localhost:3000/docs` has the reference — every route, every
status, every schema, generated from the code you already wrote. No annotations, no
second description of the API to keep in sync: the `404` is in the document because the
controller can fail with `NotFoundError`, and the id is documented as a string because
`BigIntIdSchema` says so.

## 15. Add a test

```bash
pnpm add -D vitest
```

A controller is an Effect, so it can be tested without HTTP at all. Provide mocks to
`DefaultWithoutDependencies` — the raw handler, whose requirements are exactly the
services it yields:

```ts
// src/modules/notes/notes.controller.test.ts
import { NotFoundError } from "@kylobyte/keel";
import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { getNote } from "./notes.controller.ts";
import { NotesService } from "./notes.service.ts";

const note = { id: 1n, title: "First", body: "Hello", createdAt: new Date(0) };

const notesService = (overrides: Partial<typeof NotesService.Service> = {}) =>
  Layer.succeed(
    NotesService,
    NotesService.of({
      list: () => Effect.succeed([note]),
      findById: () => Effect.succeed(note),
      create: () => Effect.succeed(note),
      remove: () => Effect.succeed(true),
      ...overrides,
    }),
  );

describe("getNote", () => {
  it("returns the note", async () => {
    const result = await Effect.runPromise(
      getNote
        .DefaultWithoutDependencies({ params: { id: 1n } })
        .pipe(Effect.provide(notesService())),
    );

    expect(result).toEqual(note);
  });

  it("fails with 404 when it does not exist", async () => {
    const exit = await Effect.runPromiseExit(
      getNote
        .DefaultWithoutDependencies({ params: { id: 9n } })
        .pipe(
          Effect.provide(
            notesService({ findById: () => Effect.succeed(null) }),
          ),
        ),
    );

    expect(exit).toStrictEqual(Exit.fail(new NotFoundError("Note not found")));
  });
});
```

That second assertion is a tagged error's structural equality doing the work — no
matching on messages, no `instanceof`.

For the wiring itself — statuses, encoding, validation — build the server and use
`inject`:

```ts
// src/server/server.test.ts
import Fastify from "fastify";
import { expect, it } from "vitest";
import { createServer } from "./index.ts";

it("encodes the id as a string", async () => {
  const app = Fastify();
  await createServer(app);
  await app.ready();

  const created = await app.inject({
    method: "POST",
    url: "/api/notes",
    payload: { title: "First", body: "Hello" },
  });

  expect(created.statusCode).toBe(201);
  expect(created.json().id).toBe("1");
});
```

`inject` gives you the _encoded_ body, which is the only level at which you can catch a
schema whose wire format is not what clients expect. Both styles matter, and
[Testing](/keel/testing/) covers when to reach for which.

## What you built

```
src/
├── index.ts                      # Fastify instance, listen, shutdown
├── server/
│   ├── index.ts                  # plugin and router registration, in order
│   └── plugins/
│       ├── effect.global.ts      # the type provider          — mandatory
│       ├── errors.global.ts      # the error handler          — mandatory
│       └── openapi.global.ts     # swagger + Scalar           — optional
├── shared/
│   ├── config.ts                 # memoizedConfig getters
│   └── app/
│       ├── runtime.ts            # the ManagedRuntime — yours, not keel's
│       └── keel.ts               # createKeel(AppRuntime) → router helpers
└── modules/notes/
    ├── notes.router.ts           # routes and their schemas
    ├── notes.controller.ts       # HTTP-shaped Effects
    ├── notes.schemas.ts          # the resource, decoded and encoded
    └── notes.service.ts          # business logic — no keel imports
```

The layering to keep: **the service knows nothing about HTTP, the controller knows
nothing about Fastify, and the router is the only place the two meet.**

## Next

- [Adding a feature](/keel/tutorials/adding-a-feature/) — the same loop with a real
  database, filters and pagination.
- [Adding authentication](/keel/tutorials/authentication/) — an authenticated router,
  and the caller as a service.
- [Troubleshooting](/keel/troubleshooting/) — when one of those deliberate breakages
  happens by accident.
