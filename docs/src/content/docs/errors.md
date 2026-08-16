---
title: "Errors"
description: "Tagged errors mapped to HTTP responses, and how to add statuses specific to your app."
---

A controller fails with a tagged error. Keel maps any failure carrying a numeric
`statusCode` to that status, with `{ message }` as the body:

| Error                 | Status |
| --------------------- | ------ |
| `BadRequestError`     | 400    |
| `UnauthorizedError`   | 401    |
| `ForbiddenError`      | 403    |
| `NotFoundError`       | 404    |
| `ConflictError`       | 409    |
| `InternalServerError` | 500    |

Each takes an optional message and defaults to the reason phrase. They are
`Data.TaggedError`s, so `yield* new NotFoundError("User not found")` fails the Effect
and, in a `catchTag`, narrows by `_tag`.

`errorsSchemas([404, 409])` builds the matching response schemas — `500` is always
included, since any route can die. The type-level rule is one-directional: a status
the controller can produce **must** be declared, but declaring an extra one is
allowed, which is how a route documents a 401 raised by an auth hook.

Anything that fails outside the Effect pipeline — schema validation, a throw inside a
plugin or hook — is caught by `errorHandlerPlugin`:

- a validation failure → 400, `{ statusCode, error, message, details }`, where
  `details` lists the offending paths;
- a thrown error carrying a `statusCode` (an `UnauthorizedError` from an auth hook) →
  that status;
- anything else → 500, logged in full.

A failure raised _inside_ the Effect pipeline takes the other path, and there is one
edge worth knowing: the mapping inspects a plain `Fail` cause, so a tagged error
escaping a concurrent combinator (`Effect.all` with `concurrency`, `Effect.race`)
arrives wrapped and falls through to the 500 branch. See
[Troubleshooting](/keel/troubleshooting/#a-tagged-error-came-back-as-500-instead-of-its-own-status)
for the one-line fix.

One consequence worth knowing: when the route declares a response schema for that
status, the body is encoded through it before it goes out, and `HttpErrorSchema` keeps
only `message`. A 400 from validation reaches the client as `{"message":"Validation
failed"}` — the `details` are in the logs, not on the wire. That is the intended
trade-off (no schema internals leak to callers); a route that wants to return them
declares its own richer 400 schema.

## App-specific statuses

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
runtime behaviour. Mappers run in order, after the `statusCode` check and before the
500 fallback; the first to return a value wins, and the original cause is logged.

The schema side needs widening too, since `errorsSchemas` only knows keel's statuses:

```ts
// shared/parsing.ts
export const errorsSchemas = makeErrorsSchemas<HttpError["statusCode"] | 502>({
  ...errorSchemasDescriptions,
  502: "Bad Gateway",
});
```

Import that helper instead of keel's throughout the app, and `errorsSchemas([502])`
starts type-checking.

Both halves are required and neither implies the other — the mapper is a function on
values, the provider a function on types, and TypeScript will not run the former at
type level. [Why they cannot be
unified](/keel/design-decisions/#why-do-app-specific-statuses-need-both-a-mapper-and-a-type-provider).
