import fp from "fastify-plugin";
import { serializerCompiler, validatorCompiler } from "../typeProvider.ts";

/**
 * Wires Effect `Schema` in as Fastify's validator and serializer.
 * Register it as a global plugin, before any router.
 */
export const effectProviderPlugin = fp(
  function effectProviderPlugin(fastify) {
    fastify.setValidatorCompiler(validatorCompiler);
    fastify.setSerializerCompiler(serializerCompiler);
  },
  {
    name: "effectProvider",
  },
);
