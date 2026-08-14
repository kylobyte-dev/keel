import fastifyPlugin from "fastify-plugin";

/**
 * Builds the plugin that stamps a single OpenAPI tag on every route of a router.
 *
 * The tag union is app-specific, so each app instantiates the plugin once over its
 * own union:
 *
 * @example
 * ```ts
 * // server/plugins/openapiMeta.ts
 * export const openapiMetaPlugin = createOpenapiMetaPlugin<Tag>();
 * ```
 */
export const createOpenapiMetaPlugin = <Tag extends string>() =>
  fastifyPlugin<{
    tag: Tag;
  }>((fastify, options) => {
    fastify.addHook("onRoute", (routeOptions) => {
      routeOptions.schema = {
        ...routeOptions.schema,
        tags: [options.tag],
      };
    });
  });
