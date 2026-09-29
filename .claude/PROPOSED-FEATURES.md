# laracrew — Proposed features

> Written 2026-09-29 against **v0.2.1**. Everything here is a proposal. [PLAN.md](PLAN.md)
> owns the milestones, their order and their acceptance criteria; a feature moves there once it
> is accepted, and this document is where it is argued for first. Each entry makes the case,
> describes the feature from the outside — command, config key, keystroke, what each output
> mode shows — and notes what it would touch. IDs are stable so entries can be cited in issues
> and PRs.

**Status** in the tables: *promised* means PLAN.md already names it under a milestone and this
is the detailed proposal; *new* means it appears nowhere in PLAN.md.

## 1. At a glance

| ID | Feature | Status | Effort |
|---|---|---|---|
| L1 | `laracrew scan` — find Laravel projects, write a stack | promised | M |
| L2 | Queue depth and stream consumer lag on screen | promised | L |
| L3 | Failed-jobs badge and `laracrew retry` | promised | M |
| L4 | Tail `storage/logs/laravel.log` as a service | new | M |
| L5 | Horizon and Octane stop defaults | new | S |
| L6 | More `doctor` checks, `--json`, a narrow `--fix` | partly promised | M |
| W1 | File watching with graceful restarts | promised | L |
| W2 | `laracrew run <task>` | promised | M |
| W3 | `up --exec "<cmd>"` for CI and end-to-end tests | new | S |
| W4 | Hooks that run | promised | S |
| T1 | Detail screen with crash history | new | S |
| T2 | Log search and stderr filter | promised | S |
| T3 | Exit summary | new | S |
| T4 | `:` command line in the TUI | new | M |
| T5 | Themes | promised | S |
| T6 | Notifications | new | S |
| E1 | Open a service's URL — `o`, `laracrew open` | promised | S |
| E2 | `laracrew artisan`, `exec`, `tinker` | new | S |
| E3 | `laracrew inspect` and `graph` | new | S |
| E4 | `laracrew edit`, `ls --long` | promised | S |
| E5 | Default stack by working directory | promised | S |
| E6 | `lc` alias | promised | S |
| E7 | `init --git` | promised | S |
| E8 | Stack-level and project-level `env:` | new | S |
| E9 | JSON Schema for editor autocomplete | promised | M |
| E10 | Shell completions | promised | M |
| E11 | `--json` on every read command | promised | S |
| S1 | `replicas: N` | new | M |
| S2 | Periodic health checks after ready | new | M |
| S3 | Profile overrides | promised | M |
| D1 | `StackSource` interface | new | S |
| D2 | `up --detach` and the IPC server | promised | L |
| D3 | `status`, `down`, `restart`, `start`, `stop` from a shell | promised | M |
| D4 | `attach` | promised | M |
| D5 | `logs -f` from the live daemon | promised | S |
| D6 | Stale run-file handling | new | S |
| D7 | Task runner pauses groups over IPC | new | S |

Effort: **S** under half a day, **M** one to two days, **L** three or more.

**Where the value is.** If only three of these get built: L2 (queue depth and lag), L4 (the
Laravel log in the TUI) and W1 (watch with graceful restart). They are the three things a
terminal tab manager cannot do, and the three that cost time every day.

## 2. Starting point — v0.2.1

Shipped and tested: the config pipeline with fragments, groups, profiles (`only` / `except`)
and interpolation; the Supervisor with dependency-ordered boot, readiness gates, backoff
restarts, rollback on a failed boot and the stop ladder (`stop.exec` / `stop.artisan`); the
TUI (overview, per-process log, merged log, help); `--plain` and `--json`; file logs and
`laracrew logs`; `init`, `ls`, `up`, `doctor`, `link` / `unlink`; the stack builder page. CI
runs the tests and the tarball smoke test on Windows and Ubuntu on every push; two manually
triggered twins re-run that matrix and release to npm — `publish.yml` publishes through trusted
publishing; `publish-stage.yml` stages with a token for a 2FA approval on npmjs.com, while
npm/cli#9969 keeps the OIDC exchange from accepting this repository.

Several keys are accepted by the schema and do nothing yet, so stack files written today are
already valid for the proposals that give them meaning:

| Key | Today | Given meaning by |
|---|---|---|
| `service.watch` | validated only | W1 |
| `service.metrics` | read by `doctor` for collision checks | L2 |
| `service.url` | recorded, shown nowhere | E1 |
| `hooks.preUp` / `postDown` | validated only | W4 |
| `tasks/*.yaml` | `loadTask` / `listTasks` exist, no runner | W2 |
| `config.theme` | validated only; `LARACREW_ASCII` is the only switch | T5 |
| `config.editor` | validated only | E4 |
| `config.metricsIntervalMs` | validated only | L2 |

`core/laravel/detect.ts` already contains `scanForProjects` and `suggestServices`; no command
calls them (L1).

## 3. How a proposal is judged

In order of weight. A proposal that fails the first two is "maybe later"; one that fails any of
the last three is declined.

1. **It is Laravel-aware** (PLAN.md §5) *or* it removes something you do every day. A generic
   process-manager feature that `pm2` already has is not a reason on its own.
2. **It answers a question you actually have while developing** — "is it up", "why did it
   die", "is the queue backing up", "did my change take". Not "how much RAM" (TUI-UX.md §3).
3. **It works in all three output modes**, or degrades with a stated reason.
4. **It adds no runtime dependency** without an ARCHITECTURE.md §9 justification. Cold
   `laracrew --version` stays under 150 ms.
5. **Windows is not a follow-up.** No POSIX signal assumptions; stopping goes through `stop.ts`.

## 4. Laravel awareness

### L1 · `laracrew scan` — find Laravel projects, write a stack

**Problem.** The first stack is written by hand from a template or built one command at a time
with `laracrew draft`; neither knows which of your projects run Horizon, which have Vite, or
which ports they use.

**Proposal.**

```
laracrew scan [dir] [--depth 2] [--write <stack>] [--json]
```

Walks `dir` (default: the current directory) two levels down for folders holding `artisan`
and `composer.json`. Prints a table: path, key, Laravel version from `composer.lock`, detected
features (Horizon, Octane, Reverb, Pulse, Telescope, Vite), `QUEUE_CONNECTION`, the port in
`APP_URL`. `--write dual` writes `~/.laracrew/stacks/dual/stack.yaml` and appends the projects
to `projects.yaml`, never overwriting an existing key without `--force`.

The generated stack uses the argv form for every command (ARCHITECTURE.md §7) and `${port:N}`
from `APP_URL`; adds one `external: true` gate per dependency the `.env` reveals — Redis, the
database when the driver is not sqlite, Mailpit when `MAIL_PORT=1025`; gates `:serve` on
`http …/up` when `bootstrap/app.php` declares `health:` (Laravel 11+), else on `tcp` to the
port; emits `queue:work` or `horizon` (never both), `schedule:work`, `reverb:start`, `npm run
dev` as `suggestServices` already decides, each with the L5 stop default, a W1 watch list and
`metrics.queues` read from `config/queue.php` when the value is a literal; adds an L4 log
tail per project; and mentions Sail with a hint to declare its containers as gates rather than
have laracrew start Docker.

**Modes.** A table on a TTY and in plain; `--json` gives the detected projects and the
generated YAML as a string.

### L2 · Queue depth and stream consumer lag on screen

**Problem.** A worker that says `running` while its queue is 4,000 deep looks healthy. For two
apps consuming each other's streams, consumer-group lag is the single most useful number and
nothing shows it (PLAN.md §5.4–5.5).

**Proposal.** A sampler polls every `config.metricsIntervalMs` (default 2 s) for services that
declare `metrics`, and emits `metrics:sample` events. The connection per project comes from its
`.env` — `REDIS_HOST/PORT/PASSWORD/USERNAME/DB` or `REDIS_URL`, TLS for `rediss://`. The key
prefix (`REDIS_PREFIX`, else the `APP_NAME` slug) is computed by one shared module so `doctor`
and the sampler cannot disagree.

Queues: `LLEN <prefix>queues:<name>` plus the `:delayed` and `:reserved` sorted sets, shown as
`12` or `12 (+3 delayed)`. Streams: `XINFO GROUPS <key>` for the configured group — `pending`,
`lag` (Redis 7+, `—` on older servers), `entries-read`. `metrics.warnAt` (default 100) turns a
number yellow; `metrics.criticalAt` (default 1000) turns it red and puts `queues backing up` in
the header ahead of `all healthy`. When Redis is unreachable the numbers show `—`, one warning
is emitted, and the sampler retries with backoff. Boot never waits on it.

**Modes.** TUI: a right-hand column on each row (`q high 12 · default 0`, `lag 340 · pend 3`)
and a line in the per-process header. Plain: only threshold crossings, as notices — a line per
sample would be noise. JSON: every sample.

**Needs a decision** on the Redis client (§11).

### L3 · Failed-jobs badge and `laracrew retry`

**Problem.** A job fails, lands in `failed_jobs`, and nothing on screen changes.

**Proposal.** No database driver. The count comes from `php artisan queue:failed`, run per PHP
project every `config.failedJobsIntervalMs` (default 60 s — one short PHP boot a minute costs
nothing) and parsed by counting rows. On for any project with a `queue:work` or `horizon`
service; `metrics.failedJobs: false` turns it off per service, `0` in config turns it off
everywhere.

```
laracrew retry <project> [id…|--all] [--stack <name>]     # php artisan queue:retry …
laracrew failed <project> [--json]                        # the list, from anywhere
```

**Modes.** TUI: `⚠ 3 failed` on the worker row and a count in the header. Plain: a notice when
the count rises. JSON: `metrics:failed` events.

### L4 · Tail `storage/logs/laravel.log` as a service — *new*

**Problem.** An exception thrown inside a job goes to `laravel.log`, not to the worker's
stdout. The one thing you want to read when a job fails is the one thing the TUI cannot show.

**Proposal.** A service kind that follows a file instead of running a process:

```yaml
- name: api:log
  project: api
  tail: storage/logs/laravel.log          # relative to the project path; no cmd
```

`tail` may be a glob (`storage/logs/laravel-*.log` for `LOG_CHANNEL=daily`); the newest match
is followed and re-evaluated when it stops growing. It starts from the last `logs.maxLines`,
follows by polling size at 500 ms (`fs.watchFile`, which works on every platform including
network drives), survives truncation, and keeps multi-line stack traces intact line by line.
`toFile` defaults to `false` for a tail service — copying `laravel.log` into `~/.laracrew/logs`
would be waste.

A tail service has no `cmd`, `restart` or `stop`, cannot be a `needs:` target (a config error
that says so), and sits in its own final boot level. `s` pauses and resumes it. It is general
by design: an nginx access log or a Celery log file works the same way.

**Modes.** TUI: state `running`, with `tail storage/logs/laravel.log` where a dependency shows
its probe; the log view is the file. Plain and JSON: ordinary `service:log` lines.

### L5 · Horizon and Octane stop defaults — *new*

**Problem.** `stop.artisan` has to be spelled out per service, and the right value depends on
what the service is.

**Proposal.** A service whose command is `artisan horizon` defaults to
`stop.artisan: horizon:terminate`; `artisan octane:start` defaults to `octane:stop`. An
explicit `stop:` still wins. `doctor` warns when a `horizon` service exists without
`laravel/horizon` in `composer.json`, and when one project runs both `queue:work` and `horizon`
(both consume the same queues). The W1 restart strategy is the stop ladder followed by a start,
so `queue:restart` and `horizon:terminate` share one code path. Worth documenting:
`queue:restart` is a broadcast — every worker of that project restarts, which is what Laravel
intends.

### L6 · More `doctor` checks, `--json`, a narrow `--fix`

**Proposal.**

- `--json`: findings as an array of `level`, `message`, `hint`.
- New checks, each gated on project type the way the existing ones are: `vendor/autoload.php`
  missing or older than `composer.lock` ("run `composer install`"); `node_modules` missing or
  older than `package-lock.json`, only when a service runs `npm` or `vite`; `APP_KEY` empty;
  `.env` missing while `.env.example` exists; a `.env` value of the form
  `http://127.0.0.1:<port>` or `http://localhost:<port>` whose port no service in the stack
  serves — PLAN.md §5.7's "the URLs the apps use for each other don't match the ports the stack
  serves"; and, behind `--deep` because it boots PHP per project, pending migrations via
  `php artisan migrate:status --pending`.
- `--fix` touches **only laracrew-owned state**: stale `~/.laracrew/run/*.json` (D6), dangling
  `link` shims, an orphan pid laracrew itself spawned and recorded. It never runs a package
  manager or writes inside a project; for those it prints the command.

## 5. Reacting to change

### W1 · File watching with graceful restarts

**Problem.** PHP workers cache code. Forgetting to restart one after editing a job class is the
number-one daily annoyance (PLAN.md §5.3).

**Proposal.** One watcher per service that declares `watch`. Paths resolve against the service
`cwd`; files are allowed as well as directories, so `.env` and `composer.lock` can be listed
directly. Default `ignore`: `vendor`, `node_modules`, `storage`, `.git`, `*.log`, `*.cache`.
Changes are debounced (`debounceMs`, default 800) and coalesced — a `git checkout` touching 500
files is one restart, and a change arriving mid-restart queues exactly one more.

Strategy `restart` (default) runs the stop ladder — graceful step first, so a worker finishes
its job — then starts again. `none` only emits a notice ("app/Jobs/SyncOrder.php changed —
press r"). `artisan-queue-restart` stays valid as an alias of `restart` so existing files keep
working. L1 writes `paths: [app, config, routes, database, .env, composer.lock]` on workers and
`[.env, composer.lock]` on `:serve`, which is how ".env changed" and "autoload changed" restart
the right things without a separate trigger vocabulary. `up --no-watch` disables watching for a
session, `w` toggles it in the TUI, `config.watch: false` disables it by default.

**Modes.** TUI: a `⟲` marker on watched rows, and the status note names the file that caused a
restart. Plain: one line per trigger. JSON: `watch:changed` and `watch:restart` events with the
first five paths and a total.

**Needs a decision** on the watcher (§11).

### W2 · `laracrew run <task>`

**Problem.** The task schema and loader exist; nothing runs a task.

**Proposal.**

```
laracrew run <task> [--dry-run] [--stack <name>] [--json]
```

Sequential steps, `parallel` blocks, `continueOnError`, per-step `project` → `cwd`, with the
same interpolation as stacks. Output: a header per step (`[reset 2/4] api $ php artisan
migrate:fresh --seed`), the step's output streamed and prefixed, and a summary table (step,
project, status, duration, exit code). The exit code is the first failure's unless
`continueOnError`. `pauseServices` needs a running stack: without the daemon it says so and
continues; with D7 it stops the named groups first and starts them after, even when a step
fails. A task may name `stack: dual` so group names and project keys resolve from that stack.

**Modes.** Plain is the native form; a TTY adds colour to the summary. `--json` emits
`task:step` / `task:done`. Running a task from inside the TUI is T4.

### W3 · `up --exec "<cmd>"` for CI and end-to-end tests — *new*

**Problem.** "Boot everything, wait until it is ready, run the test suite, tear it all down" is
a shell script with sleeps in it today.

**Proposal.** Boot, wait for `stack:ready`, run the command with inherited stdio, then bring
the stack down and exit with the command's exit code — the `start-server-and-test` pattern:

```
laracrew up dual --plain --exec "npm run e2e"
```

`--ready-timeout <ms>` bounds the wait. The command sees `LARACREW_STACK=<name>`. A failed boot
exits 1 before the command runs.

**Modes.** Plain is the point, and non-TTY selects it automatically. On a TTY it runs without
the TUI. JSON: the command's exit appears as a notice.

### W4 · Hooks that run

**Proposal.** `preUp`, `postUp`, `preDown`, `postDown` (the last two are new keys), run from
the stack folder with `LARACREW_STACK` set. A failing `preUp` aborts the boot and shows its
output; a failing `postDown` is a warning. Windows: `.ps1` through
`powershell -ExecutionPolicy Bypass -File`, `.cmd` / `.bat` through `cmd /c`, `.sh` through
`sh` when Git Bash is on PATH, otherwise a config error naming the alternative. `up --no-hooks`
skips them.

**Modes.** Hook output is `system` log lines: the TUI status note, prefixed lines in plain,
`hook:start` / `hook:done` events in JSON.

## 6. Seeing why, not only what — the TUI

### T1 · Detail screen with crash history — *new*

**Problem.** A row says `⟳4` and nothing says why.

**Proposal.** `ManagedProcess` keeps the last 10 exits: time, code, signal, uptime, the last
five stderr lines. `i` opens a pure screen with the resolved command, cwd, the service's own
`env` keys (values masked when the key matches `/SECRET|PASSWORD|KEY|TOKEN/`), groups, needs,
probe, stop policy, watch list, and the restart history. The log-view header gains
`last exit: code 1 · 2 m ago`. `status --json` (D3) carries the same history.

### T2 · Log search and stderr filter

**Proposal.** `/` prompts in the log and merged views, `n` / `N` step through matches, matches
are highlighted, `esc` clears. Case-insensitive regex. `e` toggles stderr-only. Both live in
`UiState`, so they are pure and tested like every other key. TUI only — plain has `grep`.

### T3 · Exit summary — *new*

**Proposal.** After `down`, a table: service, uptime, restarts, last exit. In the TUI it is the
last thing on the shutdown screen; in plain it is printed; JSON already carries the events.

### T4 · `:` command line in the TUI — *new*

**Problem.** Acting on a group or running a task from the TUI would each need another single
key, and the key table is already at the edge of what the help screen can list.

**Proposal.** `:restart workers`, `:stop assets`, `:start portal:backfill`, `:run reset`,
`:open api:serve`, with tab completion of names. One `commandLine` field in `UiState`, pure and
tested. Task output opens as a log view.

### T5 · Themes

**Proposal.** Honour `config.theme`: `auto`, `dark`, `light`, `mono` (glyphs only, no colour),
`high-contrast`. Detect a legacy Windows console (no `WT_SESSION`, no `TERM_PROGRAM`) and switch
to ASCII glyphs without needing `LARACREW_ASCII` (ARCHITECTURE.md §7). Contained in `theme.ts`.

### T6 · Notifications — *new*

**Proposal.** On `crashed` → `failed` and on an L2 threshold crossing: terminal bell and
window title first; then `osascript`, `notify-send`, or a PowerShell toast. `config.notify` is
`false` by default. Never in plain or JSON mode.

## 7. Everyday ergonomics

### E1 · Open a service's URL

`o` opens the selected service's `url` in the browser; `laracrew open <service> [--stack]` does
the same from a shell. `start ""` on Windows, `open` on macOS, `xdg-open` elsewhere. Gives the
existing `url` key a purpose.

### E2 · `laracrew artisan`, `exec`, `tinker` — *new*

`laracrew artisan <project> <args…>` runs `<php> artisan …` in the project directory with the
project's PHP binary; `laracrew exec <project> -- <cmd>` runs anything there;
`laracrew tinker <project>` is the obvious alias. `--all` runs the command in every project of
`projects.yaml` (or of `--stack`) with a header per project. Inherits stdio and passes the exit
code through. Needs no stack — it is the "run this in that project from anywhere" command.

### E3 · `laracrew inspect` and `graph` — *new*

`laracrew inspect <stack> [service] [--json]` prints the resolved stack after defaults,
profile and interpolation — the tool for debugging a `${…}` that did not expand the way you
thought, with secrets masked as in T1. `laracrew graph <stack> [--dot]` prints the boot levels
and dependency edges: the stack builder's boot order, in the terminal.

### E4 · `laracrew edit`, `ls --long`

`laracrew edit <stack|projects|config|task:<name>>` opens the file in `config.editor`, then
`$VISUAL` / `$EDITOR`, then `code`, then `notepad` or `open -t`. `ls --long` adds the
description, service and group counts, profiles, the linked command, and the first paragraph of
the stack's own `README.md`.

### E5 · Default stack by working directory

PLAN.md §10.1, resolved: bare `laracrew up` picks the stack whose project paths contain the
current directory; then `defaultStack`; then the only stack that exists. Ambiguity lists the
candidates.

### E6 · `lc` alias

A second `bin` entry, and `lc` added to the names `link` refuses to shadow.

### E7 · `init --git`

Runs `git init` in `~/.laracrew` and writes a `.gitignore` for `logs/`, `run/` and `bin/`.
PLAN.md §10.2, resolved: no `sync` command — git is the sync.

### E8 · Stack-level and project-level `env:` — *new*

Maps merged under each service's own `env`, so `PYTHONUNBUFFERED=1` or `APP_ENV=local` is
written once rather than ten times.

### E9 · JSON Schema for editor autocomplete

Schemas for stack, projects, task and config files, generated from the zod definitions at
build time, committed under `schema/`, with a test that fails on drift. `init` writes the
`# yaml-language-server: $schema=…` header. The CONFIG-SPEC rule "schema in the same change"
becomes enforceable. Needs a decision on how to generate them (§11).

### E10 · Shell completions

`laracrew completion bash|zsh|pwsh|fish`, with dynamic stack, service, task and project names
served by a hidden `laracrew __complete`. commander has no built-in; the scripts are
hand-written and tested by invoking `__complete`.

### E11 · `--json` on every read command

`logs --json` (one `LogLine` per line), `scan`, `doctor`, `status`, `inspect`. `ls` has it.

## 8. The supervisor

### S1 · `replicas: N` — *new*

**Problem.** `queue:work` is single-threaded; running three is routine, and today that is
three near-identical service blocks.

**Proposal.** `replicas: 3` yields `api:queue#1..3`, each with its own pid, state, ring buffer
and log file, sharing every other setting. `laracrew restart api:queue` and the `r` key act on
all of them; `enter` on the group row expands it. `metrics` attach to the base name once.
`stop.artisan: queue:restart` runs once per project, not once per replica — it is a broadcast.

### S2 · Periodic health checks after ready — *new*

**Problem.** `ready` is checked once. A hung `artisan serve` stays `running` forever.

**Proposal.**

```yaml
health: { http: "http://127.0.0.1:8000/up", intervalMs: 10000, failuresBeforeRestart: 3 }
```

A new state `unhealthy` (glyph `◑`, yellow) between `running` and a ladder restart. It touches
the state machine, `theme.ts`, `screen.ts`, plain, JSON, CONFIG-SPEC and the schema together.
Best built before the daemon (D2), so the IPC contract carries a finished state machine.

### S3 · Profile overrides

PLAN.md §3 calls a profile "a named override set"; today it is `only` / `except`. Overrides
(`profiles.light.services.api:queue.cmd: …`) are easy to add and hard to explain next to
`--only`. Proposed only for when a real stack needs it.

## 9. Running in the background

The daemon from PLAN.md §M5 and ARCHITECTURE.md §6, split into pieces that can be argued for
and built separately.

| ID | Proposal |
|---|---|
| **D1** | **`StackSource` interface** — the read side of `Supervisor` (`snapshot()`, `logs`, `restart`, `stop`, `start`, `subscribe`) as an interface the TUI and plain renderer consume. The in-process Supervisor implements it today; the IPC client implements it later. A pure refactor first, so `attach` reuses every screen unchanged. |
| **D2** | **`up --detach`**: spawn the supervisor host detached, write `~/.laracrew/run/<stack>.json` (pid, pipe path, started at), serve IPC over `\\.\pipe\laracrew-<stack>` or `~/.laracrew/run/<stack>.sock` as newline-delimited JSON identical to `--json`, plus request frames. |
| **D3** | **`status [stack] [--json]`**, **`down [stack]`**, **`restart <service\|group\|stack>`**, **`start` / `stop <service>`** — all against the daemon, all failing clearly when the stack is not running detached. |
| **D4** | **`attach [stack]`**: the TUI over a `StackSource` backed by IPC. `d` detaches again and leaves the daemon running; `q` asks whether to stop the fleet or only detach. |
| **D5** | **`logs -f` from the live daemon** rather than the file; the file tail keeps working when nothing is running. |
| **D6** | **Stale run files**: the daemon removes its file on exit; `status` and `doctor` notice a run file whose pid is gone; `doctor --fix` (L6) removes it. |
| **D7** | **`run <task>` pauses and resumes groups through IPC**, closing W2's gap. |

## 10. Considered and not proposed

- **`${port:auto}`** — the *other* app's `.env` holds the URL, so an auto-assigned port silently
  breaks the cross-app link the tool exists to protect.
- **CPU and memory columns** — cut once already (TUI-UX.md §3). Queue depth answers the
  question RAM never did.
- **A Pulse or Telescope replacement** — metrics stop at "is the queue backing up".
- **A live-tail overview** — the 250 ms poll and the no-logs overview are settled.
- **Anything that writes inside a project** — not `composer install`, not `storage:link`, not a
  `.vscode/tasks.json`. `doctor` prints the command; you run it.
- **Group-specific single keys** in the TUI — superseded by T4.

PLAN.md §9's non-goals stand: no containers, no production, no remote, no web UI, Laravel 10+.

## 11. What the proposals would add

**Config keys.** Each one, when accepted, updates CONFIG-SPEC.md and the schema (E9) in the same
change.

| Key | Where | Type / default | Proposal |
|---|---|---|---|
| `tail` | service | path or glob, relative to the project path | L4 |
| `metrics.warnAt` / `metrics.criticalAt` | service | int, `100` / `1000` | L2 |
| `metrics.failedJobs` | service | bool, `true` for queue/horizon services | L3 |
| `watch.strategy` | service | `restart` (default) \| `none`; `artisan-queue-restart` as an alias | W1 |
| `replicas` | service | int ≥ 1, `1` | S1 |
| `health` | service | `{ http\|tcp, intervalMs, failuresBeforeRestart }` | S2 |
| `env` | stack, project | map, `{}` | E8 |
| `hooks.postUp` / `hooks.preDown` | stack | path, unset | W4 |
| `stack` | task | stack name, unset | W2 |
| `config.failedJobsIntervalMs` | global | int, `60000`; `0` disables | L3 |
| `config.watch` | global | bool, `true` | W1 |
| `config.notify` | global | bool, `false` | T6 |
| `config.theme`, `config.editor` | global | already accepted; would be honoured | T5, E4 |

**Events.** `core/events/types.ts` is the contract shared by the TUI, plain, JSON and the
daemon. Additions are additive; existing shapes do not change, so `--json` consumers written
against 0.2 keep working.

| Event | Fields | Proposal |
|---|---|---|
| `metrics:sample` | `service`, `queues: {name, depth, delayed, reserved}[]`, `streams: {key, group, pending, lag, entriesRead}[]`, `at` | L2 |
| `metrics:unavailable` | `project`, `reason`, `at` | L2 |
| `metrics:failed` | `project`, `count`, `at` | L3 |
| `watch:changed` / `watch:restart` | `service`, `paths` (first 5), `total` / `strategy`, `at` | W1 |
| `hook:start` / `hook:done` | `hook`, `file`, `code?`, `at` | W4 |
| `task:step` / `task:done` | `task`, `index`, `status`, `durationMs`, `code?` | W2 |
| `service:health` | `service`, `ok`, `failures`, `at` | S2 |
| `daemon:attached` / `daemon:detached` | `client`, `at` | D4 |

`ServiceState` would gain `unhealthy` (S2). Nothing else in the union changes.

**Dependencies.** The runtime list is `commander`, `yaml`, `zod`. Two additions were once
planned; both deserve a second look now that the project hand-rolls spawning, tree-kill and
colour for startup time.

| Need | Once planned | Proposed instead | Fallback |
|---|---|---|---|
| Redis (L2, L3) | `ioredis`, lazy | A hand-rolled RESP2 client: `AUTH`, `SELECT`, `PING`, `LLEN`, `ZCARD`, `XINFO GROUPS`, TLS via `node:tls`. Five commands, no pub/sub, no cluster — about 200 lines plus a fake server for tests. Zero install cost for everyone who never declares `metrics`. | `ioredis` behind a dynamic `import()` if ACL, Sentinel or cluster turn out to matter. |
| File watching (W1) | `chokidar` | `fs.watch({ recursive: true })` — long supported on Windows and macOS, on Linux since Node 19.1. Verify on the Linux CI leg with a 500-file burst before deciding. | `chokidar` (what Vite uses; well-behaved on Windows). |
| JSON Schema (E9) | — | zod 4's `z.toJSONSchema`, or `zod-to-json-schema` as a **dev** dependency. Nothing ships at runtime either way. | — |

## 12. Decisions the proposals need

Each has a recommendation; a proposal proceeds on it unless overruled.

1. **Redis client** — hand-rolled RESP (recommended) or `ioredis`.
2. **Watcher** — `fs.watch` recursive (recommended, pending the Linux check) or `chokidar`.
3. **Failed-jobs source** — polling `queue:failed` (recommended: no DB driver, one PHP boot a
   minute) or off by default.
4. **Replica naming** — `api:queue#1` (recommended: `#` cannot appear in a shell command name,
   so it can never collide with a `link` target) or `api:queue-1`.
5. **`:` command line or more single keys** (T4) — the command line (recommended); the key
   table is already at the edge of what the help screen can list.
6. **Schema generation** (E9) — upgrade to zod 4 or add `zod-to-json-schema` as a dev
   dependency.
