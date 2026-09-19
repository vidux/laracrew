<div align="center">

# laracrew

**Boot every long-running process of every Laravel project you're working on — with one command.**

`php artisan serve` · `queue:work` · `horizon` · Redis stream listeners · `schedule:work` · `npm run dev`
— across two, three or ten projects, in the right order, supervised, in one terminal.

[github.com/vidux/laracrew](https://github.com/vidux/laracrew)

</div>

---

## The problem

You develop two Laravel apps that talk to each other. Starting work means opening eight to
fourteen terminal tabs and typing, in the right order:

```bash
cd D:/work/api     && php artisan serve
cd D:/work/api     && php artisan queue:work redis --queue=high,default
cd D:/work/api     && php artisan streams:listen orders
cd D:/work/api     && php artisan schedule:work
cd D:/work/api     && npm run dev
cd D:/work/portal  && php artisan serve --port=8001
cd D:/work/portal  && php artisan queue:work redis --queue=default
cd D:/work/portal  && php artisan streams:listen inventory
```

Every one is long-running. When a worker dies you don't notice. When you edit a job class you
have to remember PHP workers cache code. When you close the terminal, half of them survive as
orphans still holding port 8000.

## The fix

```bash
laracrew up dual
```

```
  laracrew · dual                                     up 00:15:27  · 6/7 running  all healthy
  ────────────────────────────────────────────────────────────────────────────────────────────
  up/down select   enter inspect log   0-9 jump   r restart   s stop/start   a all logs
  ? help   q quit
  STACK DETAILS (process tree)

  DEPENDENT SERVICES (checked, not managed)
      ● redis            ready      tcp 127.0.0.1:6379

  processes (7 managed)
  │
  ├─ ▸ [0] ● api:serve       running    15m 04s
  ├─   [1] ● api:queue       running    15m 04s   ⟳2
  ├─   [2] ● api:streams     running    15m 04s
  ├─   [3] ● api:schedule    running    15m 04s
  ├─   [4] ● portal:serve    running    14m 58s
  ├─   [5] ◼ portal:queue    stopped
  └─   [6] ● portal:streams  running    14m 58s
  │
  └─ Ready in 1.9s. Awaiting keyboard input…
```

Services marked `external: true` — Redis, Postgres, anything laracrew checks but never runs —
sit above the tree under their own heading, with the probe they are checked with. They carry no
index, because there is nothing to start or stop; if one is unreachable the header says
`1 dependency down` before anything else.

**The default screen never streams logs.** Nine services interleaving output is unreadable — you
can't see the shape of the fleet and you can't follow any one process. So you get the tree, and
you open logs deliberately: press `2`, read `api:queue`, press `esc`.

```
  api:queue   running  · pid 14184  · up 15m 04s
  $ php artisan queue:work redis --queue=high,default
  D:/work/api
  ────────────────────────────────────────────────────────────────────────────────────────────
  08:51:30 | Processing: App\Jobs\SyncOrder
  08:51:30 | Processed:  App\Jobs\SyncOrder (412ms)
  08:51:31 | Processing: App\Jobs\NotifyPortal
```

One Ctrl-C stops all of it, in reverse dependency order, gracefully — workers finish the job
they're holding before they exit, and nothing is left behind.

---

## Why not `concurrently`, `pm2` or `docker compose`

Those run processes. laracrew knows what the processes *are*.

- **It stops workers the Laravel way.** `php artisan queue:restart` first, wait for the current
  job to finish, *then* terminate. Never a job killed mid-flight.
- **It kills whole process trees.** `php artisan serve` spawns a child PHP server; `npm run dev`
  spawns Vite. Killing the parent orphans them and the port stays bound. Every stop is a tree kill
  (`taskkill /T /F` on Windows, process-group kill on POSIX).
- **It gates on readiness, not on sleep.** `portal:serve` doesn't start until Redis answers *and*
  `api:serve` returns HTTP 200.
- **It knows your `.env`.** `laracrew doctor` catches two projects quietly sharing one Redis
  database *and* a queue name — where each app's workers silently steal the other's jobs. That
  class of bug eats afternoons.

---

## Install

```bash
npm install -g laracrew
laracrew init --examples
```

> Not published to npm yet. Until it is, install from source:
> `git clone https://github.com/vidux/laracrew && cd laracrew && npm install && npm run build && npm link`

Requires **Node 20+**. Works on Windows, macOS and Linux. PHP is only needed for the projects
laracrew runs, not for laracrew itself.

## Quick start

```bash
laracrew init --examples   # creates ~/.laracrew with a demo stack and a two-project template
laracrew up example        # runs the demo — no Laravel project needed, proves it works here
laracrew ls                # what's defined
```

`laracrew init` on its own creates just the config files. Add `--examples` when you want the
runnable demo stack and the ready-made two-project template to start from.

Then point it at real projects. Edit `~/.laracrew/projects.yaml`:

```yaml
projects:
  api:
    path: D:/work/api
    php: php            # or an absolute path to a specific PHP build
    envFile: .env
    color: cyan
  portal:
    path: D:/work/portal
    php: php
    color: magenta
```

`laracrew init` already wrote you a `dual` stack wired for exactly this scenario. Check it, then
boot it:

```bash
laracrew doctor dual
laracrew up dual
```

---

## One command per project set

Typing `laracrew up dual` every morning gets old, and you have more than one project set. Give
each set its own global command:

```bash
laracrew link dual
```

```
created dual -> laracrew up dual

in C:\Users\you\AppData\Roaming\npm

Run it from anywhere:  dual
Flags pass straight through:  dual --only workers
```

From then on, one word boots that whole set — from any directory:

```bash
dual                    # boots all 8 services of the dual stack
dual --only workers     # every `laracrew up` flag still works
```

A stack names its own command in `stack.yaml`:

```yaml
name: dual
command: dual          # what `laracrew link` installs; defaults to the stack name
```

So you end up with one command per set — `dual`, `billing`, `legacy` — each booting its own
fleet of projects.

| | |
|---|---|
| `laracrew link <stack>` | Install the command. Re-run any time to update it. |
| `laracrew link <stack> --as <name>` | Use a different name than the stack declares. |
| `laracrew link --all` | Install for every stack that declares `command:`. |
| `laracrew link <stack> --dir <path>` | Install somewhere other than the default. |
| `laracrew unlink <name>` | Remove it again. |
| `laracrew ls` | Shows which stacks have a command installed. |

**Where they go.** Into the same directory as `laracrew` itself — the npm global bin, which is
already on your PATH. On Windows you get three files (`dual`, `dual.cmd`, `dual.ps1`) so the
command behaves identically in Git Bash, cmd and PowerShell. Override with `--dir` or the
`LARACREW_BIN` environment variable. If laracrew can't find a directory that's on your PATH, it
falls back to `~/.laracrew/bin` and prints the one line you need to add it.

**It won't stomp on anything.** Every generated file carries a `laracrew-generated` marker.
laracrew refuses to overwrite a file it didn't write, refuses to shadow names like `npm` or
`git`, and `unlink` leaves foreign files alone. Pass `--force` if you genuinely mean it.

---

## Logs survive

The live view keeps the last few thousand lines per service in memory — minutes, on a busy
stack. Everything is also written to disk, so the exception you watched scroll past is still
there tomorrow.

```bash
laracrew logs api:queue                  # last 200 lines, after the fact
laracrew logs api:queue -f               # and keep following
laracrew logs --all --since 10m          # every service, merged and time-ordered
laracrew logs --list                     # which services have a log
```

Files land in `~/.laracrew/logs/<stack>/<service>.log`, rotated at 5 MB with one older copy
kept. They are plain text with a sortable local timestamp and no colour codes, so your usual
tools work on them directly:

```
2026-09-19 11:35:25.565 stderr PaymentFailedException: card declined
```

```bash
grep -i exception ~/.laracrew/logs/dual/api-queue.log
```

This is on by default. Turn it off per stack if you would rather not:

```yaml
defaults:
  logs: { toFile: false }
```

| Setting | Default | Meaning |
|---|---|---|
| `logs.toFile` | `true` | Write every line to disk |
| `logs.maxLines` | `5000` | Lines kept in memory for the live view |
| `logs.maxFileBytes` | `5000000` | Rotate a service's log past this size |
| `logs.keepFiles` | `1` | Rotated copies kept beside the current file |

---

## Starting things on demand

Not every command should run all day. A scheduler tick, a one-off sync listener, a queue you
only drain occasionally — define them in the stack, but don't launch them:

```yaml
  - name: api:queue
    project: api
    cmd: ["php", "artisan", "queue:work"]        # starts with the stack

  - name: api:streams
    project: api
    cmd: ["php", "artisan", "redis-stream:run", "orders_sync"]
    autostart: false                              # defined, listed, not launched

  - name: api:schedule
    project: api
    cmd: ["php", "artisan", "schedule:run"]
    autostart: false
    restart: never                                # one tick, not a daemon
```

They appear in the tree as **idle**, waiting for you:

```
  ├─   [1] ● api:serve       running    8s
  ├─   [2] ● api:queue       running    8s
  ├─   [3] ○ api:streams     idle       press s
  ├─   [4] ○ api:schedule    idle       press s
  ├─   [5] ● portal:queue    running    8s
```

Select one and press `s` to start it; `s` again to stop it. The header counts them
(`4/7 running · 2 idle`) so you can see at a glance what is dormant.

One rule the config enforces: a service that starts at launch may not `needs:` a service you
have to start by hand — that would leave it waiting on a gate nobody opened. laracrew refuses
the stack with a message naming both services rather than hanging.

---

## Driving it

| Key | Does |
|---|---|
| `up` `down` / `j` `k` | Move the selection |
| `0`-`9` | Jump to that process **and** open its log |
| `enter` | Inspect the selected process |
| `esc` | Back to the tree |
| `a` | Merged log across every service - the firehose, on demand |
| `r` | Restart the selected process (graceful: `queue:restart` first) |
| `s` | Stop it, or start it again if stopped |
| `f` / `g` / `G` | Follow-pause tailing; jump to top or bottom |
| `?` | Help |
| `q` / `ctrl-c` | Quit - stops every process first |

The view is plain ANSI on `node:readline`, no Ink and no React. It repaints on a 250 ms poll
rather than per log line, so a worker emitting 500 lines a second costs nothing to display.
`LARACREW_ASCII=1` swaps in an ASCII glyph set for terminals that mangle box drawing.

When stdout is not a TTY you get prefixed interleaved logs automatically, so
`laracrew up dual | tee dev.log` does the right thing with no flag.

---

## Examples

Five working stacks in [`examples/`](examples/) — only one of them is Laravel. Each is
self-contained, so copy one, fix the paths, and run it:

```bash
cp -r examples/node-api-and-web ~/.laracrew/stacks/
laracrew up node-api-and-web
```

| Example | What it is |
|---|---|
| [laravel-dual](examples/laravel-dual/stack.yaml) | Two interconnected Laravel apps: queues, stream listeners, schedulers, Vite |
| [node-api-and-web](examples/node-api-and-web/stack.yaml) | TypeScript API, Vite frontend, BullMQ worker, Postgres and Redis |
| [django-celery](examples/django-celery/stack.yaml) | Django, a Celery worker, beat, and optional extras |
| [polyglot-microservices](examples/polyglot-microservices/stack.yaml) | Go, Rust, Node and Python behind a gateway, with Docker Compose for infrastructure |
| [frontend-monorepo](examples/frontend-monorepo/stack.yaml) | tsc, Tailwind, Storybook and docs watchers in one repo — no servers at all |

[`examples/README.md`](examples/README.md) explains what each one is there to teach, plus the
patterns worth stealing: gating on reality instead of sleeping, keeping occasional commands in
the stack but idle, and letting laracrew own `docker compose` too.

---

## Concepts

| Concept | What it is |
|---|---|
| **Project** | One Laravel app root: path, PHP binary, `.env`. Defined once in `projects.yaml`, referenced by key. |
| **Service** | One long-running process: command, cwd, dependencies, readiness gate, restart policy. |
| **Stack** | A named set of services spanning one or more projects — the thing you `laracrew up`, and what a linked command boots. |
| **Group** | A tag on a service (`workers`, `http`, `assets`) for `--only` / `--except`. |
| **Profile** | A named filter stored in the stack (`light` = everything except assets). |
| **Task** | A one-shot ordered sequence across projects (`reset` = migrate:fresh + seed on both). |

Everything lives under `~/.laracrew/`, never inside your Laravel projects. laracrew only ever
reads your project files.

```
~/.laracrew/
├── config.yaml              # theme, default stack, poll intervals
├── projects.yaml            # your projects, referenced by key
├── stacks/
│   ├── dual/
│   │   ├── stack.yaml       # the definition
│   │   └── services/        # optional: split a big stack into fragments
│   └── example/stack.yaml
├── tasks/reset.yaml
└── fragments/
```

One folder per stack, so a stack can carry its own fragments and notes. The whole directory is
safe to keep in git and sync between machines.

---

## Configuring a stack

A complete two-project setup:

```yaml
name: dual
description: API + Portal with queues, streams and schedulers
command: dual                 # `laracrew link dual` installs this as a global command

use: [api, portal]            # from ~/.laracrew/projects.yaml

defaults:                     # inherited by every service, overridable per service
  restart: on-failure
  backoff: { initialMs: 1000, maxMs: 30000, factor: 2, maxRestarts: 10 }
  stop: { graceMs: 10000 }

services:
  - name: redis
    external: true            # health-checked, never started by laracrew
    ready: { tcp: "127.0.0.1:6379" }

  - name: api:serve
    project: api
    cmd: php artisan serve --port=${port:8000}
    groups: [http]
    needs: [redis]
    ready: { http: "http://127.0.0.1:8000/up", timeoutMs: 20000 }
    url: http://127.0.0.1:8000

  - name: api:queue
    project: api
    cmd: php artisan queue:work redis --queue=high,default --tries=3
    groups: [workers]
    needs: [redis]
    stop: { artisan: "queue:restart", graceMs: 15000 }   # finish the current job first
    metrics: { queues: [high, default] }

  - name: portal:serve
    project: portal
    cmd: php artisan serve --port=${port:8001}
    groups: [http]
    needs: [redis, api:serve]       # waits for the API to actually answer
    ready: { http: "http://127.0.0.1:8001/up" }

profiles:
  light: { except: [assets] }
  workers-only: { only: [workers] }
```

### Service fields

| Field | Notes |
|---|---|
| `name` | Required. Convention is `project:role`; used as the log prefix. |
| `project` | Supplies `cwd`, the PHP binary, the `.env` and the colour. |
| `cmd` | A shell string, or an argv array (`["php", "artisan", "queue:work"]`). The array form skips shell parsing — prefer it when arguments contain spaces. |
| `cwd` | Defaults to the project path. |
| `env` | Extra environment variables, merged over the inherited environment. |
| `groups` | Tags for `--only` / `--except`. |
| `needs` | Dependency edges. Cycles are a config error that names the members. |
| `ready` | `tcp`, `http`, `logMatch` (regex over output) or `delayMs`, plus `timeoutMs` (default 30000) and `intervalMs` (default 250). Without it, "spawned" means ready. |
| `restart` | `never` · `on-failure` (default) · `always`. |
| `backoff` | `initialMs`, `maxMs`, `factor`, `maxRestarts`, `resetAfterMs`. Delay is `min(initialMs × factor^n, maxMs)`; the counter resets after the service stays up for `resetAfterMs`. |
| `stop` | `artisan` (a graceful command such as `queue:restart` or `horizon:terminate`), `signal`, `graceMs`. |
| `url` | Recorded for the service; `laracrew open` is not built yet. |
| `external` | Health-checked but never spawned — Redis, MySQL, a Docker service. |
| `autostart` | `false` defines the service without launching it. It shows as **idle** in the tree; select it and press `s` when you need it. |
| `enabled` | Quick off switch without deleting the block. |
| `color` | Log-prefix colour; defaults to the project's. |

### Interpolation

| Token | Expands to |
|---|---|
| `${env:FOO}` / `${env:FOO:fallback}` | laracrew's own environment |
| `${project.path}` | the service's project root |
| `${project.env:REDIS_PORT}` | a value from that project's `.env` |
| `${stack.dir}` | the stack's own folder |
| `${port:8000}` | a port, recorded so `doctor` can check it for clashes |

---

## Commands

```bash
laracrew init [--examples]         # create ~/.laracrew; --examples adds a demo stack + template
laracrew ls [--json]               # list stacks, projects and tasks
laracrew doctor [stack]            # check a stack before booting it
laracrew up [stack] [options]      # boot the fleet and supervise it
laracrew logs [service] [--stack name] [-n 200] [-f] [--since 10m] [--all] [--list]
laracrew link [stack] [--as name] [--all] [--dir path] [--force]
laracrew unlink <name>             # remove a command laracrew installed
laracrew --version
```

`laracrew up` options:

| Option | Effect |
|---|---|
| `--only <selector>` | Only these services or groups. Repeatable, comma-separated. |
| `--except <selector>` | Skip these services or groups. |
| `--profile <name>` | Apply a profile defined in the stack. |
| `--json` | Newline-delimited JSON events instead of logs — one object per line. |
| `--plain` | Prefixed interleaved logs instead of the full-screen view. Automatic when stdout is not a TTY. |

Omit the stack name and laracrew uses `defaultStack` from `config.yaml`, or the only stack that
exists, or tells you which ones it found.

```bash
laracrew up dual --only workers            # just the queue workers and listeners
laracrew up dual --except assets           # skip Vite
laracrew up dual --profile light
laracrew up dual --json | jq 'select(.type=="service:exit")'
```

### What `doctor` checks

```
✔ stack "dual" is valid — 8 services
✔ php: PHP 8.3.11 (cli)
✖ api and portal share Redis 127.0.0.1:6379/0# AND queue(s): default
  each project's workers will steal the other's jobs — set a different REDIS_DB or REDIS_PREFIX
✖ project "api" runs a queue worker but QUEUE_CONNECTION=sync
  jobs run inline on dispatch, so the worker will sit idle forever — set it to redis or database
✖ port 8000 is already in use
▲ redis not reachable at 127.0.0.1:6380
```

Exit code is 1 when anything is at `✖`, so it drops straight into a pre-flight script.

---

## How shutdown works

This is where most process managers leave a mess, so it's worth stating exactly. Each step runs
only if the previous one timed out:

1. **Laravel graceful** — if the service declares `stop.artisan`, run it (`php artisan
   queue:restart`, `horizon:terminate`) and wait up to `graceMs` for the worker to exit on its own,
   having finished the job it was holding.
2. **Signal** — `SIGTERM` to the process group. Skipped on Windows, which has no equivalent.
3. **Tree kill** — `taskkill /pid <pid> /T /F` on Windows, `kill(-pid)` on POSIX. This is what
   catches the child PHP server behind `artisan serve` and the Vite process behind `npm run dev`.
4. **Verify** — re-check the pid and warn loudly if anything survived.

Stacks come down in reverse dependency order, parallel within a level. A second Ctrl-C escalates
immediately and says so.

If a readiness gate fails during boot, laracrew rolls back everything it already started before
exiting non-zero — you never get a half-booted stack you have to clean up by hand.

---

## Environment

| Variable | Effect |
|---|---|
| `LARACREW_HOME` | Override `~/.laracrew`. |
| `LARACREW_BIN` | Where `laracrew link` installs global commands. |
| `LARACREW_ASCII` | `1` swaps box-drawing glyphs for ASCII. |
| `NO_COLOR` | Disable colour, even on a TTY. |
| `FORCE_COLOR` | Enable colour when piping. |

Each child process is given `LARACREW=1`, `LARACREW_SERVICE=<name>` and, when it belongs to a
project, `LARACREW_PROJECT=<key>`.

---

## Status

**v0.1.0 — supervisor and full-screen view are built and tested.**

Working now: config pipeline, dependency-ordered boot with readiness gates, restart policies with
exponential backoff, the Laravel-aware stop ladder, the full-screen process tree with per-process
log inspection, logs persisted to disk with `laracrew logs` to read them back, plain and JSON
renderers, per-stack global commands (`link` / `unlink`), `doctor`, `init`, `ls`.

Accepted by the config schema but **not yet acted on** — they validate, so your stack files are
future-proof, but nothing happens yet:

| Key | Lands in |
|---|---|
| `watch` | M4 — file-change restarts via `queue:restart` |
| `metrics` | M3 — live queue depth and stream lag (today `doctor` reads it for collision checks) |
| `hooks.preUp` / `hooks.postDown` | not scheduled |

### Roadmap

| | |
|---|---|
| **M3** | `laracrew scan` project discovery, Redis queue depth and stream consumer lag on screen, failed-job badge |
| **M4** | File watching with graceful `queue:restart`, and `laracrew run <task>` |
| **M5** | Background daemon: `up --detach`, `attach`, `status`, `logs -f` |
| **M6** | Themes, JSON Schema for editor autocomplete, shell completions |

The full plan lives in [.claude/PLAN.md](.claude/PLAN.md), with the design in
[ARCHITECTURE.md](.claude/ARCHITECTURE.md), [CONFIG-SPEC.md](.claude/CONFIG-SPEC.md) and
[TUI-UX.md](.claude/TUI-UX.md).

---

## Development

```bash
npm install
npm run dev -- up example     # tsx, no build step
npm run build                 # tsup -> dist/index.js
npm test                      # vitest, 226 tests
npm run typecheck
npm link                      # put `laracrew` on PATH while hacking on it
```

Runtime dependencies, in total: `commander`, `yaml`, `zod`. Process spawning, tree-killing and
colour are hand-rolled — see [ARCHITECTURE.md §9](.claude/ARCHITECTURE.md) for why `execa`,
`tree-kill` and `picocolors` were dropped. Startup time is a feature for a tool you run twenty
times a day.

The test suite spawns real child processes, binds real ports and asserts that no pid survives a
shutdown — including a deliberately spawned grandchild and a process that ignores `SIGTERM`. Every
test runs against a throwaway `LARACREW_HOME`.

Architectural rule worth knowing before you contribute: **nothing in `src/core/` may import from
`src/cli/`**. Core emits typed events; the plain renderer, the JSON renderer and the coming TUI are
all just subscribers. That's what keeps `--plain`, `--detach` and the tests honest.

## License

MIT
