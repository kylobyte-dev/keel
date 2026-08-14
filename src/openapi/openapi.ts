import FastifyHelmet from "@fastify/helmet";
import Swagger from "@fastify/swagger";
import FastifyScalarUi from "@scalar/fastify-api-reference";
import { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import helmet from "helmet";
import { jsonSchemaTransform } from "../http/typeProvider.ts";

/** Shape of an app's OpenAPI tag catalogue (`openapi/tags.ts`). */
export type OpenapiTagDefs = Record<
  string,
  {
    description?: string;
    externalDocs?: {
      description?: string;
      url: string;
    };
  }
>;

export interface OpenapiPluginOptions {
  /** `info` block of the OpenAPI document. */
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description?: string;
  };
  /** Tag catalogue, keyed by tag name. */
  readonly tags?: OpenapiTagDefs;
  readonly servers?: readonly {
    readonly url: string;
    readonly description?: string;
  }[];
  /** `components.securitySchemes` of the OpenAPI document. */
  readonly securitySchemes?: Record<string, unknown>;
  /** Routes to hide from the document, by URL substring or pattern. */
  readonly skipList?: (string | RegExp)[];
  /** Where the Scalar UI is mounted. Defaults to `/docs`. */
  readonly routePrefix?: `/${string}`;
  /**
   * CSP directives for the Scalar UI, merged over keel's defaults (which allow the
   * jsDelivr CDN, Scalar's fonts and its proxy). Pass a full array to replace a
   * directive — e.g. `"connect-src"` extended with the app's auth host.
   */
  readonly cspDirectives?: Record<string, string[]>;
  /** Redirect `GET /` to the docs. Defaults to `true`. */
  readonly redirectRootToDocs?: boolean;
}

const buildTags = (tags: OpenapiTagDefs) =>
  Object.entries(tags).map(([name, { description, externalDocs }]) => ({
    name,
    description,
    externalDocs,
  }));

const scalarCspDirectives = () => ({
  ...helmet.contentSecurityPolicy.getDefaultDirectives(),
  "script-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
  "style-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
  "img-src": ["'self'", "data:", "https://cdn.jsdelivr.net"],
  "font-src": [
    "'self'",
    "https://cdn.jsdelivr.net",
    "https://fonts.scalar.com",
  ],
  "connect-src": [
    "'self'",
    "https://cdn.jsdelivr.net",
    "https://proxy.scalar.com",
  ],
});

/**
 * Builds the global OpenAPI plugin: `@fastify/swagger` fed by the Effect Schema
 * transform, plus the Scalar UI behind a scoped CSP override.
 *
 * @example
 * ```ts
 * // server/plugins/openapi.global.ts
 * export default openapiPlugin({
 *   info: { title: "Reach API", version: "1.0.0" },
 *   tags,
 *   servers: [{ description: "Local server", url: "https://api.reach.internal" }],
 *   skipList: [/^docs\//],
 * });
 * ```
 */
export const openapiPlugin = (options: OpenapiPluginOptions) => {
  const routePrefix = options.routePrefix ?? "/docs";

  return fp(
    async function openapiPlugin(fastify: FastifyInstance) {
      await fastify.register(Swagger, {
        openapi: {
          info: options.info,
          tags: options.tags ? buildTags(options.tags) : undefined,
          servers: options.servers ? [...options.servers] : undefined,
          openapi: "3.1.0",
          ...(options.securitySchemes
            ? { components: { securitySchemes: options.securitySchemes } }
            : {}),
        } as any,
        transform: jsonSchemaTransform(options.skipList ?? []),
      });

      // Scoped registration for Scalar to override global CSP
      await fastify.register(async (scope) => {
        await scope.register(FastifyHelmet, {
          contentSecurityPolicy: {
            directives: {
              ...scalarCspDirectives(),
              ...options.cspDirectives,
            },
          },
        });

        await scope.register(FastifyScalarUi, {
          routePrefix,
          configuration: {
            cdn: "https://cdn.jsdelivr.net/npm/@scalar/api-reference",
          },
        });
      });

      if (options.redirectRootToDocs !== false) {
        fastify.get("/", { schema: { hide: true } }, (_request, reply) => {
          reply.redirect(routePrefix);
        });
      }

      fastify.log.info(`OpenAPI documentation is available at ${routePrefix}`);
    },
    {
      name: "openapi",
    },
  );
};
