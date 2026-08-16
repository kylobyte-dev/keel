---
title: keel
description: "Opinionated Fastify 5 + Effect backend framework: Effect Schema as type provider, controllers as Effect services, tagged errors mapped to HTTP, Pino↔Effect logging, SSE."
template: splash
hero:
  tagline: Opinionated Fastify 5 + Effect backend framework. Glue only — no business logic, no application runtime.
  actions:
    - text: Install
      link: /keel/install/
      icon: right-arrow
    - text: View on GitHub
      link: https://github.com/kylobyte-dev/keel
      icon: external
      variant: minimal
---

Keel wires Fastify and Effect together and stops there: Effect Schema as the type
provider, controllers as Effect services, tagged errors mapped to HTTP responses,
Pino↔Effect logging, SSE. Your app builds its own `ManagedRuntime` and hands it
over.

```bash
pnpm add @kylobyte/keel
```

## Where to start

- **[Install](/keel/install/)** — entry points and the peer dependencies, and why they are peers.
- **[The shape of an app](/keel/app-shape/)** — how the pieces fit before writing any code.
- **[Bootstrap](/keel/bootstrap/)** — building the runtime and handing it to keel.
- **[Controllers](/keel/controllers/)** and **[Routes](/keel/routes/)** — the day-to-day surface.
- **[SQL](/keel/sql/)** — the optional Drizzle + `@effect/sql` entry point.
