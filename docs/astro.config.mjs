// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";

// The site is served from a project page, so every URL is prefixed with the
// repository name. Keep `base` in sync with the repository if it is ever renamed.
// https://astro.build/config
export default defineConfig({
  site: "https://kylobyte-dev.github.io",
  base: "/keel",
  integrations: [
    starlight({
      title: "keel",
      description:
        "Opinionated Fastify 5 + Effect backend framework: Effect Schema as type provider, controllers as Effect services, tagged errors mapped to HTTP, Pino↔Effect logging, SSE.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/kylobyte-dev/keel",
        },
        {
          icon: "npm",
          label: "npm",
          href: "https://www.npmjs.com/package/@kylobyte/keel",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/kylobyte-dev/keel/edit/main/docs/",
      },
      // The pages were carved out of one long README, so a cross-reference that
      // rots has to fail the build rather than ship as a 404.
      plugins: [starlightLinksValidator()],
      lastUpdated: true,
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Install", slug: "install" },
            { label: "The shape of an app", slug: "app-shape" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Bootstrap", slug: "bootstrap" },
            { label: "Controllers", slug: "controllers" },
            { label: "Routes", slug: "routes" },
            { label: "Errors", slug: "errors" },
            { label: "Schemas at the boundary", slug: "schemas" },
            { label: "Runtime", slug: "runtime" },
            { label: "OpenAPI", slug: "openapi" },
            { label: "SSE", slug: "sse" },
          ],
        },
        {
          label: "SQL",
          items: [
            { label: "Overview", slug: "sql" },
            { label: "Schema and ids", slug: "sql/schema-and-ids" },
            { label: "Repositories", slug: "sql/repositories" },
            { label: "Filters, sorting, pagination", slug: "sql/queries" },
            { label: "Migrations", slug: "sql/migrations" },
          ],
        },
        {
          label: "Project",
          items: [
            { label: "Testing", slug: "testing" },
            { label: "Development", slug: "contributing" },
          ],
        },
      ],
    }),
  ],
});
