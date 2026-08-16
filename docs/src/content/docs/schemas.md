---
title: "Schemas at the boundary"
description: "Where Effect Schema decoding happens on the way in and encoding on the way out."
---

`effectProviderPlugin` makes Effect Schema the validator and the serializer:
`S.decodeUnknown` on the way in, `S.encodeUnknown` on the way out. So the schema's
**decoded** type is what controllers see, and the **encoded** type is what travels —
a `S.BigIntFromString` field is a `bigint` in your code and a string on the wire,
and the transformation happens in one place.

:::caution[Effect 4 renamed the codecs]
`S.BigInt` and `S.Date` **validate** a value that is already a `bigint` or a
`Date`; they do not decode the string that arrives over HTTP. The codecs that do
are `S.BigIntFromString` and `S.DateFromString`. Both spellings type-check, so a
schema that uses the wrong one compiles and fails at request time.
:::

Serialization is strict. A response that does not match its schema throws
`ResponseSerializationError` (500) with the parse error logged, rather than sending a
body the OpenAPI document does not describe — loud and early, [by
design](/keel/design-decisions/#why-is-serialization-strict-enough-to-500-on-a-mismatch).

Two helpers exist because JSON Schema generation needs a hint:

```ts
import { BigIntIdSchema, parseJsonParam } from "@kylobyte/keel";

// A 64-bit id: `bigint` in code, string in JSON
params: S.Struct({ id: BigIntIdSchema }),

// GET /users?filter={"role":"admin"} — decoded and validated as an object
querystring: S.Struct({ filter: S.optional(parseJsonParam(UserFilterSchema)) }),
```

Without the annotations, the generated document would describe the decoded `bigint`
and a bare `string` respectively.

Schemas are also where response shaping happens. Keep a schema per resource in
`*.schemas.ts` and derive the types from it, so the response type and the document
stay one artifact:

```ts
export const UserSchema = S.Struct({
  id: BigIntIdSchema,
  name: S.String,
  email: S.NullOr(S.String),
  createdAt: S.DateFromString,
});
export type User = S.Schema.Type<typeof UserSchema>;
```
