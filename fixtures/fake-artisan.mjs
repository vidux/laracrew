#!/usr/bin/env node
/**
 * Stands in for a long-running process in the test suite. It can log on an interval, exit
 * with a chosen code, hang, spawn a child of its own so the stop ladder has a real tree to
 * kill, or shut itself down when a graceful stop command signals it through a file.
 *
 *   node fixtures/fake-artisan.mjs --name worker --interval 50
 *   node fixtures/fake-artisan.mjs --exit 1 --after 100
 *   node fixtures/fake-artisan.mjs --ready "listening on 9999" --after 200
 *   node fixtures/fake-artisan.mjs --spawn-child --ignore-sigterm
 *   node fixtures/fake-artisan.mjs --exit-on-file /tmp/drain.flag
 */
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    name: { type: 'string', default: 'fake' },
    interval: { type: 'string', default: '100' },
    exit: { type: 'string' },
    after: { type: 'string', default: '0' },
    ready: { type: 'string' },
    'ignore-sigterm': { type: 'boolean', default: false },
    'spawn-child': { type: 'boolean', default: false },
    'listen-port': { type: 'string' },
    'exit-on-file': { type: 'string' },
    stderr: { type: 'boolean', default: false },
  },
  strict: true,
});

const name = values.name;
const interval = Number(values.interval);
const after = Number(values.after);

if (values['ignore-sigterm']) {
  process.on('SIGTERM', () => console.log(`${name}: ignoring SIGTERM`));
  process.on('SIGINT', () => console.log(`${name}: ignoring SIGINT`));
}

if (values['spawn-child']) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: false,
  });
  console.log(`${name}: spawned child ${child.pid}`);
}

if (values['listen-port']) {
  const { createServer } = await import('node:net');
  createServer().listen(Number(values['listen-port']), '127.0.0.1', () => {
    console.log(`${name}: listening on ${values['listen-port']}`);
  });
}

// How a real worker reacts to a graceful stop: it notices the flag the stop command set,
// finishes the tick it is on, and exits by itself — no signal involved.
if (values['exit-on-file']) {
  const { existsSync } = await import('node:fs');
  const watcher = setInterval(() => {
    if (!existsSync(values['exit-on-file'])) return;
    clearInterval(watcher);
    console.log(`${name}: graceful stop, exiting`);
    process.exit(0);
  }, 25);
}

let tick = 0;
const timer = setInterval(() => {
  tick += 1;
  const line = `${name}: tick ${tick}`;
  if (values.stderr) process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}, interval);

if (values.ready) {
  setTimeout(() => console.log(values.ready), after);
}

if (values.exit !== undefined) {
  setTimeout(() => {
    clearInterval(timer);
    console.log(`${name}: exiting with ${values.exit}`);
    process.exit(Number(values.exit));
  }, after);
}
