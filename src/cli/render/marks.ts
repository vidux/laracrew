import { glyphs } from '../../tui/theme.js';
import { color, padEnd } from './colors.js';

/**
 * The status vocabulary every command shares — one glyph, one colour, one meaning — so a tick
 * in `init` says the same thing as a tick in `doctor`. ASCII under LARACREW_ASCII=1 or
 * TERM=dumb, like the TUI.
 */
export interface Marks {
  ok: string;
  fail: string;
  warn: string;
  skip: string;
  hint: string;
  arrow: string;
}

export const marks = (env: NodeJS.ProcessEnv = process.env): Marks => {
  const glyph = glyphs(env);
  return {
    ok: color.green(glyph.tick),
    fail: color.red(glyph.failed),
    warn: color.yellow(glyph.warn),
    skip: color.gray(glyph.dot),
    hint: color.cyan(glyph.pointer),
    arrow: color.gray(glyph.arrow),
  };
};

/**
 * A "Next" block: `▸ command   why` rows aligned on the command. A row with an empty command
 * continues the one above it.
 */
export const nextSteps = (rows: [command: string, why: string][], env: NodeJS.ProcessEnv = process.env): string => {
  const mark = marks(env);
  const width = Math.max(...rows.map(([command]) => command.length));
  const lines = rows.map(([command, why]) =>
    command ? `  ${mark.hint} ${color.cyan(padEnd(command, width))}  ${why}` : `${' '.repeat(width + 6)}${why}`,
  );
  return [color.bold('Next'), ...lines].join('\n');
};
