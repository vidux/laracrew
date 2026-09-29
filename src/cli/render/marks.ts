import { glyphs } from '../../tui/theme.js';
import { color } from './colors.js';

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
