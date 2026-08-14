import { type FastifyError, type FastifyInstance, errorCodes } from "fastify";
import fp from "fastify-plugin";
import { isHttpError } from "../keel.ts";
import { InternalServerError } from "../response/errors.ts";

/**
 * Fastify error handler for failures raised outside the Effect pipeline
 * (schema validation, throws inside plugins and hooks).
 */
export const errorHandlerPlugin = fp(
  async function errorHandlerPlugin(fastify: FastifyInstance) {
    fastify.setErrorHandler((error: FastifyError, request, reply) => {
      request.log.error(error);

      if (error instanceof errorCodes.FST_ERR_VALIDATION) {
        reply.status(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: "Validation failed",
          details: error.validation,
        });
        return;
      }

      if (isHttpError(error)) {
        reply.status(error.statusCode).send({
          statusCode: error.statusCode,
          message: error.message,
        });
        return;
      }

      const internalError = new InternalServerError();
      reply.status(internalError.statusCode).send({
        statusCode: internalError.statusCode,
        error: "InternalServerError",
        message: internalError.message,
      });
    });
  },
  {
    name: "errors",
  },
);
