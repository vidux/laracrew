import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  addToDraft,
  createDraft,
  deriveServiceName,
  describeDraft,
  draftCommand,
  listDrafts,
  publishDraft,
  resolveDraft,
  type AddOptions,
} from '../src/cli/commands/draft.js';
import { prepareStack } from '../src/cli/commands/up.js';
import { buildProgram } from '../src/cli/program.js';
import { stripAnsi } from '../src/cli/render/colors.js';
import { ConfigError } from '../src/core/config/errors.js';
import { loadStack } from '../src/core/config/load.js';
import { TempHome } from './helpers.js';

let home: TempHome;
let cwd: string;

beforeEach(() => {
  home = new TempHome();
  cwd = path.join(home.root, 'work');
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => {
  home.cleanup();
});

const forward = (value: string): string => value.replace(/\\/g, '/');
const add = (options: Omit<AddOptions, 'cwd'>) => addToDraft({ cwd, ...options });

describe('draft: start', () => {
  test('writes <name>.laracrew.yaml with the name and command filled in', () => {
    const file = createDraft('runcommands', { cwd });

    expect(path.basename(file)).toBe('runcommands.laracrew.yaml');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('name: runcommands');
    expect(text).toContain('command: runcommands');
    expect(listDrafts(cwd)).toEqual([{ name: 'runcommands', file }]);
  });

  test('refuses to overwrite a draft unless forced', () => {
    createDraft('dual', { cwd });
    expect(() => createDraft('dual', { cwd })).toThrow(/already exists here/);
    expect(() => createDraft('dual', { cwd, force: true })).not.toThrow();
  });

  test('rejects a name that cannot be a folder or a command', () => {
    expect(() => createDraft('bad name', { cwd })).toThrow(/usable stack name/);
    expect(() => createDraft('publish', { cwd })).toThrow(/clash/);
  });
});

describe('draft: add', () => {
  test('the first mention of a project records its path; later ones reuse it', () => {
    createDraft('dual', { cwd });
    const api = home.makeProject('api');

    const first = add({ project: 'api', path: api, command: 'php artisan queue:work' });
    expect(first.project).toEqual({ key: 'api', path: forward(api), created: true });
    expect(first.service.name).toBe('api:queue:work');
    expect(first.services).toBe(1);

    const second = add({ project: 'api', command: 'php artisan schedule:work' });
    expect(second.project).toEqual({ key: 'api', path: forward(api), created: false });
    expect(second.service.name).toBe('api:schedule:work');
    expect(second.services).toBe(2);
  });

  test('a different path for a known project is an error, the same path is fine', () => {
    createDraft('dual', { cwd });
    const api = home.makeProject('api');
    const other = home.makeProject('other');
    add({ project: 'api', path: api, command: 'php artisan queue:work' });

    expect(() => add({ project: 'api', path: other, command: 'php artisan serve' })).toThrow(/already points at/);
    expect(() => add({ project: 'api', path: api, command: 'php artisan serve' })).not.toThrow();
  });

  test('a new project without --path is the current folder', () => {
    createDraft('dual', { cwd });
    const result = add({ project: 'here', command: 'php artisan queue:work' });
    expect(result.project?.path).toBe(forward(cwd));
  });

  test('the same command twice gets a numbered name', () => {
    createDraft('dual', { cwd });
    add({ project: 'api', command: 'php artisan schedule:work' });
    const again = add({ project: 'api', command: 'php artisan schedule:work' });
    expect(again.service.name).toBe('api:schedule:work-2');
  });

  test('--name overrides the derived name and must be free', () => {
    createDraft('dual', { cwd });
    add({ project: 'api', command: 'php artisan queue:work', name: 'api:queue' });
    expect(() => add({ project: 'api', command: 'php artisan queue:work', name: 'api:queue' })).toThrow(/already in the draft/);
    expect(describeDraft(cwd).services.map((service) => service.name)).toEqual(['api:queue']);
  });

  test('--default-state stopped writes autostart: false; running leaves it out', () => {
    createDraft('dual', { cwd });
    add({ project: 'api', command: 'php artisan queue:work' });
    add({ project: 'api', command: 'php artisan sync:listen', state: 'stopped' });

    const text = readFileSync(resolveDraft(cwd).file, 'utf8');
    expect(text.match(/autostart: false/g)).toHaveLength(1);
    expect(describeDraft(cwd).services.map((service) => service.autostart)).toEqual([true, false]);
  });

  test('an unknown --default-state is a config error', () => {
    createDraft('dual', { cwd });
    expect(() => add({ command: 'x', state: 'paused' })).toThrow(/"running" or "stopped"/);
  });

  test('a service without a project is pinned to --path or the current folder', () => {
    createDraft('solo', { cwd });
    const here = add({ command: 'npm run dev' });
    expect(here.service.name).toBe('dev');
    expect(here.service.cwd).toBe(forward(cwd));

    const web = home.makePlainProject('web');
    const there = add({ command: 'node server.js', path: web });
    expect(there.service.cwd).toBe(forward(web));
    expect(readFileSync(resolveDraft(cwd).file, 'utf8')).toContain(`cwd: ${forward(web)}`);
  });

  test('needs a draft in the folder', () => {
    expect(() => add({ command: 'x' })).toThrow(/no draft in/);
  });

  test('several drafts need --draft', () => {
    createDraft('a', { cwd });
    createDraft('b', { cwd });
    expect(() => add({ command: 'x' })).toThrow(/several drafts here.*a, b/);
    expect(add({ command: 'x', draft: 'b' }).draft).toBe('b');
    expect(() => add({ command: 'x', draft: 'c' })).toThrow(/no draft named "c"/);
  });

  test('keeps the comments a person wrote in the file', () => {
    const file = createDraft('dual', { cwd });
    writeFileSync(file, `${readFileSync(file, 'utf8')}# keep me\n`, 'utf8');
    add({ command: 'x' });
    expect(readFileSync(file, 'utf8')).toContain('# keep me');
  });
});

describe('deriveServiceName', () => {
  test.each([
    ['php artisan queue:work redis --queue=high,default', 'api', 'api:queue:work'],
    ['php artisan serve --port=8000', 'api', 'api:serve'],
    ['C:\\php\\php.exe artisan schedule:work', 'api', 'api:schedule:work'],
    ['npm run dev', 'web', 'web:dev'],
    ['node server.js', undefined, 'server'],
    ['redis-server', undefined, 'redis-server'],
    ['python manage.py runserver', 'shop', 'shop:manage'],
  ])('%s → %s', (command, project, expected) => {
    expect(deriveServiceName(command, project)).toBe(expected);
  });
});

describe('draft: publish', () => {
  test('installs the draft as a stack that loads and resolves', () => {
    createDraft('dual', { cwd });
    const api = home.makeProject('api');
    add({ project: 'api', path: api, command: 'php artisan queue:work' });
    add({ project: 'api', command: 'php artisan schedule:work', state: 'stopped' });

    const result = publishDraft({ cwd, env: home.env });

    expect(result.target).toBe(path.join(home.root, 'stacks', 'dual', 'stack.yaml'));
    expect(result.replaced).toBe(false);
    expect(existsSync(result.file)).toBe(true); // the draft stays put

    const { config } = loadStack('dual', home.env);
    expect(config.command).toBe('dual');
    expect(config.services.map((service) => service.name)).toEqual(['api:queue:work', 'api:schedule:work']);
    expect(config.services[1]!.autostart).toBe(false);

    const stack = prepareStack('dual', { env: home.env });
    expect(path.resolve(stack.services[0]!.cwd)).toBe(path.resolve(api));
    expect(stack.levels).toEqual([['api:queue:work', 'api:schedule:work']]);
  });

  test('an empty draft cannot be published', () => {
    createDraft('dual', { cwd });
    expect(() => publishDraft({ cwd, env: home.env })).toThrow(/no services yet/);
  });

  test('refuses to replace an existing stack unless forced', () => {
    createDraft('dual', { cwd });
    add({ command: 'x' });
    publishDraft({ cwd, env: home.env });

    expect(() => publishDraft({ cwd, env: home.env })).toThrow(/already exists/);
    expect(publishDraft({ cwd, env: home.env, force: true }).replaced).toBe(true);
  });

  test('a hand edit that breaks the schema is reported against the draft file', () => {
    const file = createDraft('dual', { cwd });
    add({ command: 'x' });
    writeFileSync(file, readFileSync(file, 'utf8').replace('cmd: x', 'cmd: x\n    nonsense: 1'), 'utf8');

    let caught: unknown;
    try {
      publishDraft({ cwd, env: home.env });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).file).toBe(file);
    expect((caught as ConfigError).details.join('\n')).toMatch(/unknown field "nonsense"/);
  });

  test('the stack folder follows `name:` in the file, not the file name', () => {
    const file = createDraft('scratch', { cwd });
    add({ command: 'x' });
    writeFileSync(file, readFileSync(file, 'utf8').replace('name: scratch', 'name: real'), 'utf8');

    expect(publishDraft({ cwd, env: home.env }).name).toBe('real');
    expect(existsSync(path.join(home.root, 'stacks', 'real', 'stack.yaml'))).toBe(true);
  });
});

describe('draft: show', () => {
  test('lists projects and services in the order they were added', () => {
    createDraft('dual', { cwd });
    const api = home.makeProject('api');
    add({ project: 'api', path: api, command: 'php artisan queue:work' });
    add({ command: 'npm run dev', state: 'stopped' });

    const summary = describeDraft(cwd);
    expect(summary.stackName).toBe('dual');
    expect(summary.command).toBe('dual');
    expect(summary.projects).toEqual([{ key: 'api', path: forward(api) }]);
    expect(summary.services).toEqual([
      { name: 'api:queue:work', cmd: 'php artisan queue:work', project: 'api', autostart: true },
      { name: 'dev', cmd: 'npm run dev', autostart: false },
    ]);
  });
});

describe('draft: command layer', () => {
  test('`draft <name>` starts a draft, then shows it; several drafts need a name', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(draftCommand('dual', {}, cwd, home.env)).toBe(0);
      const file = resolveDraft(cwd).file;
      add({ command: 'x' });
      const before = readFileSync(file, 'utf8');

      expect(draftCommand('dual', {}, cwd, home.env)).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(stripAnsi(log.mock.calls.flat().join('\n'))).toContain('SERVICES (1)');

      expect(draftCommand(undefined, {}, cwd, home.env)).toBe(0);
      createDraft('other', { cwd });
      expect(() => draftCommand(undefined, {}, cwd, home.env)).toThrow(/several drafts here: dual, other.*laracrew draft <name>/);
      expect(draftCommand('other', {}, cwd, home.env)).toBe(0);
    } finally {
      log.mockRestore();
    }
  });
});

describe('draft: cli wiring', () => {
  test('help lists draft with add and publish beneath it', () => {
    const program = buildProgram();
    expect(stripAnsi(program.helpInformation())).toMatch(/^  draft\b/m);

    const draft = program.commands.find((command) => command.name() === 'draft')!;
    expect(draft.commands.map((command) => command.name()).sort()).toEqual(['add', 'publish']);
    const addCommand = draft.commands.find((command) => command.name() === 'add')!;
    expect(stripAnsi(addCommand.helpInformation())).toMatch(/--default-state/);
  });
});
