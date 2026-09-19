# Architecture

## 1. Shape

```
             ~/.laracrew/**.yaml
                   │
          ┌────────▼────────┐
          │  core/config    │  load → interpolate → zod validate → resolve deps (DAG)
          └────────┬────────┘
                   │ ResolvedStack
          ┌────────▼────────┐        ┌──────────────┐
          │ core/process    │───────▶│ core/events  │  typed EventBus (the only shared truth)
          │  Supervisor     │        └──────┬───────┘
          │  ManagedProcess │               │
          └────────┬────────┘        ┌──────┴───────┬──────────────┬─────────────┐
                   │                 ▼              ▼              ▼             ▼
          core/health (gates)     tui/ (Ink)   cli/plain.ts   cli/json.ts   daemon/ipc
          core/metrics (redis, pidusage)
          core/logs   (ring buffer, file sinks)
```

**Hard rule: `core/` never imports from `tui/`.** Core emits events; every renderer is a
subscriber. That is what makes `--plain`, `--detach` and headless tests possible without a
second code path.

## 2. Modules

```
src/
  index.ts                      # bin entry, error boundary, exit codes
  cli/
    program.ts                  # commander wiring
    commands/{init,scan,doctor,ls,up,down,status,logs,restart,run,open,edit}.ts
    render/
      colors.ts                 # NO_COLOR/FORCE_COLOR aware painter, stripAnsi, padEnd
      plain.ts                  # prefixed interleaved logs (non-TTY / CI)
      output.ts                 # broken-pipe guard: EPIPE closes output and stops the stack
  core/
    config/
      paths.ts                  # ~/.laracrew resolution, XDG-ish overrides, LARACREW_HOME
      load.ts                   # yaml parse w/ source positions, extends, fragments
      interpolate.ts            # ${env:…} ${project.path} ${project.env:…} ${stack.dir} ${port:…}
      schema.ts                 # zod schemas + inferred types
      resolve.ts                # projects+services -> ResolvedStack, DAG build, cycle detect
      errors.ts                 # file:line:col diagnostics with suggestions
    process/
      supervisor.ts             # start/stop orchestration over the DAG, restart policy
      managed-process.ts        # one child: spawn, stdio, state machine, backoff timer
      stop.ts                   # graceful stop ladder (artisan → signal → tree-kill)
      spawn.ts                  # execa wrapper, shell vs array cmd, env merge, cwd
    health/
      probes.ts                 # tcp | http | logMatch | delay
      wait.ts                   # gate with timeout + progress events
    logs/
      ring-buffer.ts            # bounded per-service buffer
      sanitize.ts               # strip cursor/erase ANSI, keep SGR colour
      file-sink.ts              # ~/.laracrew/logs/<stack>/<date>/<service>.log + rotation
    laravel/
      detect.ts                 # artisan file, composer.json packages, Horizon/Octane/Reverb…
      env.ts                    # .env parser (no dotenv side effects)
      artisan.ts                # queue:restart, horizon:terminate, failed count
    metrics/
      sampler.ts                # pidusage polling, CPU/RSS, sparkline history
      redis.ts                  # LLEN per queue, XINFO GROUPS per stream, lazy ioredis
    watch/
      watcher.ts                # chokidar per service, debounce, strategy dispatch
    tasks/
      runner.ts                 # ordered/parallel steps, pauseServices, dry-run
    events/
      bus.ts, types.ts          # discriminated union of every event
  tui/
    App.tsx  Dashboard.tsx  ProcessList.tsx  LogPane.tsx  MergedLogs.tsx
    MetricsPanel.tsx  DetailPanel.tsx  Footer.tsx  HelpOverlay.tsx  ShutdownScreen.tsx
    hooks/{useEventStream,useKeymap,useViewport,useThrottledLines}.ts
    theme.ts
  daemon/
    server.ts                   # detached supervisor host
    ipc.ts                      # named pipe (win32) / unix socket, newline-delimited JSON
    client.ts                   # used by status/logs/attach/down
```

## 3. Process state machine

```
queued ──▶ starting ──▶ ready ──▶ running ──┬─▶ stopping ──▶ stopped
             │            │                 │
             │            └─ gate timeout ──┤
             └─────────────────────────────▶ crashed ──▶ backoff ──▶ starting
                                                   └─ maxRestarts ─▶ failed
```

- `ready` only exists when the service declares a `ready` probe; otherwise `starting → running`.
- `crashed` is a non-zero exit **or** a zero exit for a service whose `restart: always`.
- Backoff is `min(initialMs * factor^n, maxMs)`, reset to `n=0` after the service has stayed up
  for 60 s (otherwise a flapping worker escalates forever).
- Manual stop sets an `intentional` flag so the restart policy is skipped.

## 4. Stop ladder (`core/process/stop.ts`)

Ordered, each step only if the previous timed out:

1. **Laravel graceful** — if `stop.artisan` is set, run it in a short-lived child
   (`php artisan queue:restart` / `horizon:terminate`) and wait up to `graceMs` for the worker to
   exit on its own. This is the only way to avoid killing a job mid-flight.
2. **Signal** — POSIX: `SIGTERM`. Windows: there is no real equivalent, so skip to 3.
3. **Tree kill** — `tree-kill(pid, 'SIGKILL')`, which on Windows shells out to
   `taskkill /pid <pid> /T /F`. Required: `php artisan serve` spawns a child PHP server and
   `npm run dev` spawns Vite; killing only the parent orphans them and the port stays bound.
4. **Verify** — re-check the pid; log a loud warning if anything survives.

Shutdown of a whole stack runs in **reverse topological order**, with independent leaves in parallel.

## 5. Log pipeline

`child stdout/stderr` → line splitter (handles partial chunks) → `sanitize` (strip cursor motion,
keep SGR) → timestamp → `RingBuffer.push` → `EventBus.emit('log')`.

The TUI does **not** re-render per line. `useThrottledLines` batches at ~60 ms and renders only
the visible window of the buffer. Backpressure ceiling: default 5000 lines per service in memory,
with the full stream going to the file sink when `logs.toFile` is on.

**Broken pipes.** `laracrew up --json | head` closes stdout under us. Node turns that into an
unhandled `'error'` event, which kills the process *without* running the shutdown path and
orphans every child. `cli/render/output.ts` intercepts EPIPE, stops writing, and notifies
subscribers so `up` shuts the stack down cleanly and exits 0 — the same thing `head` itself does.

## 6. Daemon and IPC (M5)

- `laracrew up --detach` spawns `node dist/daemon/server.js` fully detached (`detached: true`,
  `stdio: 'ignore'`, `unref()`), writes `~/.laracrew/run/<stack>.json` with pid + pipe path.
- Transport: `\\.\pipe\laracrew-<stack>` on Windows, `~/.laracrew/run/<stack>.sock` elsewhere.
- Protocol: newline-delimited JSON, identical to `--json` output, plus request frames
  (`{"cmd":"restart","service":"api:queue"}`).
- `laracrew attach` is the TUI bound to an IPC event stream instead of a local Supervisor — same
  components, different source. This falls out for free from the core/tui separation.

## 7. Windows notes

- Default shell for string `cmd` is `cmd.exe`; array form bypasses shell parsing and is preferred
  for anything with quotes or spaces. `laracrew scan` always generates the array form.
- Paths from config are normalised, but `cwd` is passed through as-is so PHP resolves relative
  `.env` includes correctly.
- Port checks use a real bind attempt, not `netstat` parsing.
- Console is switched to UTF-8 for the box-drawing glyphs; fall back to ASCII glyphs when
  `chcp` reports a legacy code page or `LARACREW_ASCII=1`.

## 8. Testing

| Layer | Approach |
|---|---|
| config | Golden-file tests: YAML in, resolved stack or formatted diagnostic out |
| supervisor | `fixtures/fake-artisan.mjs` — a script that can log, hang, exit(1), or ignore signals on demand; assert state transitions and that no pid survives |
| stop ladder | Spawn a process tree 2 deep, assert all pids gone after `down` |
| logs | Fuzz partial chunks and embedded ANSI, assert clean line output |
| health | Local http/tcp servers that answer late, then assert gate timing |
| tui | `ink-testing-library` snapshots at 3 viewport widths (80 / 100 / 140) |
| metrics | Fake ioredis client; assert graceful degradation when Redis is down |

CI matrix: windows-latest + ubuntu-latest, Node 20 and 22.

## 9. Dependencies (keep this list short)

**Shipped today (M0–M1):** `commander`, `yaml`, `zod`. That is the whole runtime dependency list.

Three planned dependencies were dropped once written, and should stay dropped:

| Dropped | Replaced by | Why |
|---|---|---|
| `execa` | `node:child_process` + `core/process/spawn.ts` | We need only two spawn shapes, and the Windows `.cmd` shim handling is explicit either way |
| `tree-kill` | `core/process/stop.ts` | Nine lines: `taskkill /T /F` on Windows, process-group kill on POSIX. Owning it keeps the stop ladder readable |
| `picocolors` | `cli/render/colors.ts` | 40 lines including `NO_COLOR` / `FORCE_COLOR` handling and `stripAnsi` |

**Still to add, per milestone:** `ink` + `react` (M2), `chokidar` (M4), `pidusage` and `ioredis`
(M3, both lazily loaded so the tool works with Redis down).

Dev: `typescript`, `tsup`, `tsx`, `vitest`; `ink-testing-library` arrives with M2.

Anything else needs a justification in the PR — startup time is a feature for a tool you run
twenty times a day. Budget: **cold `laracrew --version` under 150 ms**.
