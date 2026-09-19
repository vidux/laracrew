import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { EventBus } from '../src/core/events/bus.js';
import {
  FileSink,
  LogWriter,
  fileNamesFor,
  parseLine,
  safeFileName,
  stamp,
} from '../src/core/logs/file-sink.js';
import { followFile, parseSince, tailFile, toEntries } from '../src/core/logs/read.js';
import { Supervisor } from '../src/core/process/supervisor.js';
import { prepareStack } from '../src/cli/commands/up.js';
import { logDirFor, targetsFor } from '../src/cli/commands/logs.js';
import type { LogLine } from '../src/core/events/types.js';
import { FAKE_ARTISAN, NODE, TempHome, newBus, sleep, waitUntil } from './helpers.js';

let home: TempHome;
let supervisor: Supervisor | undefined;

beforeEach(() => {
  home = new TempHome();
  supervisor = undefined;
});
afterEach(async () => {
  await supervisor?.down('test teardown');
  home.cleanup();
});

const entry = (line: string, at = Date.now(), stream: LogLine['stream'] = 'stdout'): LogLine => ({
  service: 'api:queue',
  stream,
  line,
  at,
});

describe('file names', () => {
  test('a service name with a colon becomes a legal Windows filename', () => {
    expect(safeFileName('api:queue')).toBe('api-queue');
    expect(safeFileName('portal:stream-order/details')).toBe('portal-stream-order-details');
  });

  test('two names that sanitise the same way still get separate files', () => {
    const names = fileNamesFor(['api:queue', 'api-queue']);
    expect(names.get('api:queue')).toBe('api-queue.log');
    expect(names.get('api-queue')).toBe('api-queue-2.log');
  });

  test('a name with nothing usable still produces a file', () => {
    expect(safeFileName(':::')).toBe('service');
  });
});

describe('line format', () => {
  test('round-trips through parseLine', () => {
    const at = new Date(2026, 8, 19, 11, 23, 45, 123).getTime();
    const raw = `${stamp(at)} stderr Processing: App\\Jobs\\SyncOrder`;
    const parsed = parseLine(raw);

    expect(parsed).toBeDefined();
    expect(parsed!.at).toBe(at);
    expect(parsed!.stream).toBe('stderr');
    expect(parsed!.line).toBe('Processing: App\\Jobs\\SyncOrder');
  });

  test('is sortable as plain text', () => {
    const early = stamp(new Date(2026, 8, 19, 9, 5, 1, 2).getTime());
    const late = stamp(new Date(2026, 8, 19, 11, 23, 45, 123).getTime());
    expect(early < late).toBe(true);
  });

  test('ignores a line it did not write rather than throwing', () => {
    expect(parseLine('some stray text')).toBeUndefined();
  });
});

describe('FileSink', () => {
  test('appends lines and strips colour so grep works', () => {
    const file = path.join(home.root, 'logs', 'a.log');
    const sink = new FileSink(file, { maxBytes: 1_000_000, keep: 1 });

    sink.write(entry(`[32mProcessed[39m job`));
    sink.write(entry('second line'));

    const contents = readFileSync(file, 'utf8');
    expect(contents).toContain('Processed job');
    expect(contents).not.toContain('');
    expect(contents.trim().split('\n')).toHaveLength(2);
  });

  test('rotates once the file passes maxBytes and keeps the old one', () => {
    const file = path.join(home.root, 'logs', 'rot.log');
    const sink = new FileSink(file, { maxBytes: 400, keep: 1 });

    for (let index = 0; index < 40; index += 1) sink.write(entry(`line ${index}`));

    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.1`)).toBe(true);
    // The newest lines are in the live file, not the rotated one.
    expect(readFileSync(file, 'utf8')).toContain('line 39');
  });

  test('keeps only `keep` rotated files', () => {
    const file = path.join(home.root, 'logs', 'keep.log');
    const sink = new FileSink(file, { maxBytes: 200, keep: 1 });

    for (let index = 0; index < 200; index += 1) sink.write(entry(`line ${index}`));

    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(false);
  });

  test('a closed sink stops writing instead of throwing', async () => {
    const file = path.join(home.root, 'logs', 'closed.log');
    const sink = new FileSink(file, { maxBytes: 1_000_000, keep: 1 });
    sink.write(entry('before'));
    await sink.close();

    expect(() => sink.write(entry('after'))).not.toThrow();
    expect(readFileSync(file, 'utf8')).not.toContain('after');
  });
});

describe('tailFile', () => {
  const build = (count: number): string => {
    const file = path.join(home.root, 'logs', 'tail.log');
    mkdirSync(path.dirname(file), { recursive: true });
    const lines = Array.from({ length: count }, (_, index) => `${stamp(Date.now())} stdout line ${index}`);
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    return file;
  };

  test('returns the last n lines, oldest first', () => {
    const file = build(500);
    const lines = tailFile(file, 3);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('line 497');
    expect(lines[2]).toContain('line 499');
  });

  test('returns everything when the file is shorter than n', () => {
    expect(tailFile(build(4), 100)).toHaveLength(4);
  });

  test('reads across chunk boundaries for a large file', () => {
    // Comfortably larger than the 64 KiB read chunk.
    const file = build(5_000);
    const lines = tailFile(file, 2_000);
    expect(lines).toHaveLength(2_000);
    expect(lines.at(-1)).toContain('line 4999');
    expect(lines[0]).toContain('line 3000');
  });

  test('handles a missing or empty file', () => {
    expect(tailFile(path.join(home.root, 'nope.log'), 10)).toEqual([]);
    const empty = path.join(home.root, 'logs', 'empty.log');
    mkdirSync(path.dirname(empty), { recursive: true });
    writeFileSync(empty, '', 'utf8');
    expect(tailFile(empty, 10)).toEqual([]);
  });
});

describe('parseSince', () => {
  test('reads relative windows', () => {
    const now = Date.now();
    expect(parseSince('10m')!).toBeGreaterThan(now - 601_000);
    expect(parseSince('10m')!).toBeLessThanOrEqual(now - 599_000);
    expect(parseSince('2h')!).toBeLessThanOrEqual(now - 7_199_000);
    expect(parseSince('1d')!).toBeLessThanOrEqual(now - 86_399_000);
  });

  test('reads an absolute date', () => {
    expect(parseSince('2026-09-19T10:00:00')).toBe(new Date('2026-09-19T10:00:00').getTime());
  });

  test('rejects nonsense', () => {
    expect(parseSince('yesterdayish')).toBeUndefined();
  });
});

describe('followFile', () => {
  test('reports lines appended after it started watching', async () => {
    const file = path.join(home.root, 'logs', 'follow.log');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${stamp(Date.now())} stdout existing\n`, 'utf8');

    const seen: string[] = [];
    const stop = followFile(file, { intervalMs: 50, onLines: (lines) => seen.push(...lines) });

    try {
      appendFileSync(file, `${stamp(Date.now())} stdout fresh line\n`, 'utf8');
      await waitUntil(() => seen.length > 0, { timeoutMs: 4_000, label: 'the appended line' });

      expect(seen.join('\n')).toContain('fresh line');
      expect(seen.join('\n')).not.toContain('existing'); // only what arrived after
    } finally {
      stop();
    }
  });

  test('recovers when the file is rotated out from under it', async () => {
    const file = path.join(home.root, 'logs', 'rotated.log');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${stamp(Date.now())} stdout old and long line here\n`, 'utf8');

    const seen: string[] = [];
    const stop = followFile(file, { intervalMs: 50, onLines: (lines) => seen.push(...lines) });

    try {
      await sleep(120);
      // Rotation: a fresh, shorter file replaces the one we were reading.
      writeFileSync(file, `${stamp(Date.now())} stdout after rotate\n`, 'utf8');
      await waitUntil(() => seen.some((line) => line.includes('after rotate')), {
        timeoutMs: 4_000,
        label: 'lines from the new file',
      });
    } finally {
      stop();
    }
  });
});

describe('end to end', () => {
  const fake = (args: string[]): string =>
    `["${NODE}", "${FAKE_ARTISAN}", ${args.map((a) => `"${a}"`).join(', ')}]`;

  test('a running stack writes each service to its own file, readable after shutdown', async () => {
    home.writeStack(
      'logged',
      `
name: logged
defaults: { restart: never }
services:
  - { name: "api:queue", cmd: ${fake(['--name', 'api', '--interval', '40'])} }
  - { name: "portal:queue", cmd: ${fake(['--name', 'portal', '--interval', '40'])} }
`,
    );

    const stack = prepareStack('logged', { env: home.env });
    expect(stack.logs.toFile).toBe(true); // on by default

    const { bus } = newBus();
    const sup = new Supervisor(stack, bus, { env: home.env });
    supervisor = sup;
    await sup.up();

    const apiFile = sup.logFileFor('api:queue')!;
    expect(apiFile).toContain('logged');
    expect(path.basename(apiFile)).toBe('api-queue.log');

    await waitUntil(() => existsSync(apiFile) && readFileSync(apiFile, 'utf8').includes('tick'), {
      label: 'output on disk',
    });

    await sup.down('test');
    supervisor = undefined;

    // The whole point: the evidence survives the process that produced it.
    const contents = readFileSync(apiFile, 'utf8');
    expect(contents).toContain('api: tick');
    expect(contents).not.toContain('portal: tick');

    const targets = targetsFor('logged', home.env);
    expect(targets.map((target) => target.service).sort()).toEqual(['api:queue', 'portal:queue']);
    expect(logDirFor('logged', home.env)).toBe(path.join(home.root, 'logs', 'logged'));

    const entries = toEntries('api:queue', tailFile(apiFile, 5));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.at(-1)!.at).toBeGreaterThan(0);
  });

  test('toFile:false writes nothing', async () => {
    home.writeStack(
      'quiet',
      `
name: quiet
defaults:
  restart: never
  logs: { toFile: false }
services:
  - { name: a, cmd: ${fake(['--name', 'a', '--interval', '40'])} }
`,
    );

    const stack = prepareStack('quiet', { env: home.env });
    const { bus } = newBus();
    const sup = new Supervisor(stack, bus, { env: home.env });
    supervisor = sup;
    await sup.up();

    expect(sup.logFileFor('a')).toBeUndefined();
    await sleep(200);
    expect(existsSync(path.join(home.root, 'logs', 'quiet'))).toBe(false);
  });

  test('LogWriter only records the service a line belongs to', async () => {
    const bus = new EventBus();
    const dir = path.join(home.root, 'logs', 'routed');
    const writer = new LogWriter({ dir, services: ['one', 'two'] });
    writer.attach(bus);

    bus.emit({ type: 'service:log', log: { service: 'one', stream: 'stdout', line: 'for one', at: Date.now() } });
    bus.emit({ type: 'service:log', log: { service: 'two', stream: 'stderr', line: 'for two', at: Date.now() } });
    await writer.close();

    expect(readFileSync(path.join(dir, 'one.log'), 'utf8')).toContain('for one');
    expect(readFileSync(path.join(dir, 'one.log'), 'utf8')).not.toContain('for two');
    expect(readFileSync(path.join(dir, 'two.log'), 'utf8')).toContain('stderr for two');
  });
});
