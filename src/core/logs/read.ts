import { openSync, readSync, closeSync, statSync, existsSync } from 'node:fs';
import type { LogLine } from '../events/types.js';
import { parseLine } from './file-sink.js';

/**
 * Reading back what the sink wrote. Tailing reads from the end of the file rather than
 * loading it, so a rotated-but-still-large log does not cost a heap allocation.
 */

const CHUNK = 64 * 1024;

/** The last `limit` lines of a file, oldest first, without reading the whole thing. */
export const tailFile = (file: string, limit: number): string[] => {
  if (!existsSync(file) || limit <= 0) return [];

  const size = statSync(file).size;
  if (size === 0) return [];

  const handle = openSync(file, 'r');
  try {
    let position = size;
    let text = '';
    let newlines = 0;

    while (position > 0 && newlines <= limit) {
      const length = Math.min(CHUNK, position);
      position -= length;

      const buffer = Buffer.alloc(length);
      readSync(handle, buffer, 0, length, position);
      const chunk = buffer.toString('utf8');

      text = chunk + text;
      newlines = 0;
      for (const character of text) if (character === '\n') newlines += 1;
    }

    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-limit);
  } finally {
    closeSync(handle);
  }
};

/** Turns raw file lines into log entries, keeping unparseable lines rather than dropping them. */
export const toEntries = (service: string, lines: readonly string[]): LogLine[] =>
  lines.map((raw) => {
    const parsed = parseLine(raw);
    if (!parsed) return { service, stream: 'stdout' as const, line: raw, at: 0 };
    return {
      service,
      stream: (parsed.stream === 'stderr' ? 'stderr' : parsed.stream === 'system' ? 'system' : 'stdout') as
        | 'stdout'
        | 'stderr'
        | 'system',
      line: parsed.line,
      at: parsed.at,
    };
  });

/**
 * `10m`, `2h`, `90s`, `1d`, or anything `Date` understands. Returns a timestamp in ms.
 */
export const parseSince = (input: string): number | undefined => {
  const relative = /^(\d+)\s*(s|m|h|d)$/i.exec(input.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const ms = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 0;
    return Date.now() - amount * ms;
  }

  const absolute = new Date(input).getTime();
  return Number.isNaN(absolute) ? undefined : absolute;
};

export interface FollowOptions {
  /** How often to check for new bytes. Polling is steadier than fs.watch across platforms. */
  intervalMs?: number;
  signal?: AbortSignal;
  onLines: (lines: string[]) => void;
}

/**
 * Watches a file for appended lines. Handles the file being rotated out from under us by
 * noticing the size shrank and starting again from the top.
 */
export const followFile = (file: string, options: FollowOptions): (() => void) => {
  let position = existsSync(file) ? statSync(file).size : 0;
  let carry = '';

  const read = (): void => {
    if (!existsSync(file)) return;

    const size = statSync(file).size;
    if (size === position) return;

    // Rotation: the file we were reading was renamed and a fresh one took its place.
    if (size < position) {
      position = 0;
      carry = '';
    }

    const length = size - position;
    const handle = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      readSync(handle, buffer, 0, length, position);
      position = size;

      const text = carry + buffer.toString('utf8');
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      if (lines.length > 0) options.onLines(lines);
    } finally {
      closeSync(handle);
    }
  };

  const timer = setInterval(read, options.intervalMs ?? 300);
  timer.unref?.();

  const stop = (): void => clearInterval(timer);
  options.signal?.addEventListener('abort', stop, { once: true });
  return stop;
};
