import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import net from 'node:net';
import { Supervisor } from '../src/core/process/supervisor.js';
import { prepareStack } from '../src/cli/commands/up.js';
import { isAlive } from '../src/core/process/stop.js';
import { EventRecorder, FAKE_ARTISAN, NODE, TempHome, newBus, waitUntil } from './helpers.js';

let home: TempHome;
let supervisor: Supervisor | undefined;

beforeEach(() => {
  home = new TempHome();
  supervisor = undefined;
});

afterEach(async () => {
  // Every test must leave the machine clean, even when it failed mid-way.
  await supervisor?.down('test teardown');
  home.cleanup();
});

/** Builds a `cmd:` argv line that runs the fake-artisan fixture. */
const fake = (args: string[]): string => `["${NODE}", "${FAKE_ARTISAN}", ${args.map((a) => `"${a}"`).join(', ')}]`;

const buildStack = (yaml: string) => {
  home.writeStack('t', yaml);
  return prepareStack('t', { env: home.env });
};

const start = async (yaml: string): Promise<{ supervisor: Supervisor; recorder: EventRecorder }> => {
  const stack = buildStack(yaml);
  const { bus, recorder } = newBus();
  const created = new Supervisor(stack, bus, { env: home.env });
  supervisor = created;
  await created.up();
  return { supervisor: created, recorder };
};

describe('Supervisor.up', () => {
  test('boots every service and reports the stack ready', async () => {
    const { supervisor: sup, recorder } = await start(`
name: t
defaults: { restart: never }
services:
  - { name: a, cmd: ${fake(['--name', 'a', '--interval', '50'])} }
  - { name: b, cmd: ${fake(['--name', 'b', '--interval', '50'])}, needs: [a] }
`);

    expect(sup.processes.map((process) => process.state)).toEqual(['running', 'running']);
    expect(recorder.ofType('stack:ready')).toHaveLength(1);

    await waitUntil(() => recorder.linesOf('a').some((line) => line.includes('tick')), { label: 'output from a' });
    expect(recorder.linesOf('a').some((line) => line.includes('a: tick'))).toBe(true);
  });

  test('starts in dependency order', async () => {
    const { recorder } = await start(`
name: t
defaults: { restart: never }
services:
  - { name: first, cmd: ${fake(['--name', 'first'])} }
  - { name: second, cmd: ${fake(['--name', 'second'])}, needs: [first] }
  - { name: third, cmd: ${fake(['--name', 'third'])}, needs: [second] }
`);

    const order = recorder.ofType('service:spawned').map((event) => event.service);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  test('a logMatch gate holds the service in `starting` until the line appears', async () => {
    const { supervisor: sup, recorder } = await start(`
name: t
defaults: { restart: never }
services:
  - name: slow
    cmd: ${fake(['--name', 'slow', '--ready', 'listening on 9', '--after', '400', '--interval', '50'])}
    ready: { logMatch: "listening on", timeoutMs: 8000 }
`);

    expect(sup.get('slow')!.state).toBe('running');
    const ready = recorder.ofType('service:ready')[0]!;
    expect(ready.durationMs).toBeGreaterThanOrEqual(350);
    expect(recorder.statesOf('slow')).toEqual(['starting', 'running']);
  });

  test('a failed readiness gate aborts the boot and rolls back what already started', async () => {
    const stack = buildStack(`
name: t
defaults: { restart: never }
services:
  - { name: healthy, cmd: ${fake(['--name', 'healthy', '--interval', '50'])} }
  - name: never-ready
    cmd: ${fake(['--name', 'never-ready', '--interval', '50'])}
    needs: [healthy]
    ready: { logMatch: "this never appears", timeoutMs: 600 }
`);
    const { bus, recorder } = newBus();
    const sup = new Supervisor(stack, bus, { env: home.env });
    supervisor = sup;

    const healthyPid = await (async () => {
      const promise = sup.up();
      await expect(promise).rejects.toThrow(/never became ready/);
      return recorder.ofType('service:spawned').find((event) => event.service === 'healthy')?.pid;
    })();

    expect(healthyPid).toBeDefined();
    await waitUntil(() => !isAlive(healthyPid!), { label: 'healthy process to be cleaned up' });
    expect(sup.get('healthy')!.state).toBe('stopped');
  });

  test('an external service is health-checked but never spawned', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const { supervisor: sup, recorder } = await start(`
name: t
defaults: { restart: never }
services:
  - { name: redis, external: true, ready: { tcp: "127.0.0.1:${port}", timeoutMs: 4000 } }
  - { name: worker, cmd: ${fake(['--name', 'worker'])}, needs: [redis] }
`);

      expect(sup.get('redis')!.state).toBe('ready');
      expect(sup.get('redis')!.pid).toBeUndefined();
      expect(recorder.ofType('service:spawned').map((event) => event.service)).toEqual(['worker']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('autostart', () => {
  test('a service with autostart:false is created but never launched', async () => {
    const { supervisor: sup, recorder } = await start(`
name: t
defaults: { restart: never }
services:
  - { name: auto, cmd: ${fake(['--name', 'auto', '--interval', '50'])} }
  - { name: manual, cmd: ${fake(['--name', 'manual', '--interval', '50'])}, autostart: false }
`);

    expect(sup.get('auto')!.state).toBe('running');
    expect(sup.get('manual')!.state).toBe('queued');
    expect(sup.get('manual')!.pid).toBeUndefined();
    expect(recorder.ofType('service:spawned').map((event) => event.service)).toEqual(['auto']);
  });

  test('the stack still reports ready when only manual services are left', async () => {
    const { recorder } = await start(`
name: t
defaults: { restart: never }
services:
  - { name: manual, cmd: ${fake(['--name', 'manual'])}, autostart: false }
`);
    expect(recorder.ofType('stack:ready')).toHaveLength(1);
  });

  test('starting one on demand works exactly like any other service', async () => {
    const { supervisor: sup, recorder } = await start(`
name: t
defaults: { restart: never }
services:
  - { name: manual, cmd: ${fake(['--name', 'manual', '--interval', '40'])}, autostart: false }
`);

    await sup.startService('manual');
    expect(sup.get('manual')!.state).toBe('running');

    await waitUntil(() => recorder.linesOf('manual').some((line) => line.includes('tick')), {
      label: 'output after a manual start',
    });

    const pid = recorder.ofType('service:spawned')[0]!.pid;
    await sup.down('test');
    await waitUntil(() => !isAlive(pid), { label: 'manual service to stop' });
  });

  test('a manual service is still stopped cleanly by down() even if never started', async () => {
    const { supervisor: sup } = await start(`
name: t
defaults: { restart: never }
services:
  - { name: manual, cmd: ${fake(['--name', 'manual'])}, autostart: false }
`);
    await sup.down('test');
    expect(sup.get('manual')!.state).toBe('stopped');
  });
});

describe('restart policy', () => {
  test('on-failure restarts a crashing service with exponential backoff', async () => {
    const { supervisor: sup, recorder } = await start(`
name: t
defaults:
  restart: on-failure
  backoff: { initialMs: 100, maxMs: 400, factor: 2, maxRestarts: 5, resetAfterMs: 60000 }
services:
  - { name: flaky, cmd: ${fake(['--name', 'flaky', '--exit', '1', '--after', '80', '--interval', '20'])} }
`);

    await waitUntil(() => recorder.ofType('service:restart').length >= 3, {
      timeoutMs: 12_000,
      label: 'three restart attempts',
    });

    const delays = recorder.ofType('service:restart').map((event) => event.delayMs);
    expect(delays.slice(0, 3)).toEqual([100, 200, 400]);
    expect(delays.every((delay) => delay <= 400)).toBe(true);
    expect(sup.get('flaky')!.restarts).toBeGreaterThanOrEqual(3);
  });

  test('gives up after maxRestarts and lands in `failed`', async () => {
    const { supervisor: sup } = await start(`
name: t
defaults:
  restart: on-failure
  backoff: { initialMs: 50, maxMs: 50, factor: 1, maxRestarts: 2, resetAfterMs: 60000 }
services:
  - { name: doomed, cmd: ${fake(['--name', 'doomed', '--exit', '1', '--after', '30', '--interval', '10'])} }
`);

    await waitUntil(() => supervisorState(sup, 'doomed') === 'failed', {
      timeoutMs: 10_000,
      label: 'doomed to give up',
    });
    expect(sup.get('doomed')!.restarts).toBe(2);
  });

  test('`never` leaves a clean exit alone', async () => {
    const { supervisor: sup, recorder } = await start(`
name: t
defaults: { restart: never }
services:
  - { name: oneshot, cmd: ${fake(['--name', 'oneshot', '--exit', '0', '--after', '50', '--interval', '20'])} }
`);

    await waitUntil(() => supervisorState(sup, 'oneshot') === 'stopped', { label: 'oneshot to finish' });
    expect(recorder.ofType('service:restart')).toHaveLength(0);
    expect(sup.get('oneshot')!.restarts).toBe(0);
  });

  test('`always` restarts even a clean exit', async () => {
    const { recorder } = await start(`
name: t
defaults:
  restart: always
  backoff: { initialMs: 50, maxMs: 100, factor: 1, maxRestarts: 5, resetAfterMs: 60000 }
services:
  - { name: looper, cmd: ${fake(['--name', 'looper', '--exit', '0', '--after', '40', '--interval', '10'])} }
`);

    await waitUntil(() => recorder.ofType('service:restart').length >= 2, {
      timeoutMs: 8_000,
      label: 'restarts after clean exits',
    });
    expect(recorder.ofType('service:restart').length).toBeGreaterThanOrEqual(2);
  });
});

describe('shutdown', () => {
  test('down() stops every service and leaves nothing alive', async () => {
    const { supervisor: sup, recorder } = await start(`
name: t
defaults: { restart: always, stop: { graceMs: 2000 } }
services:
  - { name: a, cmd: ${fake(['--name', 'a', '--interval', '30'])} }
  - { name: b, cmd: ${fake(['--name', 'b', '--interval', '30'])}, needs: [a] }
`);

    const pids = recorder.ofType('service:spawned').map((event) => event.pid);
    expect(pids).toHaveLength(2);

    await sup.down('test');

    expect(sup.processes.map((process) => process.state)).toEqual(['stopped', 'stopped']);
    for (const pid of pids) {
      await waitUntil(() => !isAlive(pid), { label: `pid ${pid} to exit` });
    }
    expect(recorder.ofType('stack:stopped')).toHaveLength(1);
  });

  test('stops in reverse dependency order', async () => {
    const { supervisor: sup, recorder } = await start(`
name: t
defaults: { restart: never }
services:
  - { name: first, cmd: ${fake(['--name', 'first', '--interval', '30'])} }
  - { name: second, cmd: ${fake(['--name', 'second', '--interval', '30'])}, needs: [first] }
`);

    await sup.down('test');

    const stopping = recorder
      .ofType('service:state')
      .filter((event) => event.to === 'stopping')
      .map((event) => event.service);
    expect(stopping).toEqual(['second', 'first']);
  });

  test('kills the whole process tree — no orphaned grandchildren', async () => {
    const { supervisor: sup, recorder } = await start(`
name: t
defaults: { restart: never, stop: { graceMs: 1000 } }
services:
  - name: parent
    cmd: ${fake(['--name', 'parent', '--spawn-child', '--interval', '50'])}
`);

    await waitUntil(() => recorder.linesOf('parent').some((line) => line.includes('spawned child')), {
      label: 'the grandchild to be announced',
    });

    const line = recorder.linesOf('parent').find((entry) => entry.includes('spawned child'))!;
    const grandchildPid = Number(/spawned child (\d+)/.exec(line)![1]);
    expect(isAlive(grandchildPid)).toBe(true);

    const parentPid = recorder.ofType('service:spawned')[0]!.pid;
    await sup.down('test');

    await waitUntil(() => !isAlive(parentPid), { label: 'parent to exit' });
    await waitUntil(() => !isAlive(grandchildPid), {
      timeoutMs: 8_000,
      label: 'grandchild to be reaped with the tree',
    });
    expect(sup.get('parent')!.state).toBe('stopped');
  });

  test('a service that ignores SIGTERM is still taken down', async () => {
    const { supervisor: sup, recorder } = await start(`
name: t
defaults: { restart: never, stop: { graceMs: 500 } }
services:
  - name: stubborn
    cmd: ${fake(['--name', 'stubborn', '--ignore-sigterm', '--interval', '50'])}
`);

    const pid = recorder.ofType('service:spawned')[0]!.pid;
    await sup.down('test');

    await waitUntil(() => !isAlive(pid), { timeoutMs: 10_000, label: 'stubborn process to be force-killed' });
    expect(sup.get('stubborn')!.state).toBe('stopped');
  });

  test('down() is safe to call twice', async () => {
    const { supervisor: sup } = await start(`
name: t
defaults: { restart: never }
services:
  - { name: a, cmd: ${fake(['--name', 'a', '--interval', '30'])} }
`);

    await sup.down('first');
    await expect(sup.down('second')).resolves.toBeUndefined();
  });

  test('stopping during backoff cancels the pending restart', async () => {
    const { supervisor: sup, recorder } = await start(`
name: t
defaults:
  restart: on-failure
  backoff: { initialMs: 400, maxMs: 400, factor: 1, maxRestarts: 5, resetAfterMs: 60000 }
services:
  - { name: flaky, cmd: ${fake(['--name', 'flaky', '--exit', '1', '--after', '50', '--interval', '20'])} }
`);

    await waitUntil(() => supervisorState(sup, 'flaky') === 'backoff', { label: 'backoff state' });
    await sup.down('test');

    const spawnsBefore = recorder.ofType('service:spawned').length;
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(recorder.ofType('service:spawned').length).toBe(spawnsBefore);
    expect(sup.get('flaky')!.state).toBe('stopped');
  });
});

describe('individual control', () => {
  test('restart() gives the service a new pid', async () => {
    const { supervisor: sup, recorder } = await start(`
name: t
defaults: { restart: never }
services:
  - { name: a, cmd: ${fake(['--name', 'a', '--interval', '30'])} }
`);

    const firstPid = recorder.ofType('service:spawned')[0]!.pid;
    await sup.restart('a');

    const pids = recorder.ofType('service:spawned').map((event) => event.pid);
    expect(pids).toHaveLength(2);
    expect(pids[1]).not.toBe(firstPid);
    expect(sup.get('a')!.state).toBe('running');
    await waitUntil(() => !isAlive(firstPid), { label: 'the old process to exit' });
  });

  test('stop() then start() brings a service back', async () => {
    const { supervisor: sup } = await start(`
name: t
defaults: { restart: never }
services:
  - { name: a, cmd: ${fake(['--name', 'a', '--interval', '30'])} }
`);

    await sup.stopService('a');
    expect(sup.get('a')!.state).toBe('stopped');

    await sup.startService('a');
    expect(sup.get('a')!.state).toBe('running');
  });

  test('naming a service that does not exist lists the real ones', async () => {
    const { supervisor: sup } = await start(`
name: t
defaults: { restart: never }
services:
  - { name: a, cmd: ${fake(['--name', 'a', '--interval', '30'])} }
`);

    await expect(sup.restart('nope')).rejects.toThrow(/Available: a/);
  });
});

const supervisorState = (sup: Supervisor, name: string): string => sup.get(name)!.state;
