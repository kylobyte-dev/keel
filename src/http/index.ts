export { controller } from "./controller.ts";
export type { Controller, ControllerInput } from "./controller.ts";

export { ResponseSerializationError } from "./errors.ts";

export { createKeel, createKeelWith, isHttpError } from "./keel.ts";
export type {
  CreateRoute,
  ErrorMapper,
  Keel,
  KeelOptions,
  Router,
  RouterDefinition,
} from "./keel.ts";

export {
  errorSchemasDescriptions,
  errorsSchemas,
  HttpErrorSchema,
  makeErrorsSchemas,
  parseJsonParam,
} from "./parsing.ts";

export { effectProviderPlugin } from "./plugins/effect.ts";
export { errorHandlerPlugin } from "./plugins/errors.ts";

export {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalServerError,
  NotFoundError,
  UnauthorizedError,
} from "./response/errors.ts";
export type { HttpError } from "./response/errors.ts";

export {
  HttpAccepted,
  HttpCreated,
  HttpNoContent,
  HttpResponse,
} from "./response/success.ts";

export type {
  ApplyExtraStatuses,
  Body,
  ExtraStatusProvider,
  NoExtraStatuses,
  Params,
  Query,
  ResponseSchema,
  SimpleFastifyReply,
  SimpleFastifyRequest,
  SimpleRouteHandlerMethod,
} from "./routeTypes.ts";

export {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "./typeProvider.ts";
export type {
  EffectTypeProvider,
  FastifyPluginAsyncEffect,
} from "./typeProvider.ts";
