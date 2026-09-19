# TUI / UX spec

> Status: **built** (M2). This describes what exists, not a target.

Three output modes, one event source. The full-screen view is the default when stdout is a TTY;
`--plain` and `--json` are peers, not afterthoughts.

## 0. The governing decision

**The default screen never streams logs.**

A wall of interleaved output from nine services is unreadable — you cannot see the shape of the
fleet, and you cannot follow any single process. So the default view is the *process tree*: what
exists, what state it is in, how long it has been up, how often it has restarted. Logs are
opened deliberately, one process at a time.

Everything else follows from that:

- The overview renders **zero** log lines, so a worker emitting 500 lines/s costs nothing to display.
- Rendering is a **250 ms poll**, not an event subscription. Log volume and repaint rate are
  completely decoupled.
- The ring buffers already hold history, so opening a log shows the backlog immediately.

## 1. No framework

Plain ANSI on `node:readline`, about 150 lines in [`terminal.ts`](../src/tui/terminal.ts).
Ink + React was installed, evaluated and removed: a React reconciler and ~100 packages to
repaint a fixed list of ten rows twice a second is the wrong trade for this project, which
already hand-rolls process spawning and colour for the same reason.

What we actually need, and what the terminal gives us natively:

| Need | Mechanism |
|---|---|
| Full screen without destroying scrollback | alternate screen buffer (`ESC[?1049h` / `l`) |
| Flicker-free repaint | home the cursor, write only changed rows, `ESC[K` to end-of-line |
| Keys | `readline.emitKeypressEvents` + `setRawMode` |
| Resize | `stdout.on('resize')`, drop the frame cache, repaint |

## 2. Module shape

| File | Responsibility |
|---|---|
| [`screen.ts`](../src/tui/screen.ts) | **Pure**: `(state) => string[]`. Every screen. No terminal, no timers. |
| [`keys.ts`](../src/tui/keys.ts) | **Pure**: `(state, key) => { state, command }`. |
| [`terminal.ts`](../src/tui/terminal.ts) | Alt screen, raw mode, diffed repaint, width-aware clipping. |
| [`model.ts`](../src/tui/model.ts) | Polls the supervisor into a render-ready view. |
| [`theme.ts`](../src/tui/theme.ts) | Glyphs (with an ASCII fallback), state colours, time formatting. |
| [`app.ts`](../src/tui/app.ts) | The loop: poll, render, dispatch keys, own the shutdown. |

Because the first two are pure functions, every screen and every keystroke is unit-tested
without a terminal harness — see [`test/tui.test.ts`](../../test/tui.test.ts).

## 3. The overview (default)

```
  laracrew · dual                                     up 00:00:01  · 4/4 running  all healthy
  ────────────────────────────────────────────────────────────────────────────────────────────
  up/down select   enter inspect log   0-9 jump   r restart   s stop/start   a all logs
  ? help   q quit
  STACK DETAILS (process tree)

  DEPENDENT SERVICES (checked, not managed)
      ● redis          ready      tcp 127.0.0.1:6379

  processes (4 managed)
  │
  ├─ ▸ [0] ● api:serve     running    1s
  ├─   [1] ● api:queue     running    1s      ⟳2
  ├─   [2] ● api:streams   running    1s
  └─   [3] ◼ portal:queue  stopped
  │
  └─ Ready in 0.1s. Awaiting keyboard input…
```

**`external: true` services sit above the tree, not in it.** They are health-checked, never
started or stopped, so giving them an index would imply you could act on them. Keeping them out
also means a digit key always lands on something laracrew can actually control, and the
`N/M running` count is about processes it owns. A dependency that is not ready is called out in
the header as `1 dependency down`, ahead of any other status.

- Header: stack name, wall-clock uptime, running/total, total restarts, health.
  Health reads `N failed` in red the moment anything is down, never a cheerful "all healthy".
- Each row: index, state glyph, name, state word, uptime (live services only), restart count.
- Dependencies show the probe they are checked with, e.g. `tcp 127.0.0.1:6379`.
- The bottom line is a single status note: the last thing that happened.
- When the list is taller than the terminal it scrolls around the selection and says
  `N more above` / `N more below`.

**No CPU or memory columns.** They were specced, then cut: `wmic` is gone from current Windows
builds so `pidusage` silently fails there, and the number answers no question you actually have
while developing. What matters is *is it up, and has it been restarting*.

## 4. Inspecting one process

`enter` on the selection, or a digit to jump straight there.

```
  laracrew · dual                                     up 00:00:02  · 5/5 running  all healthy
  ────────────────────────────────────────────────────────────────────────────────────────────
  esc back to stack   up/down scroll   g/G top/bottom   f follow   r restart   q quit
  api:queue   running  · pid 14184  · up 2s
  $ php artisan queue:work redis --queue=high,default
  D:/work/api
  ────────────────────────────────────────────────────────────────────────────────────────────
  08:51:30 | Processing: App\Jobs\SyncOrder
  08:51:30 | Processed:  App\Jobs\SyncOrder (412ms)
  08:51:31 | Processing: App\Jobs\NotifyPortal
```

Header carries the state, pid, uptime, the exact command and the working directory — the three
things you want when something is misbehaving. stderr lines are red. Scrolling up stops the
tail; returning to the bottom resumes it.

`a` gives the merged view across every service, each line prefixed with its service name — the
old `--plain` firehose, but on demand rather than by default.

## 5. Keys

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k` | Move the selection (scroll, in a log view) |
| `0`–`9` | Jump to that process **and** open its log |
| `enter` / `v` | Inspect the selected process |
| `esc` / `s` | Back to the overview (`s` is stop/start on the overview) |
| `a` | Merged log across every service |
| `r` | Restart the selected process (graceful) |
| `t` | Toggle: stop if running, start if stopped |
| `f` | Follow / pause tailing |
| `g` / `G` | Top / bottom of a log |
| `pgup` / `pgdn`, `home` / `end` | Page and jump |
| `?` | Help |
| `q` | Quit — asks first, then stops everything |
| `ctrl-c` | Quit without asking; again during shutdown to force |

## 6. Status vocabulary

| Glyph | Colour | State |
|---|---|---|
| `○` | dim | queued |
| `◐` | yellow | starting / stopping / restarting |
| `●` | cyan | ready (external, health-checked only) |
| `●` | green | running |
| `◼` | dim | stopped by you |
| `✖` | red | crashed or failed |

Colour is never the only signal — the glyph and the state word always agree, so a mono terminal
loses nothing. `LARACREW_ASCII=1` (or `TERM=dumb`) swaps in an ASCII glyph set for terminals
that mangle box drawing.

## 7. Shutdown

Quitting is where process managers leave orphans, so it is a visible screen:

```
  Stopping dual…

  ✔ api:vite        stopped
  ◐ api:queue       stopping…
  ◐ portal:queue    stopping…

  ctrl-c again to force
```

Underneath, that is the stop ladder from ARCHITECTURE.md §4 running in reverse dependency order.

## 8. `--plain` mode

For pipes, CI, and terminals that do not do TTY well. Selected automatically when stdout is not
a TTY, so `laracrew up dual | tee log.txt` does the right thing with no flag.

```
14:22:01 api:queue      | Processing: App\Jobs\SyncOrder
14:22:01 api:streams    | consumed 4 entries from orders
14:22:02 laracrew       | api:queue crashed (exit 1), restarting in 2s (attempt 2/10)
```

## 9. `--json` mode

One JSON object per line: `{"type":"service:log"|"service:state"|…}`. This is the same shape the
daemon's IPC stream will carry in M5, so `status --json` and a future editor plugin share one
contract. A closed pipe (`| head`) is handled as "the reader left" — stop writing, shut the
stack down, exit 0.
