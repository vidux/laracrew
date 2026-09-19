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

## [0.2.1] — 2026-09-20

### Added

- **A stack builder**, [`docs/stack-builder.html`](docs/stack-builder.html) — a single self-contained
  page that writes a `stack.yaml` from projects and process commands as you fill them in. It
  encodes the rules the config resolver enforces, so it catches the mistakes before laracrew does:
  a service with no command, `stop.artisan` on a service with no project, a `needs:` pointing at
  nothing, an auto-started service depending on one you have to start by hand, a dependency cycle.
  It also shows the boot order the `needs:` graph produces, level by level.

  Open it from disk or serve `docs/` with GitHub Pages. It is not part of the npm package — no
  runtime dependencies, no build step, nothing to install.

## [0.2.0] — 2026-09-20

Graceful shutdown for any process, not only Laravel queue workers, and a `doctor` that only
applies its Laravel checks to Laravel.

laracrew has always been able to *run* anything — the supervisor takes a command and knows
nothing about the language behind it. But the two things that made it more than a process
runner, the graceful stop and the pre-flight checks, both assumed PHP. This release closes that
gap. Existing stack files keep working unchanged.

### Added

- **`stop.exec`** — any command as the first step of the stop ladder. It runs in the service's
  `cwd`, with the service's environment, and laracrew waits `graceMs` for the process to exit by
  itself before escalating to the signal and the tree kill. A Celery worker, a BullMQ consumer or
  a Compose project now shuts down as carefully as a queue worker:

  ```yaml
  stop: { exec: ["celery", "-A", "app", "control", "shutdown"], graceMs: 25000 }
  stop: { exec: "npm run drain", graceMs: 10000 }
  stop: { exec: ["docker", "compose", "stop"], graceMs: 30000 }
  ```

- **`doctor` checks external dependencies.** Every `external: true` service is probed through the
  `tcp` or `http` gate it already declares, so a stack's Postgres, RabbitMQ or HTTP dependency is
  verified before boot — whatever the stack is written in.
- `doctor` reads `REDIS_URL` when a project sets it instead of `REDIS_HOST` / `REDIS_PORT`.

### Changed

- **`stop.artisan` is now shorthand for `stop.exec`.** It resolves to `<project php> artisan
  <command>`, run from the project root even when the service sets its own `cwd`. Behaviour for
  existing Laravel stacks is unchanged; a service may declare one or the other, not both. A
  service that declares its own graceful step now replaces an inherited one in either direction,
  so a stack can default to `artisan: queue:restart` and still give one service its own `exec`.
- **`doctor` applies each check only where it means something.** It works out which projects run
  PHP (from their commands and from `stop.artisan`) and which talk to Redis (from their `.env`
  and their commands). A stack with no PHP in it gets no PHP findings; a stack with no Redis gets
  no Redis findings. Laravel stacks see exactly what they saw before.
- A Redis address already covered by an `external: true` service's gate is no longer probed a
  second time from the project's `.env`.
- `laracrew --help` and the generated `projects.yaml` no longer describe projects as Laravel-only.
  `php:` is documented as what it is: the binary the `stop.artisan` shorthand runs.

### Fixed

- **`laracrew --version` reported `0.1.0` on every release.** The version was a hardcoded
  constant that nobody bumped, so `0.1.1` and `0.1.2` both identified themselves as `0.1.0`. It is
  now baked in from `package.json` at build time, with a test that fails if the two ever disagree.
- **`stop.artisan` on a service with no project was silently ignored** — the graceful step was
  skipped and nothing said so. It is now a config error that names `stop.exec` as the way out.
- **`doctor` failed on a machine without PHP** for a stack that contains no PHP: `php --version`
  ran for every declared project and a missing binary was a blocking `✖` with exit code 1.
- **False Redis collision between projects that never touch Redis.** Two projects with no `.env`
  both resolved to the same synthesized default namespace and were reported as sharing it.
- The "no `artisan` file" and "`.env` is missing or empty" warnings no longer fire for projects
  that are not PHP projects.

### Notes

- 244 tests. The graceful stop step had no coverage before this release; it now has unit tests
  for both outcomes (the process exits by itself, and the ladder escalating when it does not),
  plus tests for every new config error.
- The npm description and `laracrew --help` now say "your projects" rather than "your Laravel
  projects". The README still leads with the Laravel story, which is what the tool was built for.

## [0.1.2] — 2026-09-20

### Added

- `repository`, `homepage` and `bugs` metadata, so the npm page links back to the source.

## [0.1.1] — 2026-09-20

First release published to npm. No code changes from `0.1.0`.

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

[Unreleased]: https://github.com/vidux/laracrew/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/vidux/laracrew/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/vidux/laracrew/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/vidux/laracrew/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/vidux/laracrew/releases/tag/v0.1.1
[0.1.0]: https://github.com/vidux/laracrew/releases/tag/v0.1.0
