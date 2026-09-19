import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { stripAnsi } from '../../cli/render/colors.js';
import type { EventBus } from '../events/bus.js';
import type { LogLine } from '../events/types.js';

/**
 * In-memory ring buffers hold three minutes of a busy stack. "I saw an exception scroll past
 * and now it's gone" is the single fastest way to stop trusting a process manager, so every
 * line also goes to disk.
 *
 * Files are plain text with a sortable local timestamp and no ANSI, so `grep` and `--since`
 * both work on them.
 */

export interface FileSinkOptions {
  maxBytes: number;
  /** How many rotated files to keep beside the current one. */
  keep: number;
}

/** `2026-09-19 11:23:45.123` — local time, because you think in local time. */
export const stamp = (at: number): string => {
  const date = new Date(at);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  );
};

/** Parses a line written by this sink back into its parts. */
export const parseLine = (raw: string): { at: number; stream: string; line: string } | undefined => {
  const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) (stdout|stderr|system) (.*)$/s.exec(raw);
  if (!match) return undefined;
  const at = new Date(match[1]!.replace(' ', 'T')).getTime();
  return { at: Number.isNaN(at) ? 0 : at, stream: match[2]!, line: match[3]! };
};

/** `api:queue` is not a legal Windows filename. */
export const safeFileName = (service: string): string =>
  service.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'service';

/**
 * Builds one filename per service, disambiguating the rare case where two service names
 * sanitise to the same thing (`api:queue` and `api-queue`).
 */
export const fileNamesFor = (services: readonly string[]): Map<string, string> => {
  const used = new Set<string>();
  const out = new Map<string, string>();

  for (const service of services) {
    const base = safeFileName(service);
    let candidate = base;
    let index = 2;
    while (used.has(candidate)) candidate = `${base}-${index++}`;
    used.add(candidate);
    out.set(service, `${candidate}.log`);
  }

  return out;
};

/**
 * One append-only file, rotated by size.
 *
 * Writes go through a held file descriptor with `writeSync` rather than a WriteStream. A
 * stream's `end()` is asynchronous, so rotation would rename the file while the handle was
 * still open — which Windows refuses outright, silently costing you the rotation. A
 * descriptor closes deterministically, and a synchronous write also means a line is on disk
 * before the process that logged it can crash.
 */
export class FileSink {
  readonly file: string;
  #fd?: number;
  #bytes = 0;
  #closed = false;
  readonly #options: FileSinkOptions;

  constructor(file: string, options: FileSinkOptions) {
    this.file = file;
    this.#options = options;
  }

  #open(): number | undefined {
    if (this.#fd !== undefined) return this.#fd;

    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      this.#bytes = existsSync(this.file) ? statSync(this.file).size : 0;
      this.#fd = openSync(this.file, 'a');
      return this.#fd;
    } catch {
      // A disk problem must never take the supervisor down with it.
      this.#closed = true;
      return undefined;
    }
  }

  write(entry: LogLine): void {
    if (this.#closed) return;

    const fd = this.#open();
    if (fd === undefined) return;

    const text = `${stamp(entry.at)} ${entry.stream} ${stripAnsi(entry.line)}\n`;
    try {
      writeSync(fd, text);
    } catch {
      this.#closeHandle();
      this.#closed = true;
      return;
    }

    this.#bytes += Buffer.byteLength(text);
    if (this.#bytes >= this.#options.maxBytes) this.#rotate();
  }

  #closeHandle(): void {
    if (this.#fd === undefined) return;
    try {
      closeSync(this.#fd);
    } catch {
      /* already gone */
    }
    this.#fd = undefined;
  }

  #rotate(): void {
    // The handle must be closed before the rename, or Windows rejects it outright.
    this.#closeHandle();
    this.#bytes = 0;

    try {
      if (this.#options.keep <= 0) {
        rmSync(this.file, { force: true });
        return;
      }

      // Drop the oldest, shift the rest along, then move the current file to .1
      const oldest = `${this.file}.${this.#options.keep}`;
      if (existsSync(oldest)) rmSync(oldest, { force: true });

      for (let index = this.#options.keep - 1; index >= 1; index -= 1) {
        const from = `${this.file}.${index}`;
        if (existsSync(from)) renameSync(from, `${this.file}.${index + 1}`);
      }

      if (existsSync(this.file)) renameSync(this.file, `${this.file}.1`);
    } catch {
      // Losing a rotation is survivable; losing the process is not.
    }
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#closeHandle();
    return Promise.resolve();
  }
}

export interface LogWriterOptions {
  dir: string;
  services: readonly string[];
  maxBytes?: number;
  keep?: number;
}

/**
 * Routes every `service:log` event to the right file. Lives in core and subscribes to the
 * bus like any other renderer, so it works identically under the TUI, `--plain` and `--json`.
 */
export class LogWriter {
  readonly dir: string;
  readonly #sinks = new Map<string, FileSink>();
  readonly #names: Map<string, string>;
  #unsubscribe?: () => void;

  constructor(options: LogWriterOptions) {
    this.dir = options.dir;
    this.#names = fileNamesFor(options.services);

    const sinkOptions: FileSinkOptions = {
      maxBytes: options.maxBytes ?? 5_000_000,
      keep: options.keep ?? 1,
    };
    for (const [service, fileName] of this.#names) {
      this.#sinks.set(service, new FileSink(path.join(this.dir, fileName), sinkOptions));
    }
  }

  /** The file a given service writes to — used by `laracrew logs`. */
  fileFor(service: string): string | undefined {
    const name = this.#names.get(service);
    return name ? path.join(this.dir, name) : undefined;
  }

  attach(bus: EventBus): () => void {
    this.#unsubscribe = bus.subscribe((event) => {
      if (event.type !== 'service:log') return;
      this.#sinks.get(event.log.service)?.write(event.log);
    });
    return this.#unsubscribe;
  }

  async close(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    await Promise.all([...this.#sinks.values()].map((sink) => sink.close()));
  }
}
