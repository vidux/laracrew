/**
 * A 40-line colour helper instead of a dependency. Honours NO_COLOR and FORCE_COLOR,
 * because laracrew output is piped into other tools as often as it is read.
 */

const CODES = {
  reset: 0,
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
} as const;

export type ColorName = keyof typeof CODES;

export const supportsColor = (stream: { isTTY?: boolean } = process.stdout, env = process.env): boolean => {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  if (env.TERM === 'dumb') return false;
  return Boolean(stream.isTTY);
};

export interface Painter {
  (name: ColorName, text: string): string;
  readonly enabled: boolean;
}

export const createPainter = (enabled: boolean): Painter => {
  const paint = ((name: ColorName, text: string): string =>
    enabled ? `[${CODES[name]}m${text}[${CODES.reset}m` : text) as {
    (name: ColorName, text: string): string;
    enabled: boolean;
  };
  paint.enabled = enabled;
  return paint as Painter;
};

/** The default painter, decided once from the real stdout. */
export const paint: Painter = createPainter(supportsColor());

/** Falls back to cyan for a colour name the user invented in their config. */
export const asColorName = (value: string | undefined): ColorName =>
  value && value in CODES ? (value as ColorName) : 'cyan';

/** Visible width, ignoring the ANSI we may have added. */
export const stripAnsi = (text: string): string => text.replace(/\[[0-9;]*m/g, '');

export const padEnd = (text: string, width: number): string => {
  const visible = stripAnsi(text).length;
  return visible >= width ? text : text + ' '.repeat(width - visible);
};
