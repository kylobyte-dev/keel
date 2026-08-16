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
querystring: S.Struct({ filter: S.optionalKey(parseJsonParam(UserFilterSchema)) }),
```

Without the annotations, the generated document would describe the decoded `bigint`
and a bare `string` respectively.

## Two Effect 4 defaults that leak onto the wire

Both compile, both decode the values you expect, and both put something in the
OpenAPI document that is not true. They are worth knowing before writing the
first schema rather than after generating the first client.

**Optional fields want `S.optionalKey`, not `S.optional`.** `S.optional(T)` means
"absent _or_ `undefined`", and the JSON Schema generator renders that
`undefined` as a `null` branch: the field is documented as `anyOf: [T, null]`
while the decoder rejects `null` with a 400. `S.optionalKey(T)` means "the key
may be absent", which is the only thing that can happen over HTTP — JSON has no
`undefined` and a missing query parameter is a missing key — and it generates
the schema on its own:

```ts
S.Struct({ role: S.optional(S.String) });
// { "role": { "anyOf": [{ "type": "string" }, { "type": "null" }] } }  ← 400 on null

S.Struct({ role: S.optionalKey(S.String) });
// { "role": { "type": "string" } }                                    ← honest
```

`tableQueryFields` and the schemas built by `defineFilter` use `optionalKey` for
this reason. The one case it does not cover is a field carrying a decoding
default (`S.withDecodingDefaultType`), which reintroduces the `null` branch on
its own — the runtime behaviour is still right, the document still overstates.

**Numbers that travel want `S.Finite`, not `S.Number`.** `S.Number` admits `NaN`
and `Infinity`, which JSON cannot represent, so it documents itself as a union of
a number and three magic strings — and then rejects those strings on the way in:

```ts
S.Number; // { "anyOf": [{ "type": "number" },
//              { "type": "string", "enum": ["Infinity", "-Infinity", "NaN"] }] }
S.Finite; // { "type": "number" }
```

The union propagates into every generated client, and a `NaN` that reaches a
response encodes to `null` rather than failing. Use `S.Finite` for anything
crossing the boundary and keep `S.Number` for internal schemas.

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
