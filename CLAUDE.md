# CLAUDE.md

Guidance for Claude Code when working in this repository.

## English everywhere

**Everything written into this repository is in English.** No exceptions, whatever
language the conversation is happening in — the discussion can be in any language, the
artefacts cannot. That covers:

- commit messages, branch names, pull request titles and descriptions;
- code comments and JSDoc;
- identifiers — variables, functions, types, files, directories;
- log messages, error messages and their `message` fields, tagged error names;
- tests and their descriptions (`describe`/`it` strings);
- documentation under `docs/`, the `README.md`, and the frontmatter in both;
- issue templates, workflow names and step names under `.github/`.

Some of the existing history and a comment here and there are in Italian; that is
legacy, not a precedent. Translate what you touch, and never add more.

## Commits

Conventional Commits, in English like everything else.

```
<type>(<optional scope>): <short imperative summary>

<optional body: why the change, not what the diff already shows>
```

- Types in use here: `feat`, `fix`, `docs`, `chore`, `ci`, `refactor`, `test`, `perf`.
- Scopes match the source directories when one applies: `http`, `runtime`, `openapi`,
  `sse`, `sql`, `docs`.
- Subject in the imperative mood, lowercase, no trailing period, ideally under 72
  characters.
- Breaking changes take a `!` after the type/scope (`feat(sql)!: ...`) and a
  `BREAKING CHANGE:` footer explaining the migration.

Examples:

```
feat(sql): add an optional id helper for snowflake ids
fix(http): keep local $defs inlined so the type provider resolves them
docs: document the SSE handler factory
```

## Commands

```bash
pnpm install       # `prepare` compiles the package into dist/
pnpm check-types   # tsc over sources and tests
pnpm test          # vitest
pnpm format        # prettier --write .
pnpm pack --dry-run

pnpm docs:install  # docs/ is a separate project with its own lockfile
pnpm docs:dev
pnpm docs:build    # static build, also validates every internal link
```

Run `pnpm check-types && pnpm test && pnpm format` before committing.

## Conventions

The full set lives in [docs/src/content/docs/contributing.md](docs/src/content/docs/contributing.md).
The ones that bite most often:

- **Entry points are the API.** A symbol not re-exported from its directory's `index.ts`
  is internal. New public surface means touching the implementation, the `index.ts`, and
  — for a new entry point — `package.json`'s `exports` plus the tables in `README.md`
  and `docs/src/content/docs/install.md`.
- **Peer dependencies stay peers.** Nothing that could be duplicated in a consumer's
  process may become a dependency — `effect` and `fastify` above all.
- **Relative imports carry the `.ts` extension**; `rewriteRelativeImportExtensions`
  rewrites them on the way out.
- **No non-erasable syntax.** `erasableSyntaxOnly` is on: no enums, namespaces, or
  parameter properties.
- **Comments explain the reason, not the mechanism.**
- **Docs ship with the change.** A behaviour change that is not reflected under `docs/`
  is not finished.
