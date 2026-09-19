# Config spec — `~/.laracrew`

Everything the user owns lives here. `laracrew` never writes inside a Laravel project.

## 1. Home layout

```
~/.laracrew/
├── config.yaml              # global prefs: theme, editor, poll intervals, default stack
├── projects.yaml            # reusable project definitions (path, php binary, env file)
├── stacks/
│   ├── dual/                # one folder per stack  <- "subfolder per custom command"
│   │   ├── stack.yaml       # the definition
│   │   ├── services/        # optional: split big stacks into fragments
│   │   │   ├── api.yaml
│   │   │   └── portal.yaml
│   │   ├── hooks/           # optional: preUp.sh / postDown.ps1 etc.
│   │   └── README.md        # optional: your own notes, shown by `laracrew ls --long`
│   └── api-only/
│       └── stack.yaml
├── tasks/
│   ├── reset.yaml           # one-shot sequences
│   └── fresh-seed.yaml
├── fragments/               # shared snippets any stack can `extends:`
│   └── laravel-worker.yaml
└── logs/
    └── dual/2026-09-18/api.queue.log
```

`laracrew init` creates this tree with a commented example. `laracrew init --git` also runs `git init`
so the whole config is versionable and syncable between machines.

## 2. `projects.yaml`

```yaml
projects:
  api:
    path: D:/work/api
    php: php                     # or an absolute path to a specific PHP build
    envFile: .env                # parsed for QUEUE_CONNECTION, REDIS_*, APP_URL, DB_*
    color: cyan                  # used for log prefixes and the TUI accent
  portal:
    path: D:/work/portal
    php: php
    envFile: .env
    color: magenta
```

Projects may also be declared inline inside a stack; `projects.yaml` just avoids repetition.

## 3. `stack.yaml` — the full worked example

This is the two-interconnected-apps scenario, end to end.

```yaml
name: dual
description: API + Portal with queues, streams and schedulers
command: dual                    # global command installed by `laracrew link` (default: name)

use: [api, portal]               # pull these in from ~/.laracrew/projects.yaml

# Optional defaults applied to every service in this stack
defaults:
  restart: on-failure            # never | on-failure | always
  backoff: { initialMs: 1000, maxMs: 30000, factor: 2, maxRestarts: 10 }
  stop:    { graceMs: 10000 }
  logs:    { maxLines: 5000, toFile: true, maxFileBytes: 5000000, keepFiles: 1 }

services:
  # ---------- infrastructure gate ----------
  - name: redis
    external: true               # laracrew does not start it, only checks it
    ready:  { tcp: "127.0.0.1:6379" }

  # ---------- api ----------
  - name: api:serve
    project: api
    cmd: php artisan serve --port=8000
    groups: [http]
    needs: [redis]
    ready: { http: "http://127.0.0.1:8000/up", timeoutMs: 20000 }
    url: http://127.0.0.1:8000

  - name: api:queue
    project: api
    cmd: php artisan queue:work redis --queue=high,default --tries=3 --timeout=90
    groups: [workers]
    needs: [redis]
    stop:  { artisan: "queue:restart", graceMs: 15000 }   # finish the current job first
    watch:
      paths: [app, config, routes, database]
      strategy: artisan-queue-restart                      # graceful, not a hard kill
      debounceMs: 800
    metrics:
      queues: [high, default]                              # -> LLEN queues:high / queues:default

  - name: api:streams
    project: api
    cmd: php artisan streams:listen orders
    groups: [workers, streams]
    needs: [redis]
    metrics:
      streams:
        - { key: "orders", group: "api-consumers" }        # -> XINFO GROUPS orders

  - name: api:schedule
    project: api
    cmd: php artisan schedule:work
    groups: [workers]
    needs: [redis]

  - name: api:vite
    project: api
    cmd: npm run dev
    groups: [assets]
    ready: { logMatch: "ready in|Local:" }

  # ---------- portal (starts only once the api is answering) ----------
  - name: portal:serve
    project: portal
    cmd: php artisan serve --port=8001
    groups: [http]
    needs: [redis, api:serve]
    ready: { http: "http://127.0.0.1:8001/up" }
    url: http://127.0.0.1:8001

  - name: portal:queue
    project: portal
    cmd: php artisan queue:work redis --queue=default --tries=3
    groups: [workers]
    needs: [redis, api:serve]
    stop:  { artisan: "queue:restart" }
    watch: { paths: [app, config], strategy: artisan-queue-restart }
    metrics: { queues: [default] }

  - name: portal:streams
    project: portal
    cmd: php artisan streams:listen inventory
    groups: [workers, streams]
    needs: [redis]
    metrics:
      streams:
        - { key: "inventory", group: "portal-consumers" }

profiles:
  light:                          # laracrew up dual --profile light
    except: [assets]
  workers-only:
    only: [workers]

hooks:
  preUp:   "hooks/preUp.sh"       # relative to the stack folder; optional
  postDown: null
```

### Service fields

| Field | Type | Notes |
|---|---|---|
| `name` | string, required | Convention `project:role`; used as the log prefix and TUI label |
| `project` | project key | Supplies `cwd`, `php`, env file, colour |
| `cmd` | string or array | Array form skips shell parsing — preferred when args contain spaces |
| `cwd` | path | Defaults to the project path |
| `env` | map | Merged over the project's `.env`-derived vars |
| `groups` | string[] | Targets for `--only` / `--except` / `laracrew restart <group>` |
| `needs` | string[] | Dependency edges; cycles are a config error |
| `ready` | object | `tcp` \| `http` \| `logMatch` \| `delayMs`; default: process spawned = ready |
| `restart` | enum | `never` \| `on-failure` \| `always` |
| `backoff` | object | `initialMs`, `maxMs`, `factor`, `maxRestarts` |
| `stop` | object | `artisan` (graceful command), `signal`, `graceMs` |
| `watch` | object | `paths`, `ignore`, `strategy`, `debounceMs` |
| `metrics` | object | `queues: string[]`, `streams: [{key, group}]` |
| `url` | string | Enables `laracrew open <service>` and a clickable footer hint |
| `external` | bool | Health-checked but never spawned (Redis, MySQL, Docker services) |
| `autostart` | bool | Default `true`. `false` = defined and listed but **not launched** by `up`; select it and press `s` to start it on demand. An auto-started service may not `needs` a manual one. |
| `enabled` | bool | Quick off switch without deleting the block |

### Stack-level fields

| Field | Notes |
|---|---|
| `name` | Must match the folder name under `stacks/`. |
| `description` | Shown by `laracrew ls`. |
| `command` | The global command `laracrew link` installs. Defaults to `name`; required for `laracrew link --all` to pick the stack up. |
| `use` | Project keys from `projects.yaml`. |
| `projects` | Inline project definitions; override shared ones with the same key. |
| `defaults` | Applied to every service, overridable per service. |
| `profiles` | Named `only` / `except` filters. |
| `hooks` | `preUp` / `postDown`. Parsed, not yet executed. |

## 4. Tasks — `~/.laracrew/tasks/reset.yaml`

```yaml
name: reset
description: Wipe and reseed both databases in the right order
pauseServices: [workers]          # stop these first, restart them after the task
steps:
  - { project: api,    cmd: php artisan migrate:fresh --seed }
  - { project: portal, cmd: php artisan migrate:fresh --seed }
  - parallel:
      - { project: api,    cmd: php artisan cache:clear }
      - { project: portal, cmd: php artisan cache:clear }
  - { project: api, cmd: php artisan app:sync-portal, continueOnError: true }
```

`laracrew run reset --dry-run` prints the exact commands and working directories without executing.

### Log settings (`defaults.logs`)

| Field | Default | Notes |
|---|---|---|
| `maxLines` | `5000` | Lines kept in memory per service, for the live view |
| `toFile` | `true` | Write every line to `~/.laracrew/logs/<stack>/<service>.log` |
| `maxFileBytes` | `5000000` | Rotate past this size |
| `keepFiles` | `1` | Rotated copies kept beside the current file |

Service names are sanitised for the filesystem (`api:queue` becomes `api-queue.log`), and two
names that sanitise identically get distinct files. Lines are written with a sortable local
timestamp and no ANSI, so `grep` and `--since` both work.

## 5. Interpolation

| Token | Expands to |
|---|---|
| `${env:FOO}` | The `FOO` env var of the `laracrew` process |
| `${project.path}` | The current service's project path |
| `${project.env:REDIS_PORT}` | A value read from that project's `.env` |
| `${stack.dir}` | The stack's own folder (for hooks and fragments) |
| `${port:8000}` | A port with a collision check at boot; `laracrew doctor` reports clashes |

## 6. Validation and errors

- Schema is a single `zod` object; the YAML is parsed with source positions retained.
- Errors are rendered as `stack.yaml:42:7  service "api:queue"  unknown field "watchs" — did you mean "watch"?`
- Never surface a raw zod issue tree.
- `laracrew doctor` runs schema validation **plus** the semantic checks from PLAN.md §5.7
  (port clashes, shared Redis DB + queue prefix, `QUEUE_CONNECTION=sync` with workers defined,
  missing project paths, PHP/Node binaries not on PATH, unreachable Redis/DB).
- M6 emits `schema/stack.schema.json` so editors autocomplete stack files via
  `# yaml-language-server: $schema=...`.
