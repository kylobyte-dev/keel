import { Data } from "effect";

export class BadRequestError extends Data.TaggedError("BadRequestError")<{
  message: string;
  statusCode: 400;
}> {
  constructor(message = "Bad Request") {
    super({ message, statusCode: 400 });
  }
}

export class UnauthorizedError extends Data.TaggedError("UnauthorizedError")<{
  message: string;
  statusCode: 401;
}> {
  constructor(message = "Unauthorized") {
    super({ message, statusCode: 401 });
  }
}

export class ForbiddenError extends Data.TaggedError("ForbiddenError")<{
  message: string;
  statusCode: 403;
}> {
  constructor(message = "Forbidden") {
    super({ message, statusCode: 403 });
  }
}

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  message: string;
  statusCode: 404;
}> {
  constructor(message = "Not Found") {
    super({ message, statusCode: 404 });
  }
}

export class ConflictError extends Data.TaggedError("ConflictError")<{
  message: string;
  statusCode: 409;
}> {
  constructor(message = "Conflict") {
    super({ message, statusCode: 409 });
  }
}

export class InternalServerError extends Data.TaggedError(
  "InternalServerError",
)<{
  message: string;
  statusCode: 500;
}> {
  constructor(message = "Internal Server Error") {
    super({ message, statusCode: 500 });
  }
}

export type HttpError =
  | BadRequestError
  | UnauthorizedError
  | ForbiddenError
  | NotFoundError
  | ConflictError
  | InternalServerError;
