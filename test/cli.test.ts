import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { runInit } from '../src/cli/commands/init.js';
import { declaredPorts, runDoctor } from '../src/cli/commands/doctor.js';
import { prepareStack } from '../src/cli/commands/up.js';
import { fileURLToPath } from 'node:url';
import { VERSION, resolveStackName } from '../src/cli/program.js';
import { attachPlainRenderer } from '../src/cli/render/plain.js';
import { createPainter, stripAnsi, supportsColor } from '../src/cli/render/colors.js';
import { EventEmitter } from 'node:events';
import { EventBus } from '../src/core/events/bus.js';
import {
  installPipeGuards,
  onOutputClosed,
  outputClosed,
  resetOutputState,
  write,
} from '../src/cli/render/output.js';
import { listStacks } from '../src/core/config/load.js';
import { TempHome, yamlPath } from './helpers.js';

let home: TempHome;

beforeEach(() => {
  home = new TempHome();
});
afterEach(() => {
  home.cleanup();
});

describe('init', () => {
  test('creates a bare home without examples by default', () => {
    const result = runInit(home.env);

    expect(existsSync(path.join(result.root, 'config.yaml'))).toBe(true);
    expect(existsSync(path.join(result.root, 'projects.yaml'))).toBe(true);
    expect(existsSync(path.join(result.root, 'stacks'))).toBe(true);
    // The demo and template stacks are opt-in.
    expect(existsSync(path.join(result.root, 'stacks', 'example'))).toBe(false);
    expect(existsSync(path.join(result.root, 'stacks', 'dual'))).toBe(false);
    expect(existsSync(path.join(result.root, 'tasks', 'reset.yaml'))).toBe(false);
    expect(listStacks(home.env)).toEqual([]);
    expect(result.examples).toBe(false);
  });

  test('--examples adds the demo stack and the two-project template', () => {
    const result = runInit(home.env, { examples: true });

    expect(existsSync(path.join(result.root, 'config.yaml'))).toBe(true);
    expect(existsSync(path.join(result.root, 'projects.yaml'))).toBe(true);
    expect(existsSync(path.join(result.root, 'stacks', 'example', 'stack.yaml'))).toBe(true);
    expect(existsSync(path.join(result.root, 'tasks', 'reset.yaml'))).toBe(true);
    expect(listStacks(home.env).sort()).toEqual(['dual', 'example']);
  });

  test('the shipped example stack parses and resolves', () => {
    runInit(home.env, { examples: true });
    const stack = prepareStack('example', { env: home.env });

    expect(stack.services.map((service) => service.name)).toEqual([
      'demo:heartbeat',
      'demo:worker',
      'demo:slow-starter',
    ]);
    expect(stack.levels[0]).toEqual(['demo:heartbeat', 'demo:slow-starter']);
  });

  test('the example stack honours its own profile', () => {
    runInit(home.env, { examples: true });
    const stack = prepareStack('example', { env: home.env, profile: 'quiet' });
    expect(stack.services.some((service) => service.name === 'demo:slow-starter')).toBe(false);
  });

  test('re-running never clobbers an edited file', () => {
    runInit(home.env, { examples: true });
    const configFile = path.join(home.root, 'config.yaml');
    home.write('config.yaml', 'theme: mono\n');

    const second = runInit(home.env, { examples: true });

    expect(second.created).toHaveLength(0);
    expect(second.skipped.length).toBeGreaterThan(0);
    expect(readFileSync(configFile, 'utf8')).toBe('theme: mono\n');
  });
});

describe('resolveStackName', () => {
  test('uses the only stack when there is exactly one', () => {
    home.writeStack('solo', 'name: solo\nservices:\n  - { name: a, cmd: "node -e 0" }\n');
    expect(resolveStackName(undefined, home.env)).toBe('solo');
  });

  test('prefers the configured default', () => {
    runInit(home.env, { examples: true });
    home.write('config.yaml', 'defaultStack: dual\n');
    expect(resolveStackName(undefined, home.env)).toBe('dual');
  });

  test('asks which one when several exist and none is default', () => {
    runInit(home.env, { examples: true });
    expect(() => resolveStackName(undefined, home.env)).toThrow(/several stacks exist.*dual, example/s);
  });

  test('says what to do when there is nothing at all', () => {
    expect(() => resolveStackName(undefined, home.env)).toThrow(/laracrew init/);
  });

  test('an explicit name always wins', () => {
    runInit(home.env, { examples: true });
    home.write('config.yaml', 'defaultStack: dual\n');
    expect(resolveStackName('example', home.env)).toBe('example');
  });
});

describe('doctor', () => {
  const writeDualStack = (apiEnv: Record<string, string>, portalEnv: Record<string, string>, extra = '') => {
    const api = home.makeProject('api', apiEnv);
    const portal = home.makeProject('portal', portalEnv);
    home.write(
      'projects.yaml',
      `projects:
  api: { path: "${yamlPath(api)}" }
  portal: { path: "${yamlPath(portal)}" }
`,
    );
    home.writeStack(
      'dual',
      `
name: dual
use: [api, portal]
services:
  - name: api:queue
    project: api
    cmd: php artisan queue:work redis --queue=default
    metrics: { queues: [default] }
  - name: portal:queue
    project: portal
    cmd: php artisan queue:work redis --queue=default
    metrics: { queues: [default] }
${extra}`,
    );
  };

  test('flags two projects sharing one Redis namespace and a queue name', async () => {
    writeDualStack(
      { QUEUE_CONNECTION: 'redis', REDIS_HOST: '127.0.0.1', REDIS_PORT: '6379', REDIS_DB: '0' },
      { QUEUE_CONNECTION: 'redis', REDIS_HOST: '127.0.0.1', REDIS_PORT: '6379', REDIS_DB: '0' },
    );

    const findings = await runDoctor('dual', home.env);
    const collision = findings.find((finding) => /share Redis .* AND queue/.test(finding.message));

    expect(collision).toBeDefined();
    expect(collision!.level).toBe('error');
    expect(collision!.hint).toMatch(/steal the other's jobs/);
  });

  test('stays quiet when the projects use different Redis databases', async () => {
    writeDualStack(
      { QUEUE_CONNECTION: 'redis', REDIS_DB: '0' },
      { QUEUE_CONNECTION: 'redis', REDIS_DB: '1' },
    );

    const findings = await runDoctor('dual', home.env);
    expect(findings.some((finding) => /share Redis/.test(finding.message))).toBe(false);
  });

  test('flags a queue worker running against QUEUE_CONNECTION=sync', async () => {
    writeDualStack({ QUEUE_CONNECTION: 'sync' }, { QUEUE_CONNECTION: 'redis', REDIS_DB: '1' });

    const findings = await runDoctor('dual', home.env);
    const sync = findings.find((finding) => /QUEUE_CONNECTION=sync/.test(finding.message));

    expect(sync).toBeDefined();
    expect(sync!.level).toBe('error');
  });

  test('reports a port that is already bound', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const api = home.makeProject('api', { QUEUE_CONNECTION: 'redis' });
      home.write('projects.yaml', `projects:\n  api: { path: "${yamlPath(api)}" }\n`);
      home.writeStack(
        'ports',
        `
name: ports
use: [api]
services:
  - { name: api:serve, project: api, cmd: "php artisan serve --port=${port}" }
`,
      );

      const findings = await runDoctor('ports', home.env);
      const busy = findings.find((finding) => finding.message === `port ${port} is already in use`);
      expect(busy?.level).toBe('error');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('turns a config error into a single readable finding', async () => {
    home.writeStack('broken', 'name: broken\nservices:\n  - { name: a, nonsense: 1 }\n');
    const findings = await runDoctor('broken', home.env);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.level).toBe('error');
    expect(findings[0]!.message).toMatch(/unknown field "nonsense"/);
  });

  test('declaredPorts finds both ${port:} tokens and --port arguments', () => {
    home.writeStack(
      'p',
      `
name: p
services:
  - { name: a, cmd: "node server.js --port=\${port:8000}" }
  - { name: b, cmd: "node other.js --port 9100" }
`,
    );
    expect(declaredPorts(prepareStack('p', { env: home.env }))).toEqual([8000, 9100]);
  });
});

describe('version', () => {
  test('matches package.json — a hardcoded copy drifts and ships wrong', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
    ) as { version: string };

    expect(VERSION).toBe(pkg.version);
  });
});

describe('doctor on stacks that are not Laravel', () => {
  /** A binary that cannot exist, so a stray PHP check shows up as a hard error. */
  const NO_PHP = 'php-not-installed-anywhere';

  test('never runs php for a stack that has none', async () => {
    const app = home.makePlainProject('app');
    home.writeStack(
      'py',
      `
name: py
projects:
  app: { path: "${yamlPath(app)}", php: "${NO_PHP}" }
services:
  - { name: web, project: app, cmd: ["python", "-u", "manage.py", "runserver"] }
  - { name: worker, project: app, cmd: ["celery", "-A", "app", "worker"] }
`,
    );

    const findings = await runDoctor('py', home.env);

    expect(findings.some((finding) => finding.message.includes(NO_PHP))).toBe(false);
    expect(findings.filter((finding) => finding.level === 'error')).toEqual([]);
  });

  test('a project that only runs php through stop.artisan still gets the php check', async () => {
    const app = home.makePlainProject('app');
    home.writeStack(
      'hybrid',
      `
name: hybrid
projects:
  app: { path: "${yamlPath(app)}", php: "${NO_PHP}" }
services:
  - name: worker
    project: app
    cmd: ["node", "worker.js"]
    stop: { artisan: "queue:restart" }
`,
    );

    const findings = await runDoctor('hybrid', home.env);
    expect(findings.some((finding) => finding.message.includes(`cannot run "${NO_PHP}"`))).toBe(true);
  });

  test('no artisan warning for a project nothing runs php for', async () => {
    const app = home.makePlainProject('app');
    home.writeStack(
      'node',
      `
name: node
projects:
  app: { path: "${yamlPath(app)}" }
services:
  - { name: api, project: app, cmd: ["node", "server.js"] }
`,
    );

    const findings = await runDoctor('node', home.env);
    expect(findings.some((finding) => /artisan/.test(finding.message))).toBe(false);
    expect(findings.some((finding) => /is missing or empty/.test(finding.message))).toBe(false);
  });

  test('two projects that never touch Redis do not collide on the default namespace', async () => {
    const api = home.makePlainProject('api');
    const web = home.makePlainProject('web');
    home.writeStack(
      'pair',
      `
name: pair
projects:
  api: { path: "${yamlPath(api)}" }
  web: { path: "${yamlPath(web)}" }
services:
  - { name: api:serve, project: api, cmd: ["node", "api.js"] }
  - { name: web:serve, project: web, cmd: ["node", "web.js"] }
`,
    );

    const findings = await runDoctor('pair', home.env);
    expect(findings.some((finding) => /share Redis/.test(finding.message))).toBe(false);
    expect(findings.some((finding) => /redis .*reachable/.test(finding.message))).toBe(false);
  });

  test('external dependencies are probed through their own declared gate', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      home.writeStack(
        'deps',
        `
name: deps
services:
  - { name: postgres, external: true, ready: { tcp: "127.0.0.1:${port}" } }
  - { name: rabbit, external: true, ready: { tcp: "127.0.0.1:1" } }
  - { name: api, cmd: ["node", "api.js"], cwd: "${yamlPath(home.root)}" }
`,
      );

      const findings = await runDoctor('deps', home.env);
      const up = findings.find((finding) => finding.message.startsWith('postgres is reachable'));
      const down = findings.find((finding) => finding.message.startsWith('rabbit is not reachable'));

      expect(up?.level).toBe('ok');
      expect(down?.level).toBe('warn');
      expect(down?.hint).toMatch(/never starts an external service/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('a redis external service is not probed twice', async () => {
    const api = home.makeProject('api', { QUEUE_CONNECTION: 'redis', REDIS_HOST: '127.0.0.1', REDIS_PORT: '6379' });
    home.write('projects.yaml', `projects:\n  api: { path: "${yamlPath(api)}" }\n`);
    home.writeStack(
      'once',
      `
name: once
use: [api]
services:
  - { name: redis, external: true, ready: { tcp: "127.0.0.1:6379" } }
  - { name: api:queue, project: api, cmd: "php artisan queue:work" }
`,
    );

    const findings = await runDoctor('once', home.env);
    expect(findings.filter((finding) => /127\.0\.0\.1:6379/.test(finding.message))).toHaveLength(1);
  });

  test('REDIS_URL supplies the host and port when REDIS_HOST does not', async () => {
    const app = home.makePlainProject('app', { REDIS_URL: 'redis://127.0.0.1:6399/2' });
    home.writeStack(
      'url',
      `
name: url
projects:
  app: { path: "${yamlPath(app)}" }
services:
  - { name: worker, project: app, cmd: ["celery", "-A", "app", "worker"] }
`,
    );

    const findings = await runDoctor('url', home.env);
    expect(findings.some((finding) => /redis not reachable at 127\.0\.0\.1:6399/.test(finding.message))).toBe(true);
  });
});

describe('plain renderer', () => {
  const render = (events: Parameters<EventBus['emit']>[0][]): string => {
    home.writeStack(
      't',
      'name: t\nservices:\n  - { name: api:queue, cmd: "node -e 0", color: cyan }\n',
    );
    const stack = prepareStack('t', { env: home.env });
    const bus = new EventBus();
    let out = '';
    attachPlainRenderer(bus, {
      stack,
      write: (text) => {
        out += text;
      },
      painter: createPainter(false),
      now: () => new Date(2026, 0, 1, 14, 22, 1),
    });
    for (const event of events) bus.emit(event);
    return out;
  };

  test('prefixes each line with the service name and a timestamp', () => {
    const out = render([
      { type: 'service:log', log: { service: 'api:queue', stream: 'stdout', line: 'Processing job', at: 0 } },
    ]);
    expect(out).toBe('14:22:01 api:queue | Processing job\n');
  });

  test('reports a crash and the scheduled restart', () => {
    const out = render([
      { type: 'service:exit', service: 'api:queue', code: 1, signal: null, intentional: false, at: 0 },
      { type: 'service:restart', service: 'api:queue', attempt: 2, maxAttempts: 10, delayMs: 2000, at: 0 },
    ]);
    expect(out).toContain('exited (code 1)');
    expect(out).toContain('restarting in 2000ms (attempt 2/10)');
  });

  test('stays silent about an intentional exit', () => {
    const out = render([
      { type: 'service:exit', service: 'api:queue', code: 0, signal: null, intentional: true, at: 0 },
    ]);
    expect(out).toBe('');
  });

  test('labels its own messages as laracrew', () => {
    const out = render([{ type: 'stack:ready', stack: 't', durationMs: 1500, at: 0 }]);
    expect(out).toContain('laracrew');
    expect(out).toContain('ready in 1.5s');
  });
});

describe('colors', () => {
  test('NO_COLOR wins over a TTY', () => {
    expect(supportsColor({ isTTY: true }, { NO_COLOR: '1' } as NodeJS.ProcessEnv)).toBe(false);
  });

  test('FORCE_COLOR turns it on for a pipe', () => {
    expect(supportsColor({ isTTY: false }, { FORCE_COLOR: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });

  test('a disabled painter emits no escape codes', () => {
    expect(createPainter(false)('red', 'boom')).toBe('boom');
  });

  test('stripAnsi undoes an enabled painter', () => {
    expect(stripAnsi(createPainter(true)('red', 'boom'))).toBe('boom');
  });
});

describe('broken pipe', () => {
  beforeEach(() => {
    resetOutputState();
  });
  afterEach(() => {
    resetOutputState();
  });

  /** A stand-in for stdout that can fail the way a closed pipe does. */
  class FakeStream extends EventEmitter {
    written: string[] = [];
    failWith?: NodeJS.ErrnoException;

    write(chunk: string): boolean {
      if (this.failWith) throw this.failWith;
      this.written.push(chunk);
      return true;
    }
  }

  const epipe = (): NodeJS.ErrnoException =>
    Object.assign(new Error('write EPIPE'), { code: 'EPIPE' } as const);

  test('an EPIPE error event marks output closed instead of throwing', () => {
    const stream = new FakeStream();
    installPipeGuards([stream]);

    expect(outputClosed()).toBe(false);
    expect(() => stream.emit('error', epipe())).not.toThrow();
    expect(outputClosed()).toBe(true);
  });

  test('a non-pipe stream error still propagates', () => {
    const stream = new FakeStream();
    installPipeGuards([stream]);

    const boom = Object.assign(new Error('disk on fire'), { code: 'ENOSPC' });
    expect(() => stream.emit('error', boom)).toThrow(/disk on fire/);
  });

  test('writes stop once the reader has gone', () => {
    const stream = new FakeStream();
    installPipeGuards([stream]);

    write('first\n', stream);
    stream.emit('error', epipe());
    write('second\n', stream);

    expect(stream.written).toEqual(['first\n']);
  });

  test('a throwing write marks output closed rather than crashing', () => {
    const stream = new FakeStream();
    stream.failWith = epipe();

    expect(() => write('anything\n', stream)).not.toThrow();
    expect(outputClosed()).toBe(true);
  });

  test('subscribers are notified so the stack can shut down', () => {
    const stream = new FakeStream();
    installPipeGuards([stream]);

    let shutdowns = 0;
    onOutputClosed(() => {
      shutdowns += 1;
    });

    stream.emit('error', epipe());
    stream.emit('error', epipe());

    expect(shutdowns).toBe(1);
  });

  test('a subscriber registered after the close still fires', () => {
    const stream = new FakeStream();
    installPipeGuards([stream]);
    stream.emit('error', epipe());

    let called = false;
    onOutputClosed(() => {
      called = true;
    });

    expect(called).toBe(true);
  });
});
