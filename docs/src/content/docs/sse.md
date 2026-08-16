---
title: "SSE"
description: "Server-sent events backed by an Effect stream, including authentication for EventSource."
---

`createSseHandlerFactory(runtime)` returns a factory for Server-Sent Events handlers.
An SSE handler is a plain Fastify handler, not a controller: it hijacks the reply and
writes frames itself, so it goes on the route directly, without `createRoute`.

```ts
// shared/app/keel.ts
export const createSseHandler = createSseHandlerFactory(AppRuntime);
```

```ts
// modules/events/events.stream.ts
import { Effect, Stream } from "effect";
import { createSseHandler } from "../../shared/app/keel.ts";
import { EventBusService } from "../../services/events/event-bus.service.ts";
import { TicketService } from "./ticket.service.ts";

export const eventsStreamHandler = createSseHandler({
  authorize: (request) =>
    Effect.gen(function* () {
      const { ticket } = request.query as { ticket: string };
      const tickets = yield* TicketService;
      const userId = yield* tickets.consume(ticket);

      if (!userId) {
        return yield* Effect.fail({
          statusCode: 401,
          message: "Invalid or expired ticket",
        });
      }

      return { userId };
    }),

  buildStream: (context, reply) =>
    Effect.scoped(
      Effect.gen(function* () {
        const bus = yield* EventBusService;
        const dequeue = yield* bus.subscribe(context.userId);

        yield* Stream.fromQueue(dequeue).pipe(
          Stream.tap((event) =>
            Effect.sync(() =>
              reply.raw.write(
                `event: status\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            ),
          ),
          Stream.runDrain,
        );
      }),
    ),
});
```

```ts
// modules/events/events.router.ts
export default router(async (app) => {
  app.get(
    "/events",
    {
      schema: {
        summary: "Stream events",
        querystring: S.Struct({ ticket: S.String }),
        response: { ...errorsSchemas([401]) },
      },
    },
    eventsStreamHandler,
  );
});
```

The split between the two callbacks is the point:

- `authorize` runs **before** the reply is hijacked, so a failure still goes out as a
  normal JSON response with the right status. It fails with
  `{ statusCode, message }`; anything else becomes a 500.
- `buildStream` runs **after**, in a fiber. When the client disconnects the fiber is
  interrupted, which releases everything the scope acquired — the queue subscription
  above included. It cannot fail (`Effect<void, never, R>`): handle errors inside, or
  the stream ends silently.

Headers set by other plugins (CORS, for one) are copied onto the raw response before
the headers are flushed, since hijacking bypasses Fastify's `onSend` lifecycle. Keel
sets `text/event-stream`, `no-cache` and `X-Accel-Buffering: no`, and closes the
response when the stream ends.

Two things keel does not do: framing (write `event:`/`data:` lines yourself — the shape
is up to your protocol) and authentication via headers. Browsers cannot set headers on
an `EventSource`, hence the single-use ticket in the example: a short-lived token
issued by a normal authenticated `POST`, spent by the stream.
