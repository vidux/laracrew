# Examples

Five working stacks. Only one of them is Laravel — laracrew supervises processes, and it does
not care what language wrote them.

Each example is self-contained: projects are declared inline, so there is nothing to wire up in
`projects.yaml` first. Copy one, change the paths at the top, and run it.

```bash
cp -r examples/node-api-and-web ~/.laracrew/stacks/
$EDITOR ~/.laracrew/stacks/node-api-and-web/stack.yaml   # fix the paths
laracrew doctor node-api-and-web
laracrew up node-api-and-web
```

Each stack declares a `command:`, so `laracrew link <name>` turns it into a single global word
you can type from anywhere.

| Example | Stack | What it is |
|---|---|---|
| [laravel-dual](laravel-dual/stack.yaml) | `dual` | Two interconnected Laravel apps: queues, Redis stream listeners, schedulers, Vite |
| [node-api-and-web](node-api-and-web/stack.yaml) | `web` | TypeScript API, Vite frontend, BullMQ worker, Postgres and Redis |
| [django-celery](django-celery/stack.yaml) | `django` | Django, a Celery worker, beat, and the optional extras |
| [polyglot-microservices](polyglot-microservices/stack.yaml) | `micro` | Go, Rust, Node and Python behind a gateway, with Docker Compose for infrastructure |
| [frontend-monorepo](frontend-monorepo/stack.yaml) | `fe` | The smallest useful stack: tsc, Tailwind, Storybook and docs watchers in one repo |

## What each one is there to teach

**laravel-dual** — the case laracrew was built for. Graceful worker shutdown through
`php artisan queue:restart`, so a job is never killed mid-flight; the portal waiting on a real
HTTP 200 from the API rather than a sleep; profiles to skip Vite when you are only touching the
backend.

**node-api-and-web** — no PHP anywhere. A one-shot `types:build` that everything else depends on,
readiness by log output for tools that announce themselves (`Local: http://…`), per-service
environment variables, and a secret read from your own shell with `${env:VAR:fallback}` instead
of being committed.

**django-celery** — migrations that must finish before the web server starts, `PYTHONUNBUFFERED`
so the log pane is not empty, a `SIGTERM` graceful stop for Celery instead of an artisan command,
and a second worker plus Flower left dormant behind `autostart: false`.

**polyglot-microservices** — the ordering problem at full size. `docker compose up` supervised as
an ordinary process so it stops with everything else; a gateway that starts only once all three
services answer `/health`; a generous gate on the Rust service because a cold `cargo build` is
slow, rather than a boot that fails at 30 seconds.

**frontend-monorepo** — proof that a "stack" needs neither multiple apps nor a server. Watchers
in one repository, ordered so types build before Storybook consumes them, with `vitest --watch`
and `lint:fix` sitting idle until you press `s`.

## Patterns worth stealing

**Gate on reality, not on time.** `ready: { http: … }` or `{ tcp: … }` beats a sleep. When a
build is genuinely slow, raise `timeoutMs` rather than removing the gate.

```yaml
ready: { http: "http://127.0.0.1:8002/health", timeoutMs: 300000, intervalMs: 2000 }
```

**Keep the occasional things in the stack, just not running.** A backfill command, a database
UI, a test watcher — define them with `autostart: false` so they are documented and one keypress
away, instead of living in your shell history.

**Let laracrew own Docker Compose too.** It is a long-running process like any other. Supervised
here, it stops when the rest of the stack stops.

```yaml
- name: infra
  cmd: ["docker", "compose", "up"]
  ready: { tcp: "127.0.0.1:5432", timeoutMs: 120000, intervalMs: 1000 }
  stop: { graceMs: 30000 }
```

**Use the argv form when arguments get interesting.** `cmd: ["npm", "run", "dev"]` cannot
mis-split on a path containing spaces the way a shell string can.

**A gate with nothing to start is fine.** An `external: true` service is just a health check, so
it can stand in as a named wait step — see `kafka-wait` in the microservices example. `laracrew
doctor` probes those gates before boot, so declaring your Postgres and Redis this way is also how
you get them checked.

**The Laravel checks only apply to Laravel.** `doctor` works out which projects actually run PHP
and which actually talk to Redis, from the commands they declare and the `.env` they read. A
Django or Node stack gets the port and dependency checks and none of the PHP ones.
