import { describe, expect, test } from 'vitest';
import { handleKey, type Key } from '../src/tui/keys.js';
import { initialUiState, renderFrame, type RenderInput, type UiState } from '../src/tui/screen.js';
import { clip, codes } from '../src/tui/terminal.js';
import { formatDuration, formatUptime, glyphs } from '../src/tui/theme.js';
import { createPainter, stripAnsi } from '../src/cli/render/colors.js';
import type { ProcessRow, StackView } from '../src/tui/model.js';
import type { LogLine, ServiceState } from '../src/core/events/types.js';

const row = (index: number, name: string, state: ServiceState, extra: Partial<ProcessRow> = {}): ProcessRow => ({
  index,
  name,
  state,
  pid: 1000 + index,
  uptimeMs: 62_000,
  restarts: 0,
  external: false,
  autostart: true,
  probe: undefined,
  project: 'api',
  command: `php artisan ${name}`,
  cwd: 'D:/work/api',
  url: undefined,
  groups: ['workers'],
  logLines: 10,
  ...extra,
});

/** Mirrors buildStackView: externals are split out and the rest renumbered. */
const stack = (all: ProcessRow[]): StackView => {
  const dependencies = all.filter((entry) => entry.external);
  const rows = all.filter((entry) => !entry.external).map((entry, index) => ({ ...entry, index }));
  return {
    name: 'dual',
    rows,
    dependencies,
    running: rows.filter((entry) => entry.state === 'running' || entry.state === 'ready').length,
    total: rows.length,
    restarts: rows.reduce((sum, entry) => sum + entry.restarts, 0),
    failed: rows.filter((entry) => entry.state === 'failed' || entry.state === 'crashed').length,
    dependenciesDown: dependencies.filter((entry) => entry.state !== 'ready' && entry.state !== 'running').length,
  };
};

const logLine = (service: string, line: string, at = 0, stream: LogLine['stream'] = 'stdout'): LogLine => ({
  service,
  line,
  at,
  stream,
});

const input = (overrides: Partial<RenderInput> = {}): RenderInput => {
  const rows = overrides.stack?.rows ?? [
    row(0, 'redis', 'ready', { external: true }),
    row(1, 'api:serve', 'running'),
    row(2, 'api:queue', 'running', { restarts: 2 }),
    row(3, 'portal:queue', 'stopped'),
  ];
  const painter = createPainter(false);
  return {
    stack: overrides.stack ?? stack(rows),
    ui: overrides.ui ?? { ...initialUiState(), phase: 'running', note: 'Ready for commands.' },
    size: overrides.size ?? { columns: 100, rows: 30 },
    glyph: overrides.glyph ?? glyphs({ LARACREW_ASCII: '1' } as NodeJS.ProcessEnv),
    paint: overrides.paint ?? Object.assign((_c: string, text: string) => painter('gray', text), { enabled: false }),
    logs: overrides.logs ?? [],
    uptimeMs: overrides.uptimeMs ?? 927_000,
  };
};

const text = (lines: string[]): string => lines.map(stripAnsi).join('\n');

describe('overview screen', () => {
  test('shows the process tree, not a log stream', () => {
    const out = text(renderFrame(input()));

    expect(out).toContain('STACK DETAILS');
    expect(out).toContain('processes (3 managed)');
    expect(out).toContain('[0]');
    expect(out).toContain('redis');
    expect(out).toContain('api:queue');
    expect(out).toContain('running');
    expect(out).toContain('stopped');
  });

  test('header carries stack name, uptime and health', () => {
    const out = text(renderFrame(input()));
    expect(out).toContain('laracrew');
    expect(out).toContain('dual');
    expect(out).toContain(`up ${formatUptime(927_000)}`);
    expect(out).toContain('2/3 running');
    expect(out).toContain('all healthy');
  });

  test('reports failures in the header instead of "all healthy"', () => {
    const rows = [row(0, 'api:queue', 'failed')];
    const out = text(renderFrame(input({ stack: stack(rows) })));
    expect(out).toContain('1 failed');
    expect(out).not.toContain('all healthy');
  });

  test('lists externals under their own heading, out of the numbered list', () => {
    const out = text(renderFrame(input()));

    expect(out).toContain('DEPENDENT SERVICES');
    expect(out).toContain('checked, not managed');

    const redisLine = out.split('\n').find((line) => line.includes('redis'))!;
    expect(redisLine).toContain('ready');
    expect(redisLine).not.toMatch(/\[\d\]/); // no index: you cannot select or start it
  });

  test('renumbers the managed processes from zero once externals are out', () => {
    const out = text(renderFrame(input()));
    // redis was first in the fixture, so api:serve must now be [0].
    expect(out).toMatch(/\[0\][^\n]*api:serve/);
    expect(out).toMatch(/\[1\][^\n]*api:queue/);
  });

  test('shows restart counts on managed rows', () => {
    const out = text(renderFrame(input()));
    expect(out).toMatch(/api:queue.*running.*r2/s);
  });

  test('shows what each dependency is checked with', () => {
    const rows = [
      row(0, 'redis', 'ready', { external: true, probe: 'tcp 127.0.0.1:6379' }),
      row(1, 'api:queue', 'running'),
    ];
    const out = text(renderFrame(input({ stack: stack(rows) })));
    expect(out).toContain('tcp 127.0.0.1:6379');
  });

  test('a dependency that is not ready is called out in the header', () => {
    const rows = [
      row(0, 'redis', 'failed', { external: true, probe: 'tcp 127.0.0.1:6379' }),
      row(1, 'api:queue', 'running'),
    ];
    const out = text(renderFrame(input({ stack: stack(rows) })));
    expect(out).toContain('1 dependency down');
    expect(out).not.toContain('all healthy');
  });

  test('omits the heading entirely when a stack has no externals', () => {
    const rows = [row(0, 'api:queue', 'running')];
    const out = text(renderFrame(input({ stack: stack(rows) })));
    expect(out).not.toContain('DEPENDENT SERVICES');
  });

  test('handles a stack that is nothing but dependencies', () => {
    const rows = [row(0, 'redis', 'ready', { external: true })];
    const out = text(renderFrame(input({ stack: stack(rows) })));
    expect(out).toContain('DEPENDENT SERVICES');
    expect(out).toContain('nothing to manage');
  });

  test('shows uptime for live services only', () => {
    const out = text(renderFrame(input()));
    const live = out.split('\n').find((line) => line.includes('api:serve'))!;
    const dead = out.split('\n').find((line) => line.includes('portal:queue'))!;
    expect(live).toContain(formatDuration(62_000));
    expect(dead).not.toContain(formatDuration(62_000));
  });

  test('marks the selected row', () => {
    const ui: UiState = { ...initialUiState(), selected: 1, phase: 'running' };
    const out = text(renderFrame(input({ ui })));
    const line = out.split('\n').find((entry) => entry.includes('api:queue'))!;
    expect(line).toContain('>'); // ASCII pointer
  });

  test('lists the keys that are actually available', () => {
    const out = text(renderFrame(input()));
    expect(out).toContain('inspect log');
    expect(out).toContain('quit');
    expect(out).toContain('all logs');
  });

  test('scrolls the list and says how much is hidden when the terminal is short', () => {
    const rows = Array.from({ length: 20 }, (_, index) => row(index, `svc-${index}`, 'running'));
    const ui: UiState = { ...initialUiState(), selected: 15, phase: 'running' };
    const out = text(renderFrame(input({ stack: stack(rows), ui, size: { columns: 100, rows: 20 } })));

    expect(out).toContain('more above');
    expect(out).toContain('svc-15');
  });

  test('never renders log lines on the overview', () => {
    const logs = [logLine('api:queue', 'SHOULD NOT APPEAR')];
    const out = text(renderFrame(input({ logs })));
    expect(out).not.toContain('SHOULD NOT APPEAR');
  });
});

describe('log screen', () => {
  const logUi = (overrides: Partial<UiState> = {}): UiState => ({
    ...initialUiState(),
    view: 'log',
    selected: 1, // api:queue, now that redis is not in the numbered list
    phase: 'running',
    ...overrides,
  });

  test('shows the command, cwd and the tail of the log', () => {
    const logs = [logLine('api:queue', 'Processing job', 0), logLine('api:queue', 'Processed job', 1)];
    const out = text(renderFrame(input({ ui: logUi(), logs })));

    expect(out).toContain('api:queue');
    expect(out).toContain('$ php artisan api:queue');
    expect(out).toContain('D:/work/api');
    expect(out).toContain('Processing job');
    expect(out).toContain('Processed job');
  });

  test('says so when there is no output yet', () => {
    expect(text(renderFrame(input({ ui: logUi(), logs: [] })))).toContain('no output yet');
  });

  test('keeps only the last lines that fit', () => {
    const logs = Array.from({ length: 200 }, (_, index) => logLine('api:queue', `line ${index}`, index));
    const out = text(renderFrame(input({ ui: logUi(), logs, size: { columns: 100, rows: 20 } })));

    expect(out).toContain('line 199');
    expect(out).not.toContain('line 0 ');
  });

  test('scrolling back moves the window away from the tail', () => {
    const logs = Array.from({ length: 200 }, (_, index) => logLine('api:queue', `line ${index}`, index));
    const out = text(
      renderFrame(input({ ui: logUi({ scrollBack: 50, follow: false }), logs, size: { columns: 100, rows: 20 } })),
    );
    expect(out).not.toContain('line 199');
  });

  test('the merged view labels every line with its service', () => {
    const logs = [logLine('api:queue', 'from api', 1), logLine('portal:queue', 'from portal', 2)];
    const out = text(renderFrame(input({ ui: logUi({ view: 'merged' }), logs })));

    expect(out).toContain('ALL SERVICES');
    expect(out).toContain('api:queue');
    expect(out).toContain('portal:queue');
    expect(out).toContain('from api');
  });
});

describe('help and shutdown screens', () => {
  test('help explains the deliberate no-streaming default', () => {
    const ui: UiState = { ...initialUiState(), view: 'help', phase: 'running' };
    const out = text(renderFrame(input({ ui })));
    expect(out).toContain('KEYS');
    expect(out).toContain('merged log');
    expect(out).toContain('never streams logs');
  });

  test('shutdown lists each service as it stops', () => {
    const rows = [row(0, 'api:serve', 'stopping'), row(1, 'api:queue', 'stopped')];
    const ui: UiState = { ...initialUiState(), phase: 'stopping' };
    const out = text(renderFrame(input({ stack: stack(rows), ui })));

    expect(out).toContain('Stopping dual');
    expect(out).toContain('stopping…');
    expect(out).toContain('stopped');
    expect(out).toContain('ctrl-c again to force');
  });

  test('quit asks for confirmation', () => {
    const ui: UiState = { ...initialUiState(), confirmQuit: true, phase: 'running' };
    expect(text(renderFrame(input({ ui })))).toContain('Quit and stop every process?');
  });
});

describe('key handling', () => {
  const key = (name: string, extra: Partial<Key> = {}): Key => ({ name, ...extra });
  const base = (overrides: Partial<UiState> = {}): UiState => ({
    ...initialUiState(),
    phase: 'running',
    ...overrides,
  });

  test('arrows move the selection and stop at the ends', () => {
    expect(handleKey(base(), key('down'), 4).ui.selected).toBe(1);
    expect(handleKey(base({ selected: 0 }), key('up'), 4).ui.selected).toBe(0);
    expect(handleKey(base({ selected: 3 }), key('down'), 4).ui.selected).toBe(3);
  });

  test('a digit jumps to that process and opens its log', () => {
    const result = handleKey(base(), key('2'), 4);
    expect(result.ui.selected).toBe(2);
    expect(result.ui.view).toBe('log');
  });

  test('a digit beyond the list is ignored', () => {
    expect(handleKey(base(), key('9'), 4).ui.view).toBe('overview');
  });

  test('enter opens the log, escape returns to the overview', () => {
    const opened = handleKey(base(), key('return'), 4).ui;
    expect(opened.view).toBe('log');
    expect(handleKey(opened, key('escape'), 4).ui.view).toBe('overview');
  });

  test('s is stop/start on the overview and back on a log screen', () => {
    expect(handleKey(base(), key('s'), 4).command).toEqual({ type: 'toggle', index: 0 });
    expect(handleKey(base({ view: 'log' }), key('s'), 4).ui.view).toBe('overview');
  });

  test('r asks for a restart of the selected process', () => {
    expect(handleKey(base({ selected: 2 }), key('r'), 4).command).toEqual({ type: 'restart', index: 2 });
  });

  test('a toggles the merged log view', () => {
    const merged = handleKey(base(), key('a'), 4).ui;
    expect(merged.view).toBe('merged');
    expect(handleKey(merged, key('a'), 4).ui.view).toBe('overview');
  });

  test('scrolling a log turns follow off, returning to the bottom turns it back on', () => {
    const scrolled = handleKey(base({ view: 'log' }), key('up'), 4).ui;
    expect(scrolled.scrollBack).toBe(1);
    expect(scrolled.follow).toBe(false);

    const back = handleKey(scrolled, key('down'), 4).ui;
    expect(back.scrollBack).toBe(0);
    expect(back.follow).toBe(true);
  });

  test('G jumps to the bottom and re-follows, g goes to the top', () => {
    expect(handleKey(base({ view: 'log', scrollBack: 40 }), key('g', { shift: true }), 4).ui).toMatchObject({
      scrollBack: 0,
      follow: true,
    });
    expect(handleKey(base({ view: 'log' }), key('g'), 4).ui.follow).toBe(false);
  });

  test('q asks first, then y confirms', () => {
    const asked = handleKey(base(), key('q'), 4);
    expect(asked.ui.confirmQuit).toBe(true);
    expect(asked.command).toEqual({ type: 'none' });

    expect(handleKey(asked.ui, key('y'), 4).command).toEqual({ type: 'quit' });
  });

  test('anything other than y cancels the quit prompt', () => {
    const asked = handleKey(base(), key('q'), 4).ui;
    const cancelled = handleKey(asked, key('n'), 4);
    expect(cancelled.ui.confirmQuit).toBe(false);
    expect(cancelled.command).toEqual({ type: 'none' });
  });

  test('ctrl-c quits without asking, and forces during shutdown', () => {
    expect(handleKey(base(), key('c', { ctrl: true }), 4).command).toEqual({ type: 'quit' });
    expect(handleKey(base({ phase: 'stopping' }), key('c', { ctrl: true }), 4).command).toEqual({
      type: 'force-quit',
    });
  });

  test('any key dismisses help', () => {
    expect(handleKey(base({ view: 'help' }), key('x'), 4).ui.view).toBe('overview');
  });
});

describe('terminal', () => {
  test('clip respects colour codes when measuring width', () => {
    const painted = createPainter(true)('red', 'hello world');
    const clipped = clip(painted, 5);
    expect(stripAnsi(clipped)).toBe('hello');
  });

  test('clip leaves a short line alone', () => {
    expect(clip('short', 40)).toBe('short');
  });

  test('uses the alternate screen buffer so scrollback survives', () => {
    expect(codes.altScreenOn).toContain('1049h');
    expect(codes.altScreenOff).toContain('1049l');
  });
});

describe('formatting', () => {
  test('uptime is a clock', () => {
    expect(formatUptime(927_000)).toBe('00:15:27');
    expect(formatUptime(undefined)).toBe('--:--:--');
  });

  test('durations stay compact', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(62_000)).toBe('1m 02s');
    expect(formatDuration(3_720_000)).toBe('1h 02m');
  });

  test('ASCII mode avoids box-drawing characters', () => {
    const ascii = glyphs({ LARACREW_ASCII: '1' } as NodeJS.ProcessEnv);
    expect(ascii.running).toBe('*');
    expect(ascii.branch).toBe('|-');
  });
});
