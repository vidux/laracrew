import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus } from '../src/core/events/bus.js';
import type { LaracrewEvent } from '../src/core/events/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Forward slashes so the path is safe to drop into a YAML double-quoted scalar. */
export const yamlPath = (value: string): string => value.replace(/\\/g, '/');

export const FAKE_ARTISAN = yamlPath(path.join(HERE, '..', 'fixtures', 'fake-artisan.mjs'));
export const NODE = yamlPath(process.execPath);

/** A throwaway LARACREW_HOME so tests never touch the real one. */
export class TempHome {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;

  constructor() {
    this.root = mkdtempSync(path.join(tmpdir(), 'laracrew-test-'));
    this.env = { ...process.env, LARACREW_HOME: this.root };
  }

  writeStack(name: string, yaml: string): string {
    const dir = path.join(this.root, 'stacks', name);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'stack.yaml');
    writeFileSync(file, yaml, 'utf8');
    return file;
  }

  writeFragment(stack: string, fileName: string, yaml: string): string {
    const dir = path.join(this.root, 'stacks', stack, 'services');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, fileName);
    writeFileSync(file, yaml, 'utf8');
    return file;
  }

  write(relative: string, contents: string): string {
    const file = path.join(this.root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents, 'utf8');
    return file;
  }

  /** A directory that looks enough like a Laravel root for the resolver and doctor. */
  makeProject(key: string, env: Record<string, string> = {}): string {
    const dir = path.join(this.root, 'projects', key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'artisan'), '#!/usr/bin/env php\n', 'utf8');
    writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({ require: { 'laravel/framework': '^11' } }), 'utf8');
    const lines = Object.entries(env).map(([name, value]) => `${name}=${value}`);
    writeFileSync(path.join(dir, '.env'), `${lines.join('\n')}\n`, 'utf8');
    return dir;
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** Collects every event so a test can assert on the sequence after the fact. */
export class EventRecorder {
  readonly events: LaracrewEvent[] = [];
  readonly #unsubscribe: () => void;

  constructor(readonly bus: EventBus) {
    this.#unsubscribe = bus.subscribe((event) => this.events.push(event));
  }

  ofType<T extends LaracrewEvent['type']>(type: T): Extract<LaracrewEvent, { type: T }>[] {
    return this.events.filter((event): event is Extract<LaracrewEvent, { type: T }> => event.type === type);
  }

  statesOf(service: string): string[] {
    return this.ofType('service:state')
      .filter((event) => event.service === service)
      .map((event) => event.to);
  }

  linesOf(service: string): string[] {
    return this.ofType('service:log')
      .filter((event) => event.log.service === service)
      .map((event) => event.log.line);
  }

  stop(): void {
    this.#unsubscribe();
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Polls until `condition` holds or the deadline passes — steadier than a fixed sleep. */
export const waitUntil = async (
  condition: () => boolean | Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 25, label = 'condition' } = {},
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
};

export const newBus = (): { bus: EventBus; recorder: EventRecorder } => {
  const bus = new EventBus();
  return { bus, recorder: new EventRecorder(bus) };
};
