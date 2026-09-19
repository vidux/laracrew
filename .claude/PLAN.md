# laracrew — Plan

> Status: **M0, M1 and M2 shipped** — see §7. Date: 2026-09-19.
> Runtime decision: **Node.js + TypeScript + Ink** (locked in).

## 1. The problem

You develop two (soon N) Laravel apps that talk to each other. Booting a working dev
environment means opening 8–14 terminal tabs and typing, in the right order:

```
cd D:/work/api     && php artisan serve
cd D:/work/api     && php artisan queue:work redis --queue=high,default
cd D:/work/api     && php artisan streams:listen orders
cd D:/work/api     && php artisan schedule:work
cd D:/work/api     && npm run dev
cd D:/work/portal  && php artisan serve --port=8001
cd D:/work/portal  && php artisan queue:work redis --queue=default
cd D:/work/portal  && php artisan streams:listen inventory
...
```

Every one of these is long-running. When a worker dies you don't notice. When you change a
job class you must remember PHP workers cache code and need a restart. When a queue backs up
or a Redis consumer group starts lagging, nothing tells you — you find out when a feature
"doesn't work". Closing the terminal kills everything and you start over.

## 2. What we are building

A single cross-platform CLI, **`laracrew`**, that:

1. Keeps its own config home at **`~/.laracrew/`** — stacks (long-running fleets), tasks (one-shot
   sequences), shared fragments, logs.
2. Boots a whole named fleet with **one command**: `laracrew up dual`.
3. Supervises every process: dependency ordering, readiness gates, crash detection,
   exponential-backoff restarts, graceful Laravel-aware shutdown.
4. Renders a **live TUI**: process list with status, uptime, restarts, CPU/RAM, plus a focusable
   log pane, merged log view, search and filter.
5. Is **Laravel-aware**, which is the part off-the-shelf tools (`concurrently`, `pm2`, `overmind`,
   `docker compose`) cannot do — see §5.

### Name

**Locked: `laracrew` everywhere.** npm package `laracrew`, binary `laracrew`, config home
`~/.laracrew/`, repo folder `laracrew`. One word to remember, no collision with `artisan` /
`sail` / `php`, and it reads as what it is: the crew of processes behind a Laravel dev setup.

A shorter alias (`lc`) can be added later as a second `bin` entry if the typing gets old — that
is a one-line change in `package.json#bin` and does not affect anything else.

## 3. Core concepts

| Concept | Meaning | Lives in |
|---|---|---|
| **Project** | One Laravel app root: path, php binary, `.env`, default env vars | `~/.laracrew/projects.yaml`, or inline in a stack |
| **Service** | One long-running process: cmd, cwd, env, deps, readiness, restart policy, watch rules | a stack file |
| **Stack** | A named set of services spanning one or more projects — the thing you `laracrew up` | `~/.laracrew/stacks/<name>/stack.yaml` |
| **Group** | A tag on services (`workers`, `http`, `assets`) for `--only` / `--except` | a stack file |
| **Profile** | A named override set (`light` = skip Vite + Telescope) | a stack file |
| **Task** | A one-shot ordered sequence (`reset` = migrate:fresh + seed across both apps) | `~/.laracrew/tasks/<name>.yaml` |

You asked for "subfolders for custom commands". Concretely: **each stack is its own folder**, so a
stack can ship its own fragments, hooks and README next to its definition — and you can turn
`~/.laracrew` into a git repo and sync it between machines.

## 4. Runtime decision — Node

**Node 20+ / TypeScript / Ink**, for these reasons in order of weight:

- Ink (React for the terminal) makes the "beautiful" requirement cheap — flexbox layout, proper
  re-render diffing, no manual cursor math.
- `npm i -g laracrew` works on Windows/macOS/Linux; `npm link` lets you hack on it while using it.
- The ecosystem already solves the hard parts: `execa`, `tree-kill`, `pidusage`, `chokidar`, `ioredis`.
- You will tweak this tool constantly. An interpreted runtime means no build-and-ship loop.

Rejected: **C#/.NET** — excellent process control, but Spectre.Console TUI work is heavier and
per-OS self-contained builds add friction to a tool you edit weekly. **Lazarus/FPC** — no practical
TUI + async-stdout + Redis story; it is the right tool for desktop GUI work, not this.
**PHP / Laravel Zero** — idiomatic for you, but PHP is the weakest of the three at supervising
long-lived child processes and has no serious TUI library.

## 5. The Laravel-aware edge (why not just use pm2)

These are the features that make `laracrew` worth building rather than configuring `concurrently`:

1. **Project auto-discovery** — `laracrew scan D:/work` finds every folder containing an `artisan`
   file, reads `composer.json` + `.env`, detects Horizon / Octane / Reverb / Pulse / Telescope /
   Vite / `schedule:work`, and scaffolds a starter stack you then edit.
2. **Graceful, correct shutdown** — never hard-kill a worker mid-job. Stop order is
   `php artisan queue:restart` (or `horizon:terminate`) → wait for the worker to finish its current
   job → terminate. On Windows, kill the whole process tree, since PHP spawns children.
3. **Code-change restarts** — PHP workers cache code. `watch: [app, config, routes]` triggers a
   graceful `queue:restart` instead of a hard kill, debounced. This alone removes the number one
   daily annoyance.
4. **Queue depth on screen** — poll Redis `LLEN` per configured queue per project. A worker that is
   "running" while its queue is 4,000 deep becomes visible at a glance.
5. **Redis stream consumer lag** — `XINFO GROUPS <stream>` per listener: entries-read, pending, lag.
   For two apps consuming each other's streams this is the single most useful number on the screen.
6. **Failed-jobs badge** — count from `failed_jobs` / Redis, with `laracrew retry <project>` on a key.
7. **Cross-project collision doctor** — `laracrew doctor` warns when two projects share a Redis DB *and*
   a queue prefix or stream name, when ports collide, when `QUEUE_CONNECTION=sync` in a project that
   has workers defined, and when the URLs the two apps use for each other don't match the ports the
   stack actually serves. This class of bug eats hours.
8. **Readiness gates** — `portal:queue` does not start until Redis answers and `api:serve` returns
   HTTP 200. No more "it failed because it booted 200 ms too early".
9. **One-shot cross-project tasks** — `laracrew run reset` runs migrate:fresh + seed on both apps in
   dependency order, pausing workers first and resuming after.

## 6. CLI surface

```
laracrew init [--examples]        # create ~/.laracrew; --examples adds a demo stack + template
laracrew link <stack> [--as name] # install a global command that boots one stack
laracrew unlink <name>            # remove it again
laracrew scan [dir]               # discover Laravel projects -> scaffold a stack
laracrew doctor [stack] [--fix]   # env / port / redis / collision checks before you boot
laracrew ls                       # list stacks, tasks, projects
laracrew up [stack]               # boot the fleet + TUI (default stack if omitted)
      --only workers,http   --except vite   --profile light
      --plain                 # prefixed interleaved logs, no TUI (pipe / CI friendly)
      --detach                # run under the background daemon
      --json                  # machine-readable event stream
laracrew down [stack]             # graceful stop of everything, reverse dependency order
laracrew status [--json]          # table of what is running (works against the daemon)
laracrew logs <service> [-f] [-n 500] [--since 5m]
laracrew restart <service|group|stack>
laracrew run <task> [--dry-run]
laracrew open <service>           # open the service's URL in the browser
laracrew edit <stack>             # $EDITOR on the stack file
laracrew completion <bash|zsh|pwsh>
```

## 7. Milestones

Each milestone is shippable and has hard acceptance criteria. Do not start the next one before
the current one's criteria pass.

### M0 — Skeleton (½ day) — **DONE**
TS project, tsup build, commander entry, `laracrew --version`, `laracrew init` creating `~/.laracrew` with a
commented example stack, vitest wired, `fixtures/` containing a fake `artisan` script that logs
and sleeps.
**Done when:** `npm link && laracrew init` produces a valid `~/.laracrew` tree on a clean Windows box.

### M1 — Config + Supervisor + plain mode (2 days) — **DONE**
YAML load, zod schema, `${env:...}` / `${project.path}` interpolation, `extends`, profiles, groups.
`Supervisor` spawns services in dependency order with readiness gates, restart policies with
exponential backoff, and graceful stop. `laracrew up --plain` prints colour-prefixed interleaved logs;
Ctrl-C stops everything in reverse dependency order.
**Done when:** the fixture stack of 6 fake services boots; one killed externally restarts with
backoff; Ctrl-C leaves **zero** orphan processes in Task Manager.

### M2 — The TUI (3 days) — **DONE**
Full-screen view per [TUI-UX.md](TUI-UX.md) — built on plain ANSI, **not** Ink: the process tree
is the default screen and renders no log lines at all; logs are opened one process at a time.
Rendering is a 250 ms poll rather than an event subscription, which decouples repaint cost from
log volume entirely.
**Done when:** the overview shows no log output, a digit jumps straight into one process's log,
and the whole UI is driven by pure functions unit-testable without a terminal. ✔

### M3 — Laravel awareness (3 days) — *next*
Project detection, `.env` reader, `laracrew scan` scaffolding, `laracrew doctor` checks (§5.7),
artisan-aware stop, queue depth + stream consumer lag panels, failed-jobs badge.
**Done when:** `laracrew scan` on your two real projects produces a stack that boots unedited, and the
dashboard shows correct queue depth and stream lag against live Redis.

### M4 — Watch + tasks (2 days)
`chokidar` watchers with debounce and a `queue:restart` strategy; task runner with ordered and
parallel steps, `continueOnError`, pause-and-resume of workers around destructive steps, `--dry-run`.
**Done when:** editing a job class restarts only the right workers, and `laracrew run reset` completes
both projects in order with a clean summary table.

### M5 — Daemon + detach (2 days)
Background supervisor, IPC over a named pipe (Windows) / unix socket, `laracrew up --detach`,
`laracrew attach`, `laracrew status`, `laracrew logs -f`, log files with rotation under `~/.laracrew/logs/`.
**Done when:** you can close the terminal, reopen it, run `laracrew attach`, and see live state plus history.

### M6 — Polish + release (2 days)
Themes (including no-colour and high-contrast), JSON Schema published for editor autocomplete on
stack files, shell completions, `--json` on every read command, README with a GIF, npm publish.

**Total: ~15 working days.** M0–M2 alone (≈5 days) already replace your terminal tabs; everything
after that is the part that makes it better than a tab manager.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Windows process trees** — `php artisan serve` and `npm run dev` spawn children; killing the parent orphans them | All termination goes through `core/process/stop.ts` using `tree-kill` / `taskkill /T /F`; M1 acceptance explicitly checks for orphans |
| **No POSIX signals on Windows** — graceful stop is not `SIGTERM` | Laravel-native graceful path (`queue:restart`, `horizon:terminate`) first; hard kill only after a grace timeout |
| **Ink render throughput** with noisy workers | Ring buffer + batched flush + render only the visible log slice; cap in-memory lines per service (default 5000, configurable) |
| **`ioredis` as a hard dependency** | Metrics are optional and lazily loaded; the tool works fully with Redis unreachable — panels just show `—` |
| **Config sprawl** | One schema, one validator, one error formatter; `laracrew doctor` is the escape hatch; JSON Schema for editor autocomplete in M6 |
| **Scope creep into a Docker replacement** | The non-goals below are binding |

## 9. Non-goals (v1)

- Not a container runtime and not a replacement for Sail/Docker — it supervises processes on *your* machine.
- Not a production process manager. Dev-time tool: no clustering, no zero-downtime reloads.
- No remote / SSH orchestration.
- No web UI.
- No Laravel-version gymnastics — assume Laravel 10+.

## 10. Open questions

1. **Default stack** — should bare `laracrew up` use `~/.laracrew/stacks/default`, or the stack
   whose project paths contain `$PWD`? Proposal: `$PWD` match first, then `default`.
2. **`~/.laracrew` as a git repo** — offer `laracrew init --git` and a `laracrew sync` in M6, or
   leave it to you?
3. **Metrics polling interval** — 2 s default, per-stack configurable. Confirm during M3.

*(Resolved: the name — see §2.)*
