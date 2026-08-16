import { createError } from "@fastify/error";
import type { Schema as S } from "effect";

export class ResponseSerializationError extends createError<
  [{ cause: S.SchemaError }]
>("FST_ERR_RESPONSE_SERIALIZATION", "Response doesn't match the schema", 500) {
  cause!: S.SchemaError;
  method: string;
  url: string;

  constructor(method: string, url: string, options: { cause: S.SchemaError }) {
    super({ cause: options.cause });
    this.method = method;
    this.url = url;
  }
}
