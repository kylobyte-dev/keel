---
title: "Development"
description: "Working on keel itself: the repository layout, the conventions, what CI checks, and how to work on the docs."
---

```bash
pnpm install       # `prepare` compiles the package
pnpm check-types   # tsc over sources and tests
pnpm test          # vitest
pnpm format        # prettier --write .
pnpm pack          # what would actually ship
```

`pnpm install` runs `prepare`, which compiles into `dist/`. A broken build therefore
fails at install time rather than at publish time, which is also why CI's first step is
enough to catch it.

## The repository

```
src/
├── index.ts        # re-exports /http and /runtime
├── http/           # the type provider, controllers, routers, plugins, response types
├── runtime/        # Pino↔Effect logging, memoizedConfig, the two small helpers
├── openapi/        # swagger + Scalar wiring
├── sse/            # the SSE handler factory
└── sql/            # Drizzle over Effect's SQL layer: repositories, filters, pagination
docs/               # the Starlight site — a separate project, its own lockfile
tsconfig.main.json  # the shared config, also shipped to consumers
```

Every directory under `src/` with an `index.ts` is a published entry point, declared in
`package.json`'s `exports`. [Architecture](/keel/architecture/#the-module-map) explains
what belongs in each and why they are separate.

## Conventions

**Entry points are the API.** A symbol not re-exported from its directory's `index.ts`
is internal, whatever its visibility in TypeScript. Adding to the public surface means
touching three places: the implementation, the `index.ts`, and — if it is a new entry
point — the `exports` map plus the tables in `README.md` and
[Install](/keel/install/).

**Peer dependencies stay peers.** Nothing that could end up duplicated in a consumer's
process may become a dependency: `effect` and `fastify` most of all, since two copies of
either break service key identity and Fastify's plugin symbols respectively. The
`/sql` peers are pinned to exact versions rather than ranges, and bumping them is a
release. The reasoning for both is on the
[Design decisions](/keel/design-decisions/#packaging) page.

**Imports carry the `.ts` extension.** `rewriteRelativeImportExtensions` in
`tsconfig.main.json` rewrites them on the way out, and it is what lets consumers run the
shipped `src/` directly under Node's type stripping.

**No non-erasable syntax.** `erasableSyntaxOnly` is on, so enums, namespaces and
parameter properties will not compile — deliberately, so nothing keel ships needs a
transform to run.

**Comments explain the reason, not the mechanism.** The ones already in the source are
the model: `paginate.ts` documenting why the subquery is taken before `limit`,
`typeProvider.ts` documenting why local `$defs` are inlined. If a line only makes sense
with context that is not in the diff, that context belongs next to it.

## Tests

Vitest, with test files colocated next to what they test (`src/**/*.test.ts`) and
excluded from the build.

Three kinds live in the suite, and it is worth knowing which one a change needs:

- **Unit tests** over pure helpers — `parsing.test.ts`, `operators.test.ts`,
  `filter.test.ts`.
- **Integration tests** through a real Fastify instance and `inject` —
  `keel.test.ts` builds a runtime, defines routes, and asserts on statuses, bodies and
  what reached the logger. Anything touching the request path belongs here, because the
  compilers and the error handler only exist at that level.
- **Type-level tests** with `expectTypeOf`, and files whose job is to fail compilation
  if an inference regresses — `sql/integration.types.test.ts` type-checks the SQL
  helpers against real Drizzle types without connecting to anything.

That last category matters more than usual here: most of keel's guarantees are types, so
a change to `routeTypes.ts` or `controller.ts` that keeps every runtime test green can
still remove a check entirely. `pnpm check-types` runs `tsc` over sources _and_ tests
for that reason.

## CI

Three workflows, all on pull requests:

- **CI** — `check-types`, `test` and `pack --dry-run` on Node 22 and 24, the two
  versions the consuming services run on, plus a `prettier --check` job.
- **Docs** — builds the Starlight site, which also validates every internal link, and
  deploys to GitHub Pages on `main`.
- **Release** — manual only, and it owns the whole sequence: bump, publish through npm's
  trusted publisher, then push the commit and tag.

`pnpm pack --dry-run` is not ceremony: it catches a missing `dist/` or a dropped
`tsconfig.main.json` before the release workflow does.

## The documentation site

`docs/` is a separate project with its own lockfile, so Astro's dependency tree never
enters the published package's.

```bash
pnpm docs:install  # docs/ has its own lockfile
pnpm docs:dev      # Starlight dev server
pnpm docs:build    # static build, and internal link validation
```

Pages are Markdown under `docs/src/content/docs/`, with `title` and `description` in the
frontmatter. The sidebar is explicit in `docs/astro.config.mjs` — a new page needs an
entry there, or it exists at its URL and appears in no navigation.

Internal links are absolute and include the base path (`/keel/controllers/`), because
the site is served from a project page. `starlight-links-validator` fails the build on a
link — or an anchor — that does not land, so a renamed heading breaks CI rather than
shipping a dead cross-reference. That check is the reason cross-linking between pages is
safe to do liberally.

`context7.json` at the repository root points Context7 at `docs/src/content/docs` and
carries a short list of rules about how keel is meant to be used. New material is picked
up automatically; the rules list is worth revisiting when a convention changes.

## Making a change

1. Write it, with the tests — a type-level one if the change is type-level.
2. `pnpm check-types && pnpm test && pnpm format`.
3. Update the docs in the same commit. A behaviour change that is not in `docs/` is not
   finished: the site is the manual, and the README only links to it.
4. If the public surface changed, check `index.ts`, `package.json` `exports`, and the
   entry-point tables in both `README.md` and [Install](/keel/install/).
