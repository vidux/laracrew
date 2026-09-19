# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is
below `1.0.0`, minor versions may contain breaking config changes; those are always listed
under **Changed** with a migration note.

## [Unreleased]

Planned, in order — see `.claude/PLAN.md`:

- `laracrew scan` to discover Laravel projects and scaffold a stack
- Live queue depth and Redis stream consumer lag in the process tree
- File watching with graceful `queue:restart`
- `laracrew run <task>` for one-shot cross-project sequences
- Background daemon: `up --detach`, `attach`, `status`, `logs -f`

## [0.1.0] — 2026-09-19

First release. Boots and supervises the long-running processes of several Laravel projects at
once, from one command.

### Added

**Supervision**

- Dependency-ordered boot (`needs:`), with independent services started in parallel.
- Readiness gates before a dependent service starts: `tcp`, `http`, `logMatch`, `delayMs`.
- Restart policies (`never`, `on-failure`, `always`) with exponential backoff, a restart
  ceiling, and an attempt counter that resets after a service has been stable.
- A Laravel-aware stop ladder: `php artisan queue:restart` (or `horizon:terminate`) first, wait
  for the worker to finish the job it is holding, then terminate — and always as a process
  tree, so `artisan serve`'s child PHP server and `npm run dev`'s Vite are never orphaned.
- Rollback on a failed boot: a readiness gate that never opens stops everything that had
  already started, instead of leaving a half-booted stack behind.
- `external: true` for services laracrew health-checks but never starts, such as Redis.
- `autostart: false` for services defined but not launched, started later on demand.

**Interface**

- A full-screen process tree as the default view, which renders no log output at all; logs are
  opened one process at a time. Built on plain ANSI — no TUI framework.
- Per-process log inspection, a merged log across all services, restart/stop/start, and help.
- `external: true` dependencies are listed above the tree under their own heading rather than
  numbered among the managed processes, so a digit key always selects something startable.
- `--plain` prefixed interleaved logs, selected automatically when stdout is not a TTY.
- `--json` newline-delimited events for scripting.
- A broken pipe (`laracrew up --json | head`) shuts the stack down cleanly instead of crashing.

**Logs**

- Every line is written to `~/.laracrew/logs/<stack>/<service>.log`, on by default, rotated by
  size. Plain text with a sortable local timestamp and no colour codes, so `grep` works.
- `laracrew logs [service]` reads them back after the fact, with `-n`, `-f`, `--since 10m`,
  `--all` to merge every service in time order, and `--list`.
- Writes go through a held file descriptor rather than a stream, so a line reaches disk before
  a crashing process can lose it, and rotation can close the handle deterministically — a
  rename with an open handle fails outright on Windows.

**Configuration**

- `~/.laracrew/` home: `config.yaml`, `projects.yaml`, one folder per stack, tasks, fragments.
- YAML stacks validated against a schema, with errors that name the file, the field, and a
  spelling suggestion.
- Interpolation: `${env:VAR}`, `${env:VAR:fallback}`, `${project.path}`, `${project.env:VAR}`,
  `${stack.dir}`, `${port:N}`.
- Groups, profiles, `--only` / `--except` filtering, and `services/*.yaml` fragments.

**Commands**

- `laracrew init [--examples]`, `ls`, `up`, `doctor`, `link`, `unlink`.
- `laracrew link <stack>` installs a global command that boots one stack, so a project set is
  one word to launch. Generated shims are marked, and laracrew refuses to overwrite files it
  did not write or to shadow names like `npm` and `git`.

**Checks (`laracrew doctor`)**

- Two projects sharing a Redis database *and* a queue or stream name, computing the effective
  prefix the way Laravel does (`REDIS_PREFIX`, else a slug of `APP_NAME`) so it does not report
  a collision that isn't one.
- `QUEUE_CONNECTION=sync` in a project that runs a queue worker.
- Port clashes, missing project paths, an unreachable Redis, and a PHP binary that will not run.

### Notes

- Requires Node 20 or newer. Windows, macOS and Linux.
- Runtime dependencies: `commander`, `yaml`, `zod`.
- Accepted by the schema but not yet acted on: `watch`, `metrics` (read by `doctor` only), and
  `hooks`. Stack files written today stay valid.

[Unreleased]: https://github.com/OWNER/laracrew/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/laracrew/releases/tag/v0.1.0
