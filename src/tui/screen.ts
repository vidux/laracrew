import type { LogLine } from '../core/events/types.js';
import { stripAnsi } from '../cli/render/colors.js';
import type { ProcessRow, StackView } from './model.js';
import { STATE_STYLE, formatClock, formatDuration, formatUptime, type Glyphs } from './theme.js';

/**
 * Pure rendering: state in, lines of text out. No terminal, no timers, no framework — which
 * makes every screen directly unit-testable and keeps a repaint to one string write.
 */

export type ViewName = 'overview' | 'log' | 'merged' | 'help';

export interface UiState {
  view: ViewName;
  selected: number;
  /** Log views stick to the bottom until you scroll up. */
  follow: boolean;
  scrollBack: number;
  confirmQuit: boolean;
  phase: 'booting' | 'running' | 'stopping';
  note: string;
}

export const initialUiState = (): UiState => ({
  view: 'overview',
  selected: 0,
  follow: true,
  scrollBack: 0,
  confirmQuit: false,
  phase: 'booting',
  note: 'Booting…',
});

export interface Size {
  columns: number;
  rows: number;
}

export interface Painter {
  (color: string, text: string): string;
  enabled: boolean;
}

export interface RenderInput {
  stack: StackView;
  ui: UiState;
  size: Size;
  glyph: Glyphs;
  paint: Painter;
  /** Lines for the log views; ignored by the overview. */
  logs: LogLine[];
  uptimeMs: number;
}

const pad = (text: string, width: number): string => {
  const visible = stripAnsi(text).length;
  return visible >= width ? text : text + ' '.repeat(width - visible);
};

const truncate = (text: string, width: number): string => {
  if (width <= 1) return '';
  return stripAnsi(text).length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
};

const rule = (width: number, glyph: Glyphs): string => glyph.rule.repeat(Math.max(0, width));

// ---------------------------------------------------------------- header

const header = ({ stack, ui, size, paint, glyph, uptimeMs }: RenderInput): string[] => {
  const title = `laracrew ${glyph.dot} ${stack.name}`;
  const health =
    stack.failed > 0
      ? paint('red', `${stack.failed} failed`)
      : stack.dependenciesDown > 0
        ? paint('red', `${stack.dependenciesDown} dependency down`)
        : ui.phase === 'booting'
          ? paint('yellow', 'booting')
          : paint('green', 'all healthy');

  const idle = stack.rows.filter((entry) => !entry.autostart && entry.state === 'queued').length;
  const right = [
    `up ${formatUptime(uptimeMs)}`,
    `${stack.running}/${stack.total} running`,
    idle > 0 ? `${idle} idle` : '',
    stack.restarts > 0 ? `${glyph.restart}${stack.restarts}` : '',
  ]
    .filter(Boolean)
    .join(`  ${glyph.dot} `);

  const left = `  ${paint('bold', title)}`;
  const gap = Math.max(1, size.columns - stripAnsi(left).length - stripAnsi(right).length - stripAnsi(health).length - 5);

  return [
    '',
    `${left}${' '.repeat(gap)}${paint('gray', right)}  ${health}`,
    paint('gray', `  ${rule(Math.max(0, size.columns - 4), glyph)}`),
  ];
};

// ---------------------------------------------------------------- key legend

const KEYS: Record<ViewName, [string, string][]> = {
  overview: [
    ['up/down', 'select'],
    ['enter', 'inspect log'],
    ['0-9', 'jump'],
    ['r', 'restart'],
    ['s', 'stop/start'],
    ['a', 'all logs'],
    ['?', 'help'],
    ['q', 'quit'],
  ],
  log: [
    ['esc', 'back to stack'],
    ['up/down', 'scroll'],
    ['g/G', 'top/bottom'],
    ['f', 'follow'],
    ['r', 'restart'],
    ['q', 'quit'],
  ],
  merged: [
    ['esc', 'back to stack'],
    ['up/down', 'scroll'],
    ['g/G', 'top/bottom'],
    ['f', 'follow'],
    ['q', 'quit'],
  ],
  help: [['any key', 'back']],
};

const legend = ({ ui, paint, size }: RenderInput): string[] => {
  const pairs = KEYS[ui.view].map(([key, label]) => `${paint('cyan', key)} ${paint('gray', label)}`);

  const lines: string[] = [];
  let current = '  ';
  let currentWidth = 2;
  for (const pair of pairs) {
    const width = stripAnsi(pair).length + 3;
    if (currentWidth + width > size.columns - 2 && currentWidth > 2) {
      lines.push(current);
      current = '  ';
      currentWidth = 2;
    }
    current += `${pair}   `;
    currentWidth += width;
  }
  if (currentWidth > 2) lines.push(current);
  return lines;
};

// ---------------------------------------------------------------- overview

const processLine = (
  row: ProcessRow,
  isSelected: boolean,
  isLast: boolean,
  nameWidth: number,
  { paint, glyph, size }: RenderInput,
): string => {
  const style = STATE_STYLE[row.state];
  const branch = isLast ? glyph.lastBranch : glyph.branch;
  const pointer = isSelected ? paint('cyan', glyph.pointer) : ' ';
  const name = isSelected ? paint('cyan', pad(row.name, nameWidth)) : pad(row.name, nameWidth);

  // A service that was never meant to launch reads as "idle", not "queued" — it is not
  // waiting for anything, it is waiting for you.
  const manual = !row.autostart && row.state === 'queued';
  const label = manual ? 'idle' : style.label.toLowerCase();
  const labelColor = manual ? 'gray' : style.color;

  const detail = row.external
    ? paint('gray', 'external')
    : manual
      ? paint('cyan', 'press s')
      : row.state === 'running' || row.state === 'ready'
        ? paint('gray', formatDuration(row.uptimeMs))
        : '';

  const restarts = row.restarts > 0 ? paint('yellow', ` ${glyph.restart}${row.restarts}`) : '';

  const line =
    `  ${paint('gray', branch)} ${pointer} ${paint('gray', `[${row.index}]`)} ` +
    `${paint(labelColor, glyph[style.glyph])} ${name}` +
    `${paint(labelColor, pad(label, 11))}${pad(detail, 9)}${restarts}`;

  return truncate(line, size.columns + (line.length - stripAnsi(line).length));
};

/** Health-checked, never managed — so no index and no branch glyph. */
const dependencyLine = (row: ProcessRow, nameWidth: number, { paint, glyph, size }: RenderInput): string => {
  const style = STATE_STYLE[row.state];
  const label = row.state === 'ready' || row.state === 'running' ? 'ready' : style.label.toLowerCase();
  const color = row.state === 'ready' || row.state === 'running' ? 'green' : style.color;

  const line =
    `      ${paint(color, glyph[style.glyph])} ${pad(row.name, nameWidth)}` +
    `${paint(color, pad(label, 11))}${paint('gray', row.probe ?? '')}`;

  return truncate(line, size.columns + (line.length - stripAnsi(line).length));
};

const dependencies = (input: RenderInput, nameWidth: number): string[] => {
  const { stack, paint } = input;
  if (stack.dependencies.length === 0) return [];

  return [
    `  ${paint('bold', 'DEPENDENT SERVICES')} ${paint('gray', '(checked, not managed)')}`,
    ...stack.dependencies.map((row) => dependencyLine(row, nameWidth, input)),
    '',
  ];
};

const overview = (input: RenderInput, bodyRows: number): string[] => {
  const { stack, ui, paint, glyph } = input;
  const nameWidth =
    Math.max(12, ...[...stack.rows, ...stack.dependencies].map((row) => row.name.length)) + 2;

  const dependencyLines = dependencies(input, nameWidth);

  const lines: string[] = [
    `  ${paint('bold', 'STACK DETAILS')} ${paint('gray', '(process tree)')}`,
    '',
    ...dependencyLines,
    `  ${paint('gray', `processes (${stack.rows.length} managed)`)}`,
    paint('gray', `  ${glyph.pipe}`),
  ];

  if (stack.rows.length === 0) {
    lines.push(`  ${paint('gray', `${glyph.lastBranch} nothing to manage in this stack`)}`);
    return lines;
  }

  // Keep the selection visible when the list is taller than the terminal.
  const capacity = Math.max(3, bodyRows - 5 - dependencyLines.length);
  let start = 0;
  if (stack.rows.length > capacity) {
    start = Math.min(Math.max(0, ui.selected - Math.floor(capacity / 2)), stack.rows.length - capacity);
  }
  const visible = stack.rows.slice(start, start + capacity);

  if (start > 0) lines.push(paint('gray', `  ${glyph.pipe}  ${start} more above`));

  for (const [offset, row] of visible.entries()) {
    const index = start + offset;
    lines.push(processLine(row, index === ui.selected, index === stack.rows.length - 1, nameWidth, input));
  }

  const hiddenBelow = stack.rows.length - (start + visible.length);
  if (hiddenBelow > 0) lines.push(paint('gray', `  ${glyph.pipe}  ${hiddenBelow} more below`));

  lines.push(paint('gray', `  ${glyph.pipe}`));
  lines.push(`  ${paint('gray', `${glyph.lastBranch} ${input.ui.note}`)}`);

  return lines;
};

// ---------------------------------------------------------------- log views

const logHeader = (row: ProcessRow | undefined, input: RenderInput): string[] => {
  const { paint, glyph, size } = input;
  if (!row) return [`  ${paint('gray', 'no process selected')}`];

  const style = STATE_STYLE[row.state];
  const meta = [
    paint(style.color, style.label.toLowerCase()),
    row.pid !== undefined ? paint('gray', `pid ${row.pid}`) : '',
    row.state === 'running' ? paint('gray', `up ${formatDuration(row.uptimeMs)}`) : '',
    row.restarts > 0 ? paint('yellow', `${glyph.restart}${row.restarts}`) : '',
  ]
    .filter(Boolean)
    .join(paint('gray', `  ${glyph.dot} `));

  const lines = [`  ${paint('bold', row.name)}   ${meta}`];
  if (row.command) lines.push(`  ${paint('gray', truncate(`$ ${row.command}`, size.columns - 4))}`);
  lines.push(`  ${paint('gray', truncate(row.cwd, size.columns - 4))}`);
  lines.push(paint('gray', `  ${rule(Math.max(0, size.columns - 4), glyph)}`));
  return lines;
};

const logBody = (input: RenderInput, bodyRows: number, withServiceName: boolean): string[] => {
  const { logs, ui, paint, size } = input;
  const capacity = Math.max(1, bodyRows);

  if (logs.length === 0) {
    return [`  ${paint('gray', 'no output yet')}`];
  }

  const end = Math.max(capacity, logs.length - ui.scrollBack);
  const window = logs.slice(Math.max(0, end - capacity), end);

  const nameWidth = withServiceName
    ? Math.max(...logs.map((line) => line.service.length))
    : 0;

  return window.map((line) => {
    const stamp = paint('gray', formatClock(line.at));
    const who = withServiceName ? ` ${paint('cyan', pad(line.service, nameWidth))}` : '';
    const body = line.stream === 'stderr' ? paint('red', line.line) : line.line;
    const rendered = `  ${stamp}${who} ${paint('gray', '|')} ${body}`;
    return truncate(rendered, size.columns + (rendered.length - stripAnsi(rendered).length));
  });
};

// ---------------------------------------------------------------- help

const help = ({ paint, glyph }: RenderInput): string[] => [
  `  ${paint('bold', 'KEYS')}`,
  '',
  ...[
    ['up / down, j / k', 'move the selection'],
    ['0 - 9', 'jump straight to that process and open its log'],
    ['enter, v', 'inspect the selected process log'],
    ['esc, s', 'back to the stack overview'],
    ['a', 'merged log across every service'],
    ['r', 'restart the selected process (graceful)'],
    ['t', 'toggle the selected process: stop if running, start if stopped'],
    ['f', 'follow / pause tailing in a log view'],
    ['g / G', 'jump to the top / bottom of a log'],
    ['?', 'this help'],
    ['q, ctrl-c', 'quit — stops every process first'],
  ].map(([key, label]) => `    ${paint('cyan', pad(key!, 20))}${paint('gray', label!)}`),
  '',
  `  ${paint('gray', `The overview never streams logs — that is deliberate. Open one ${glyph.dot} read it ${glyph.dot} go back.`)}`,
];

// ---------------------------------------------------------------- shutdown

export const renderShutdown = (input: RenderInput): string[] => {
  const { stack, paint, glyph } = input;
  const lines = ['', `  ${paint('bold', `Stopping ${stack.name}…`)}`, ''];

  for (const row of stack.rows) {
    const done = row.state === 'stopped' || row.state === 'failed';
    const mark = done ? paint('green', glyph.tick) : paint('yellow', glyph.starting);
    const label = done ? paint('gray', 'stopped') : paint('yellow', 'stopping…');
    lines.push(`  ${mark} ${pad(row.name, 22)}${label}`);
  }

  lines.push('', `  ${paint('gray', 'ctrl-c again to force')}`);
  return lines;
};

// ---------------------------------------------------------------- frame

/** The whole screen, as lines. Callers just write this. */
export const renderFrame = (input: RenderInput): string[] => {
  if (input.ui.phase === 'stopping') return renderShutdown(input);

  const top = header(input);
  const keys = legend(input);
  const chrome = top.length + keys.length + 3;
  const bodyRows = Math.max(3, input.size.rows - chrome);

  let body: string[];
  switch (input.ui.view) {
    case 'help':
      body = help(input);
      break;
    case 'log': {
      const row = input.stack.rows[input.ui.selected];
      const head = logHeader(row, input);
      body = [...head, ...logBody(input, bodyRows - head.length, false)];
      break;
    }
    case 'merged':
      body = [
        `  ${input.paint('bold', 'ALL SERVICES')}`,
        input.paint('gray', `  ${rule(Math.max(0, input.size.columns - 4), input.glyph)}`),
        ...logBody(input, bodyRows - 2, true),
      ];
      break;
    default:
      body = overview(input, bodyRows);
  }

  const status = input.ui.confirmQuit
    ? `  ${input.paint('yellow', 'Quit and stop every process? (y/n)')}`
    : input.ui.view !== 'overview'
      ? `  ${input.paint('gray', input.ui.note)}`
      : '';

  return [...top, '', ...keys, ...body, '', ...(status ? [status] : [])];
};
