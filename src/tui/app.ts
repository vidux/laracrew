import type { EventBus } from '../core/events/bus.js';
import type { Supervisor } from '../core/process/supervisor.js';
import { createPainter, supportsColor, type ColorName } from '../cli/render/colors.js';
import { buildStackView, logsFor, mergedLogs } from './model.js';
import { handleKey, type Command } from './keys.js';
import { initialUiState, renderFrame, type Painter, type UiState } from './screen.js';
import { Terminal } from './terminal.js';
import { glyphs } from './theme.js';

export interface TuiOptions {
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  env?: NodeJS.ProcessEnv;
  /** Repaint interval. 250ms keeps uptime ticking without burning CPU. */
  frameMs?: number;
}

const MAX_LOG_LINES = 400;

/**
 * The whole UI: poll the supervisor, render a frame, handle keys. Deliberately a loop and not
 * an event stream — a worker emitting 500 lines/s must not cause 500 repaints.
 */
export const runTui = async (
  supervisor: Supervisor,
  bus: EventBus,
  options: TuiOptions = {},
): Promise<number> => {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const terminal = new Terminal({
    stdout,
    ...(options.stdin ? { stdin: options.stdin } : {}),
  });

  const basePainter = createPainter(supportsColor(stdout, env));
  const paint: Painter = Object.assign(
    (color: string, text: string) => basePainter(color as ColorName, text),
    { enabled: basePainter.enabled },
  );

  const glyph = glyphs(env);
  const startedAt = Date.now();

  let ui: UiState = initialUiState();
  let exitCode = 0;
  let stopping = false;
  let finished = false;

  const setNote = (note: string): void => {
    ui = { ...ui, note };
  };

  // Lifecycle events become the one-line status note; log events are ignored here on purpose.
  const unsubscribe = bus.subscribe((event) => {
    switch (event.type) {
      case 'stack:ready':
        ui = { ...ui, phase: 'running' };
        setNote(`Ready in ${(event.durationMs / 1000).toFixed(1)}s. Awaiting keyboard input…`);
        break;
      case 'service:restart':
        setNote(`${event.service} restarting in ${event.delayMs}ms (attempt ${event.attempt}/${event.maxAttempts})`);
        break;
      case 'service:exit':
        if (!event.intentional) {
          setNote(`${event.service} exited with ${event.signal ? `signal ${event.signal}` : `code ${event.code}`}`);
        }
        break;
      case 'notice':
        if (event.level !== 'info') setNote(`${event.service ? `${event.service}: ` : ''}${event.message}`);
        break;
      default:
        break;
    }
  });

  const draw = (): void => {
    const stack = buildStackView(supervisor);
    const selectedRow = stack.rows[ui.selected];

    const logs =
      ui.view === 'log' && selectedRow
        ? logsFor(supervisor, selectedRow.name, MAX_LOG_LINES)
        : ui.view === 'merged'
          ? mergedLogs(supervisor, MAX_LOG_LINES)
          : [];

    terminal.paint(
      renderFrame({
        stack,
        ui,
        size: terminal.size,
        glyph,
        paint,
        logs,
        uptimeMs: Date.now() - startedAt,
      }),
    );
  };

  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    ui = { ...ui, phase: 'stopping' };
    draw();
    await supervisor.down(reason);
    finished = true;
  };

  const perform = (command: Command): void => {
    const stack = buildStackView(supervisor);
    const row = stack.rows[command.type === 'none' || command.type === 'quit' || command.type === 'force-quit' ? ui.selected : command.index];

    switch (command.type) {
      case 'quit':
        void shutdown('user quit');
        break;

      case 'force-quit':
        // Second ctrl-c during shutdown: stop waiting.
        terminal.stop();
        process.exit(130);
        break;

      case 'restart':
        if (!row) break;
        setNote(`restarting ${row.name}…`);
        void supervisor
          .restart(row.name)
          .then(() => setNote(`${row.name} restarted`))
          .catch((error: unknown) => setNote(`restart failed: ${error instanceof Error ? error.message : String(error)}`));
        break;

      case 'toggle': {
        if (!row) break;
        if (row.external) {
          setNote(`${row.name} is external — laracrew does not start or stop it`);
          break;
        }
        const live = row.state === 'running' || row.state === 'ready' || row.state === 'starting';
        setNote(`${live ? 'stopping' : 'starting'} ${row.name}…`);
        const action = live ? supervisor.stopService(row.name) : supervisor.startService(row.name);
        void action
          .then(() => setNote(`${row.name} ${live ? 'stopped' : 'started'}`))
          .catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error)));
        break;
      }

      default:
        break;
    }
  };

  terminal.start({
    onKey: (key) => {
      // Externals are not in the selectable list, so bound by managed rows only.
      const rowCount = buildStackView(supervisor).rows.length;
      const result = handleKey(ui, key, rowCount);
      ui = result.ui;
      perform(result.command);
      draw();
    },
    onResize: draw,
  });

  const timer = setInterval(draw, options.frameMs ?? 250);
  timer.unref?.();

  const onSignal = (): void => {
    void shutdown('received signal');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  draw();

  try {
    await supervisor.up();
  } catch (error) {
    ui = { ...ui, phase: 'running' };
    setNote(error instanceof Error ? error.message : String(error));
    exitCode = 1;
    draw();
  }

  // Idle until the user quits or every service has finished on its own.
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (finished) {
        clearInterval(check);
        resolve();
        return;
      }
      if (stopping) return;
      const anyLive = supervisor.processes.some(
        (managed) => managed.state !== 'stopped' && managed.state !== 'failed',
      );
      if (!anyLive) {
        clearInterval(check);
        void shutdown('all services finished').then(resolve);
      }
    }, 200);
    check.unref?.();
  });

  clearInterval(timer);
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  unsubscribe();
  terminal.stop();

  return exitCode;
};
