# CLAUDE.md — laracrew

## What this project is

`laracrew` is a Node.js CLI + TUI **process orchestrator for Laravel developers** who run
several interconnected Laravel apps at once (each with its own queue workers, Redis
stream listeners, schedulers, Vite, Horizon, Reverb...).

One command (`laracrew up dual`) boots the whole fleet, supervises it, and renders a live
process tree: per-process status, uptime and restarts, with logs opened one process at a time.
`laracrew link dual` turns that into a single global command: `dual`.

**Read `.claude/PLAN.md` first.** It is the source of truth for scope and milestones.

| Doc | Contents |
|---|---|
| [.claude/PLAN.md](.claude/PLAN.md) | Vision, scope, milestones, acceptance criteria, risks |
| [.claude/ARCHITECTURE.md](.claude/ARCHITECTURE.md) | Module layout, supervisor state machine, log pipeline, daemon IPC |
| [.claude/CONFIG-SPEC.md](.claude/CONFIG-SPEC.md) | `~/.laracrew` layout, YAML schema, worked examples |
| [.claude/TUI-UX.md](.claude/TUI-UX.md) | Screen mockups, keybindings, colour semantics, plain mode |

## Stack

- Node **>= 20**, TypeScript (ESM, `NodeNext`), strict mode
- Runtime dependencies, all of them: `commander`, `yaml`, `zod`
- Process spawning and tree-killing are hand-rolled on `node:child_process` — see
  [.claude/ARCHITECTURE.md](.claude/ARCHITECTURE.md) §9 for why `execa`/`tree-kill`/`picocolors` were dropped
- `tsup` (build), `tsx` (dev), `vitest` (tests)
- The TUI is plain ANSI on `node:readline` — no Ink, no React (see .claude/TUI-UX.md §1)
- Coming per milestone: `ioredis` (M3, lazy), `chokidar` (M4)
- Published as `laracrew` on npm; binary `laracrew`; config home `~/.laracrew/`

`vitest` is the runner. The original reason (JSX for Ink) is gone, so `node:test` would now
work too — not worth the churn, but don't add dependencies to justify it.

## Layout (target)

```
src/
  cli/          command registry, arg parsing, output for non-TTY
  core/
    config/     discovery, YAML load, zod schema, interpolation, profiles
    process/    Supervisor, ManagedProcess, restart policy, graceful stop
    logs/       ring buffer, ANSI-safe chunking, file sinks
    health/     tcp / http / log-match / artisan readiness probes
    laravel/    project detection, .env reader, artisan helpers
    metrics/    redis queue depth, stream consumer lag (M3)
    events/     typed event bus (single source of truth for TUI + daemon)
  tui/          screen.ts + keys.ts are pure functions; terminal.ts drives raw ANSI
  daemon/       detached supervisor + IPC server (named pipe / unix socket)
```

## Conventions

- **Nothing in `core/` may import from `tui/`.** Core emits typed events; TUI and plain
  renderer are both just subscribers. This is what keeps `--plain`, `--detach` and tests honest.
- **`tui/screen.ts` and `tui/keys.ts` stay pure.** Screens are `(state) => string[]` and keys are
  `(state, key) => { state, command }`. That is why every screen is unit-tested with no harness.
- **The overview never renders log lines.** The TUI polls at 250ms instead of subscribing to log
  events, so output volume cannot drive repaint cost. Don't "improve" this into a live tail.
- Every feature must work in three output modes: **TUI**, **`--plain`** (piped/CI), **`--json`**.
- Windows is a first-class target. Never assume POSIX signals — always stop through
  `core/process/stop.ts`, which knows about `taskkill /T` and artisan-aware shutdown.
- User config lives in `~/.laracrew/`, never inside the Laravel projects. The tool is
  read-only with respect to project source.
- Config errors must name the file, the line, and the fix. No raw zod dumps.

## Commands

```bash
npm run dev        # tsx src/index.ts -- <args>
npm run build      # tsup -> dist/index.js (single bundled ESM file with a shebang)
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm link           # expose `laracrew` on PATH while developing
```

Tests spawn real children and bind real ports, so `vitest.config.ts` sets
`fileParallelism: false`. Every test uses a throwaway `LARACREW_HOME` via `TempHome`
(see [test/helpers.ts](test/helpers.ts)) and must leave no live process behind.

## Working agreements

- Implement milestone by milestone (M0 -> M6 in PLAN.md); don't start a milestone before the
  previous one's acceptance criteria pass.
- Any change to config shape updates `.claude/CONFIG-SPEC.md` **and** the generated JSON Schema
  in the same change.
- Prefer a fixture Laravel-ish project under `fixtures/` (fake `artisan` script that sleeps and
  logs) over requiring a real Laravel app in tests.
