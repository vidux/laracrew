/**
 * Child output goes straight into a framed TUI, so anything that moves the cursor would
 * corrupt the frame. Colour (SGR) is kept — Laravel colours its own output and that is
 * worth preserving.
 *
 * The escape characters are built with String.fromCharCode instead of being written as
 * literals, so this file holds no raw control bytes for an editor or a diff to mangle.
 */

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** CSI: ESC [ params intermediates final — colour, cursor moves, erase. */
const CSI = new RegExp(ESC + '\\[[0-?]*[ -/]*[@-~]', 'g');

/** OSC: ESC ] ... BEL or ST — window titles and hyperlinks. */
const OSC = new RegExp(ESC + '\\][^' + BEL + ESC + ']*(?:' + BEL + '|' + ESC + '\\\\)', 'g');

/** Single-character escapes that have no business mid-line. */
const SINGLE = new RegExp(ESC + '[=>78MD]', 'g');

const TAB = 9;
const ESC_CODE = 27;

export const sanitize = (input: string): string => {
  let out = input.replace(OSC, '').replace(SINGLE, '');

  // Keep colour, drop everything that would move or erase.
  out = out.replace(CSI, (seq) => (seq.endsWith('m') ? seq : ''));

  // Progress bars redraw with \r; only the final state is meaningful in a log.
  if (out.includes('\r')) {
    const segments = out.split('\r').filter((segment) => segment !== '');
    out = segments.length > 0 ? segments[segments.length - 1]! : '';
  }

  // Strip the remaining control characters. ESC survives because the SGR sequences
  // kept above still need it.
  return out.replace(/\p{Cc}/gu, (character) => {
    const code = character.charCodeAt(0);
    return code === TAB || code === ESC_CODE ? character : '';
  });
};

/**
 * Turns a stream of arbitrary chunks into whole lines. Children write when they feel like
 * it, so a line routinely arrives split across two chunks.
 */
export class LineSplitter {
  #buffer = '';
  readonly #maxLineLength: number;

  constructor(maxLineLength = 16_384) {
    this.#maxLineLength = maxLineLength;
  }

  push(chunk: string | Buffer): string[] {
    this.#buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    const lines: string[] = [];
    let index = this.#buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.#buffer.slice(0, index).replace(/\r$/, '');
      lines.push(sanitize(line));
      this.#buffer = this.#buffer.slice(index + 1);
      index = this.#buffer.indexOf('\n');
    }

    // A child that never emits a newline (a progress bar, a hung prompt) must not grow
    // the buffer without bound.
    if (this.#buffer.length > this.#maxLineLength) {
      lines.push(sanitize(this.#buffer));
      this.#buffer = '';
    }

    return lines;
  }

  /** Emits whatever is left when the stream closes. */
  flush(): string[] {
    if (this.#buffer === '') return [];
    const line = sanitize(this.#buffer.replace(/\r$/, ''));
    this.#buffer = '';
    return line === '' ? [] : [line];
  }
}
