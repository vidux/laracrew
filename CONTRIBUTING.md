# Contributing

Thanks for looking. This is a small, opinionated tool — the fastest way to get a change merged
is to match the decisions already made rather than work around them.

## Getting set up

```bash
git clone <repo> && cd laracrew
npm install
npm run dev -- up example     # runs from source via tsx, no build step
npm test
npm run typecheck
npm link                      # puts `laracrew` on your PATH, pointing at your working copy
```

After `npm link`, run `npm run build` whenever you want the global `laracrew` to pick up your
changes — the shim runs `dist/index.js`, not the TypeScript source.

## The four rules

These are not style preferences; breaking them breaks a feature.

**1. Nothing in `src/core/` may import from `src/cli/` or `src/tui/`.**
Core emits typed events. The process tree, the plain renderer, the JSON renderer and the coming
daemon are all just subscribers. This is what makes `--plain`, `--json` and headless tests
possible without a second code path.

**2. `tui/screen.ts` and `tui/keys.ts` stay pure.**
Screens are `(state) => string[]`. Keys are `(state, key) => { state, command }`. That purity is
why every screen and every keystroke is unit-tested with no terminal harness. Put side effects
in `tui/app.ts`.

**3. The process tree never renders log lines.**
The UI polls every 250 ms instead of subscribing to log events, so output volume cannot drive
repaint cost. Do not "improve" the overview into a live tail — that is the problem this design
exists to solve.

**4. Every kill is a tree kill, through `core/process/stop.ts`.**
`php artisan serve` spawns a child PHP server; `npm run dev` spawns Vite. Killing the parent
orphans them and leaves the port bound. Never call `child.kill()` directly.

## Dependencies

Runtime dependencies are `commander`, `yaml` and `zod`. That is the whole list, and adding to it
needs a justification in the PR.

`execa`, `tree-kill`, `picocolors` and `ink` were each installed, used, and removed in favour of
about sixty lines we own — see [.claude/ARCHITECTURE.md](.claude/ARCHITECTURE.md) §9. Startup
time is a feature for a tool you run twenty times a day; the budget is **cold `laracrew
--version` under 150 ms**.

## Tests

```bash
npm test                      # everything
npx vitest run test/tui.test.ts
npx vitest                    # watch
```

The suite spawns real child processes and binds real ports, so `vitest.config.ts` sets
`fileParallelism: false`.

Two things every test must do:

- Use a throwaway `LARACREW_HOME` via `TempHome` (see [test/helpers.ts](test/helpers.ts)). Never
  touch the real one.
- Leave no live process behind. `test/supervisor.test.ts` asserts on pids directly, including a
  deliberately spawned grandchild and a process that ignores `SIGTERM`.

Everything under `examples/` ships in the npm tarball, so `test/examples.test.ts` validates each
one against the real schema — names match their folders, `needs:` resolves, profile selectors
hit something real, and no auto-started service depends on a manual one. Add an example and it
is checked automatically.

For anything that supervises a process, drive `fixtures/fake-artisan.mjs` rather than requiring
a real Laravel app. It can log on an interval, exit with a chosen code, hang, ignore signals, or
spawn a child of its own.

## Changing the config shape

A change to what `stack.yaml` accepts touches four places, and all four belong in the same
commit:

1. `src/core/config/schema.ts` — the zod schema
2. `src/core/config/errors.ts` — add the key to `KNOWN_SERVICE_KEYS` / `KNOWN_STACK_KEYS` so
   "did you mean" keeps working
3. `.claude/CONFIG-SPEC.md` — the reference table
4. `README.md` — if a user would need to know

Config errors must name the file, the field and the fix. No raw zod output ever reaches a user.

## Windows

Windows is a first-class target, not an afterthought — it is where most of the sharp edges are.
If you do not develop on it, say so in the PR so someone can check:

- There are no POSIX signals. Graceful shutdown goes through the artisan path, then `taskkill /T /F`.
- `npm`, `npx` and friends are `.cmd` shims that cannot be spawned without a shell.
- Paths contain spaces. Prefer the argv form of `cmd:` over a shell string.
- `wmic` no longer exists on current builds — do not reach for anything that depends on it.

## Commits and PRs

Explain *why* in the body, not just what. State what you verified, and paste the output if it is
short. If a test fails, say so.

## Milestones

Work proceeds milestone by milestone; `.claude/PLAN.md` is the source of truth for scope. M0–M2
are done. If you want to take on part of M3 (project discovery, queue depth, stream lag), open an
issue first so two people don't build the same thing.
