import readline from 'node:readline';
import { stripAnsi } from '../cli/render/colors.js';
import type { Key } from './keys.js';
import type { Size } from './screen.js';

const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;

/** The escape codes a full-screen CLI actually needs. */
export const codes = {
  altScreenOn: `${CSI}?1049h`,
  altScreenOff: `${CSI}?1049l`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  home: `${CSI}H`,
  clearLine: `${CSI}K`,
  clearBelow: `${CSI}J`,
};

export interface TerminalOptions {
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
}

/**
 * Drives a full-screen view over plain ANSI: enter the alternate screen buffer (so the user's
 * scrollback survives), then repaint by homing the cursor and clearing to end-of-line per row.
 * No clear-then-draw, so there is no flicker, and no framework.
 */
export class Terminal {
  readonly #stdout: NodeJS.WriteStream;
  readonly #stdin: NodeJS.ReadStream;
  #lastFrame: string[] = [];
  #active = false;
  #onKey?: (key: Key) => void;
  #onResize?: () => void;
  #keyListener?: (str: string | undefined, key: readline.Key) => void;
  #resizeListener?: () => void;

  constructor(options: TerminalOptions = {}) {
    this.#stdout = options.stdout ?? process.stdout;
    this.#stdin = options.stdin ?? process.stdin;
  }

  get size(): Size {
    return {
      columns: Math.max(40, this.#stdout.columns ?? 80),
      rows: Math.max(10, this.#stdout.rows ?? 24),
    };
  }

  start(handlers: { onKey: (key: Key) => void; onResize?: () => void }): void {
    if (this.#active) return;
    this.#active = true;
    this.#onKey = handlers.onKey;
    if (handlers.onResize) this.#onResize = handlers.onResize;

    this.#stdout.write(codes.altScreenOn + codes.hideCursor);

    readline.emitKeypressEvents(this.#stdin);
    if (this.#stdin.isTTY) this.#stdin.setRawMode(true);
    this.#stdin.resume();

    this.#keyListener = (_str, key) => {
      if (!key) return;
      this.#onKey?.({
        name: key.name ?? key.sequence ?? '',
        ...(key.ctrl ? { ctrl: true } : {}),
        ...(key.shift ? { shift: true } : {}),
      });
    };
    this.#stdin.on('keypress', this.#keyListener);

    this.#resizeListener = () => {
      this.#lastFrame = []; // force a full repaint at the new width
      this.#onResize?.();
    };
    this.#stdout.on('resize', this.#resizeListener);
  }

  /** Repaints only the lines that changed. */
  paint(lines: string[]): void {
    if (!this.#active) return;
    const { rows, columns } = this.size;
    const frame = lines.slice(0, rows - 1).map((line) => clip(line, columns));

    let output = codes.home;
    const height = Math.max(frame.length, this.#lastFrame.length);

    for (let index = 0; index < height; index += 1) {
      const line = frame[index] ?? '';
      if (this.#lastFrame[index] === line) {
        output += `${CSI}${index + 2};1H`; // nothing changed: skip to the next row
        continue;
      }
      output += `${CSI}${index + 1};1H${line}${codes.clearLine}`;
    }

    output += codes.clearBelow;
    this.#stdout.write(output);
    this.#lastFrame = frame;
  }

  stop(): void {
    if (!this.#active) return;
    this.#active = false;

    if (this.#keyListener) this.#stdin.off('keypress', this.#keyListener);
    if (this.#resizeListener) this.#stdout.off('resize', this.#resizeListener);
    if (this.#stdin.isTTY) this.#stdin.setRawMode(false);
    this.#stdin.pause();

    this.#stdout.write(codes.showCursor + codes.altScreenOff);
    this.#lastFrame = [];
  }
}

/** Trims a line to the terminal width without counting the invisible colour codes. */
export const clip = (line: string, columns: number): string => {
  const visible = stripAnsi(line).length;
  if (visible <= columns) return line;

  let out = '';
  let width = 0;
  let index = 0;
  while (index < line.length && width < columns) {
    if (line[index] === ESC) {
      const end = line.indexOf('m', index);
      if (end === -1) break;
      out += line.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    out += line[index];
    width += 1;
    index += 1;
  }
  return out;
};
