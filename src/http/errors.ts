import { createError } from "@fastify/error";
import type { ParseResult } from "effect";

export class ResponseSerializationError extends createError<
  [{ cause: ParseResult.ParseError }]
>("FST_ERR_RESPONSE_SERIALIZATION", "Response doesn't match the schema", 500) {
  cause!: ParseResult.ParseError;
  method: string;
  url: string;

  constructor(
    method: string,
    url: string,
    options: { cause: ParseResult.ParseError },
  ) {
    super({ cause: options.cause });
    this.method = method;
    this.url = url;
  }
}
