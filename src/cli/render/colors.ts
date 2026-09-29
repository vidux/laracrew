/**
 * Colour for everything laracrew prints, decided once, here. chalk produces the escape codes;
 * the on/off decision stays ours because chalk does not read NO_COLOR, and laracrew output is
 * piped into other tools as often as it is read.
 *
 * Import `color` from this module, never the `chalk` package itself.
 */

import { Chalk, supportsColor as chalkDetected, type ChalkInstance } from 'chalk';
import { stripAnsi } from '../../core/logs/sanitize.js';

const NAMES = [
  'reset',
  'bold',
  'dim',
  'italic',
  'underline',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'gray',
] as const;

export type ColorName = (typeof NAMES)[number];

export const supportsColor = (stream: { isTTY?: boolean } = process.stdout, env = process.env): boolean => {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  if (env.TERM === 'dumb') return false;
  return Boolean(stream.isTTY);
};

/** Off, or whatever depth chalk found on this terminal — never less than the 16 basic colours. */
const levelFor = (enabled: boolean): 0 | 1 | 2 | 3 =>
  enabled ? (Math.max(1, chalkDetected ? chalkDetected.level : 1) as 1 | 2 | 3) : 0;

export const createColor = (enabled: boolean): ChalkInstance => new Chalk({ level: levelFor(enabled) });

/** `color.bold.cyan('…')` — the instance every command prints with. */
export const color: ChalkInstance = createColor(supportsColor());

export interface Painter {
  (name: ColorName, text: string): string;
  readonly enabled: boolean;
}

/** `paint('red', text)`: the injectable form the TUI renders through, so screens stay pure. */
export const createPainter = (enabled: boolean): Painter => {
  const chalk = createColor(enabled);
  return Object.assign((name: ColorName, text: string): string => chalk[name](text), { enabled });
};

/** The default painter, decided once from the real stdout. */
export const paint: Painter = createPainter(supportsColor());

/** Falls back to cyan for a colour name the user invented in their config. */
export const asColorName = (value: string | undefined): ColorName =>
  value && (NAMES as readonly string[]).includes(value) ? (value as ColorName) : 'cyan';

export { stripAnsi };

export const padEnd = (text: string, width: number): string => {
  const visible = stripAnsi(text).length;
  return visible >= width ? text : text + ' '.repeat(width - visible);
};
