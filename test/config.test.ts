import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { interpolate, interpolateDeep } from '../src/core/config/interpolate.js';
import { ConfigError, didYouMean } from '../src/core/config/errors.js';
import { loadStack, loadSharedProjects, listStacks } from '../src/core/config/load.js';
import { resolveStack, topoLevels, type ResolvedService } from '../src/core/config/resolve.js';
import { TempHome, yamlPath } from './helpers.js';

let home: TempHome;

beforeEach(() => {
  home = new TempHome();
});
afterEach(() => {
  home.cleanup();
});

describe('interpolate', () => {
  const ctx = {
    env: { FOO: 'bar', EMPTY: '' } as NodeJS.ProcessEnv,
    project: { path: 'D:/work/api', env: { REDIS_PORT: '6380', APP_URL: 'http://localhost' } },
    stackDir: 'C:/home/.laracrew/stacks/dual',
    ports: new Set<number>(),
  };

  test('substitutes env vars', () => {
    expect(interpolate('x=${env:FOO}', ctx)).toBe('x=bar');
  });

  test('uses a fallback when the var is unset', () => {
    expect(interpolate('${env:NOPE:default-value}', ctx)).toBe('default-value');
  });

  test('prefers a set-but-empty var over the fallback', () => {
    expect(interpolate('[${env:EMPTY:fallback}]', ctx)).toBe('[]');
  });

  test('throws with the variable name when unset and no fallback', () => {
    expect(() => interpolate('${env:MISSING}', ctx)).toThrow(/MISSING/);
  });

  test('reads project path and project .env', () => {
    expect(interpolate('${project.path}/artisan', ctx)).toBe('D:/work/api/artisan');
    expect(interpolate('redis:${project.env:REDIS_PORT}', ctx)).toBe('redis:6380');
  });

  test('records ports for the collision check', () => {
    const ports = new Set<number>();
    expect(interpolate('--port=${port:8001}', { ...ctx, ports })).toBe('--port=8001');
    expect([...ports]).toEqual([8001]);
  });

  test('rejects an unknown token by name', () => {
    expect(() => interpolate('${wat:1}', ctx)).toThrow(/unknown token/);
  });

  test('handles several tokens in one string', () => {
    expect(interpolate('${env:FOO}-${project.path}-${port:9000}', ctx)).toBe('bar-D:/work/api-9000');
  });

  test('walks nested structures and skips prototype keys', () => {
    const input = JSON.parse('{"a":"${env:FOO}","b":{"__proto__":"x","c":["${env:FOO}"]}}') as Record<string, unknown>;
    const out = interpolateDeep(input, ctx) as { a: string; b: { c: string[]; __proto__?: unknown } };
    expect(out.a).toBe('bar');
    expect(out.b.c[0]).toBe('bar');
    expect(Object.hasOwn(out.b, '__proto__')).toBe(false);
  });
});

describe('didYouMean', () => {
  test('finds a near miss', () => {
    expect(didYouMean('watchs', ['watch', 'metrics', 'needs'])).toBe('watch');
  });
  test('stays quiet when nothing is close', () => {
    expect(didYouMean('zzzzzzzz', ['watch', 'metrics'])).toBeUndefined();
  });
});

const minimalStack = (extra = '') => `
name: demo
services:
  - name: a
    cmd: ["node", "-e", "0"]
${extra}`;

describe('loadStack', () => {
  test('reports the file and a suggestion for an unknown field', () => {
    home.writeStack(
      'demo',
      `
name: demo
services:
  - name: a
    cmd: ["node", "-e", "0"]
    watchs: { paths: [app] }
`,
    );

    try {
      loadStack('demo', home.env);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.file).toMatch(/stack\.yaml$/);
      expect(configError.format()).toMatch(/unknown field "watchs".*did you mean "watch"/s);
    }
  });

  test('turns a YAML syntax error into a ConfigError', () => {
    home.writeStack('demo', 'name: demo\nservices:\n  - name: a\n   cmd: broken indent\n');
    expect(() => loadStack('demo', home.env)).toThrow(ConfigError);
  });

  test('insists the folder name and `name:` match', () => {
    home.writeStack('demo', 'name: other\nservices:\n  - { name: a, cmd: "node -e 0" }\n');
    expect(() => loadStack('demo', home.env)).toThrow(/folder is "demo".*says "other"/);
  });

  test('lists what does exist when the stack is missing', () => {
    home.writeStack('demo', minimalStack());
    expect(() => loadStack('nope', home.env)).toThrow(/Available: demo/);
  });

  test('merges services/*.yaml fragments', () => {
    home.writeStack('demo', minimalStack());
    home.writeFragment('demo', 'extra.yaml', 'services:\n  - { name: b, cmd: "node -e 0" }\n');
    home.writeFragment('demo', 'more.yaml', '- { name: c, cmd: "node -e 0" }\n');

    const { config } = loadStack('demo', home.env);
    expect(config.services.map((service) => service.name)).toEqual(['a', 'b', 'c']);
  });

  test('listStacks only counts folders that hold a stack.yaml', () => {
    home.writeStack('demo', minimalStack());
    home.write('stacks/empty/README.md', 'not a stack');
    expect(listStacks(home.env)).toEqual(['demo']);
  });
});

describe('resolveStack', () => {
  const twoProjectStack = () => {
    const api = home.makeProject('api', { QUEUE_CONNECTION: 'redis', REDIS_PORT: '6379' });
    const portal = home.makeProject('portal', { QUEUE_CONNECTION: 'redis', REDIS_DB: '1' });
    home.write(
      'projects.yaml',
      `projects:
  api: { path: "${yamlPath(api)}", color: cyan }
  portal: { path: "${yamlPath(portal)}", color: magenta }
`,
    );
    home.writeStack(
      'dual',
      `
name: dual
use: [api, portal]
defaults:
  restart: always
  stop: { graceMs: 4000 }
services:
  - name: redis
    external: true
    ready: { tcp: "127.0.0.1:6379" }
  - name: api:serve
    project: api
    cmd: php artisan serve --port=\${port:8000}
    groups: [http]
    needs: [redis]
  - name: api:queue
    project: api
    cmd: php artisan queue:work
    groups: [workers]
    needs: [redis]
    stop: { artisan: "queue:restart" }
  - name: portal:serve
    project: portal
    cmd: php artisan serve --port=\${port:8001}
    groups: [http]
    needs: [api:serve]
  - name: api:vite
    project: api
    cmd: npm run dev
    groups: [assets]
profiles:
  light: { except: [assets] }
  workers: { only: [workers] }
`,
    );
    return { api, portal };
  };

  const resolve = (options = {}) =>
    resolveStack(loadStack('dual', home.env), {
      sharedProjects: loadSharedProjects(home.env),
      env: home.env,
      ...options,
    });

  test('orders services into parallel levels', () => {
    twoProjectStack();
    const stack = resolve();
    expect(stack.levels[0]).toContain('redis');
    const apiServeLevel = stack.levels.findIndex((level) => level.includes('api:serve'));
    const portalServeLevel = stack.levels.findIndex((level) => level.includes('portal:serve'));
    expect(portalServeLevel).toBeGreaterThan(apiServeLevel);
  });

  test('inherits stack defaults and lets a service override them', () => {
    twoProjectStack();
    const stack = resolve();
    const byName = new Map(stack.services.map((service) => [service.name, service] as const));
    expect(byName.get('api:serve')!.restart).toBe('always');
    expect(byName.get('api:serve')!.stop.graceMs).toBe(4000);
    expect(byName.get('api:queue')!.stop.artisan).toBe('queue:restart');
    expect(byName.get('api:queue')!.stop.graceMs).toBe(4000);
  });

  test('sets cwd from the project and collects declared ports', () => {
    const { api } = twoProjectStack();
    const stack = resolve();
    const serve = stack.services.find((service) => service.name === 'api:serve')!;
    expect(serve.cwd).toBe(api);
    expect(stack.ports).toEqual([8000, 8001]);
  });

  test('--only filters by group', () => {
    twoProjectStack();
    const stack = resolve({ only: ['workers'] });
    expect(stack.services.map((service) => service.name)).toEqual(['api:queue']);
  });

  test('--except filters by group, and drops now-dangling needs', () => {
    twoProjectStack();
    const stack = resolve({ except: ['http', 'assets'] });
    const queue = stack.services.find((service) => service.name === 'api:queue')!;
    expect(stack.services.map((service) => service.name).sort()).toEqual(['api:queue', 'redis']);
    expect(queue.needs).toEqual(['redis']);
  });

  test('a profile applies the same filtering', () => {
    twoProjectStack();
    const stack = resolve({ profile: 'light' });
    expect(stack.services.some((service) => service.name === 'api:vite')).toBe(false);
  });

  test('an unknown profile suggests a real one', () => {
    twoProjectStack();
    expect(() => resolve({ profile: 'ligth' })).toThrow(/did you mean "light"/);
  });

  test('a filtered-out dependency does not block the survivors', () => {
    twoProjectStack();
    const stack = resolve({ only: ['portal:serve'] });
    expect(stack.services[0]!.needs).toEqual([]);
    expect(stack.levels).toEqual([['portal:serve']]);
  });

  test('rejects a service pointing at an undeclared project', () => {
    home.writeStack('dual', 'name: dual\nservices:\n  - { name: a, cmd: "node -e 0", project: ghost }\n');
    expect(() => resolve()).toThrow(/project "ghost"/);
  });

  test('rejects duplicate service names', () => {
    home.writeStack(
      'dual',
      'name: dual\nservices:\n  - { name: a, cmd: "node -e 0" }\n  - { name: a, cmd: "node -e 1" }\n',
    );
    expect(() => resolve()).toThrow(/both named "a"/);
  });
});

describe('autostart', () => {
  test('defaults to true', () => {
    home.writeStack('s', `
name: s
services:
  - { name: a, cmd: "node -e 0" }
`);
    const stack = resolveStack(loadStack('s', home.env), { env: home.env });
    expect(stack.services[0]!.autostart).toBe(true);
  });

  test('carries autostart:false through to the resolved service', () => {
    home.writeStack('s', `
name: s
services:
  - { name: a, cmd: "node -e 0", autostart: false }
`);
    const stack = resolveStack(loadStack('s', home.env), { env: home.env });
    expect(stack.services[0]!.autostart).toBe(false);
  });

  test('rejects an auto-started service that depends on a manual one', () => {
    home.writeStack(
      's',
      `name: s
services:
  - { name: manual, cmd: "node -e 0", autostart: false }
  - { name: auto, cmd: "node -e 0", needs: [manual] }
`,
    );
    expect(() => resolveStack(loadStack('s', home.env), { env: home.env })).toThrow(
      /starts at launch but needs "manual"/,
    );
  });

  test('allows a manual service to depend on another manual one', () => {
    home.writeStack(
      's',
      `name: s
services:
  - { name: first, cmd: "node -e 0", autostart: false }
  - { name: second, cmd: "node -e 0", autostart: false, needs: [first] }
`,
    );
    expect(() => resolveStack(loadStack('s', home.env), { env: home.env })).not.toThrow();
  });

  test('an external dependency never blocks an auto-started service', () => {
    home.writeStack(
      's',
      `name: s
services:
  - { name: redis, external: true, autostart: false, ready: { delayMs: 1 } }
  - { name: auto, cmd: "node -e 0", needs: [redis] }
`,
    );
    expect(() => resolveStack(loadStack('s', home.env), { env: home.env })).not.toThrow();
  });
});

describe('topoLevels', () => {
  const service = (name: string, needs: string[] = []): ResolvedService =>
    ({ name, needs, groups: [], external: false }) as unknown as ResolvedService;

  test('groups independent services into one level', () => {
    expect(topoLevels([service('a'), service('b'), service('c', ['a', 'b'])])).toEqual([['a', 'b'], ['c']]);
  });

  test('names the members of a cycle', () => {
    expect(() => topoLevels([service('a', ['b']), service('b', ['a'])])).toThrow(/cycle between: a -> b/);
  });

  test('suggests a real service for a typo in needs', () => {
    expect(() => topoLevels([service('redis'), service('a', ['redsi'])])).toThrow(/did you mean "redis"/);
  });
});
