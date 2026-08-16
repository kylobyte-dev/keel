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

**Building something?** [Your first app](/keel/tutorials/first-app/) goes from an empty
directory to a running, documented, tested service one file at a time. Then
[Adding a feature](/keel/tutorials/adding-a-feature/) for the loop you will repeat, and
[Adding authentication](/keel/tutorials/authentication/) when the routes stop being
public.

**Working out whether it fits?** [The shape of an app](/keel/app-shape/) is the
five-minute version; [Architecture](/keel/architecture/) explains what each part does
and how a request actually flows through it; [Design decisions](/keel/design-decisions/)
covers why it was built this way.

**Looking something up?**

- **[Install](/keel/install/)** — entry points and the peer dependencies, and why they are peers.
- **[Bootstrap](/keel/bootstrap/)** — building the runtime and handing it to keel.
- **[Controllers](/keel/controllers/)** and **[Routes](/keel/routes/)** — the day-to-day surface.
- **[SQL](/keel/sql/)** — the optional Drizzle + `@effect/sql` entry point.
- **[Troubleshooting](/keel/troubleshooting/)** — what a compile error from all this means.
