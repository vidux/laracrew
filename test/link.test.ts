import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  MARKER,
  cmdShim,
  linkStack,
  listLinks,
  ps1Shim,
  entryScript,
  resolveBinDir,
  shShim,
  shimFiles,
  unlinkCommandName,
} from '../src/cli/commands/link.js';
import { runInit } from '../src/cli/commands/init.js';
import { TempHome } from './helpers.js';

let home: TempHome;
let binDir: string;

beforeEach(() => {
  home = new TempHome();
  binDir = path.join(home.root, 'testbin');
  mkdirSync(binDir, { recursive: true });
  runInit(home.env, { examples: true });
});
afterEach(() => {
  home.cleanup();
});

const target = { node: 'C:/Program Files/nodejs/node.exe', entry: 'C:/app/dist/index.js', stack: 'dual' };

describe('shim contents', () => {
  test('the sh shim execs node with the stack and forwards arguments', () => {
    const shim = shShim(target);
    expect(shim).toContain('#!/bin/sh');
    expect(shim).toContain(MARKER);
    expect(shim).toContain('"C:/app/dist/index.js" up dual "$@"');
  });

  test('the cmd shim quotes paths with spaces and forwards %*', () => {
    const shim = cmdShim(target);
    expect(shim).toContain('"C:/Program Files/nodejs/node.exe"');
    expect(shim).toContain('up dual %*');
  });

  test('the PowerShell shim propagates the exit code', () => {
    const shim = ps1Shim(target);
    expect(shim).toContain('@args');
    expect(shim).toContain('exit $LASTEXITCODE');
  });

  test('Windows gets three files, POSIX gets one', () => {
    const files = shimFiles('dual', target).map((entry) => entry.file);
    if (process.platform === 'win32') {
      expect(files).toEqual(['dual', 'dual.cmd', 'dual.ps1']);
    } else {
      expect(files).toEqual(['dual']);
    }
  });
});

describe('linkStack', () => {
  test('names the command after the stack.yaml `command:` key', () => {
    const result = linkStack('example', { dir: binDir, env: home.env });
    expect(result.name).toBe('demo'); // the example stack declares `command: demo`
    expect(existsSync(path.join(binDir, 'demo'))).toBe(true);
  });

  test('--as overrides the declared name', () => {
    const result = linkStack('example', { as: 'myset', dir: binDir, env: home.env });
    expect(result.name).toBe('myset');
    expect(readFileSync(path.join(binDir, 'myset'), 'utf8')).toContain('up example');
  });

  test('falls back to the stack name when no `command:` is declared', () => {
    home.writeStack('plain', 'name: plain\nservices:\n  - { name: a, cmd: "node -e 0" }\n');
    expect(linkStack('plain', { dir: binDir, env: home.env }).name).toBe('plain');
  });

  test('re-linking updates in place rather than erroring', () => {
    linkStack('dual', { dir: binDir, env: home.env });
    const second = linkStack('dual', { dir: binDir, env: home.env });
    expect(second.replaced).toBe(true);
  });

  test('refuses to clobber a file it did not write', () => {
    writeFileSync(path.join(binDir, 'taken'), 'someone else lives here', 'utf8');
    expect(() => linkStack('dual', { as: 'taken', dir: binDir, env: home.env })).toThrow(/not created by laracrew/);
  });

  test('--force overwrites a foreign file', () => {
    writeFileSync(path.join(binDir, 'taken'), 'someone else lives here', 'utf8');
    const result = linkStack('dual', { as: 'taken', dir: binDir, force: true, env: home.env });
    expect(result.replaced).toBe(true);
    expect(readFileSync(path.join(binDir, 'taken'), 'utf8')).toContain(MARKER);
  });

  test('refuses to shadow an important command', () => {
    expect(() => linkStack('dual', { as: 'npm', dir: binDir, env: home.env })).toThrow(/shadow an important command/);
  });

  test('rejects a name that is not usable as a command', () => {
    expect(() => linkStack('dual', { as: 'my set!', dir: binDir, env: home.env })).toThrow(/not a usable command name/);
  });

  test('validates the stack before writing anything', () => {
    home.writeStack('broken', 'name: broken\nservices:\n  - { name: a, nope: 1 }\n');
    expect(() => linkStack('broken', { dir: binDir, env: home.env })).toThrow();
    expect(existsSync(path.join(binDir, 'broken'))).toBe(false);
  });
});

describe('listLinks and unlink', () => {
  test('reports each installed command and the stack it boots', () => {
    linkStack('dual', { dir: binDir, env: home.env });
    linkStack('example', { dir: binDir, env: home.env });

    const links = listLinks({ dir: binDir, env: home.env });
    expect(links.map((link) => [link.name, link.stack])).toEqual([
      ['demo', 'example'],
      ['dual', 'dual'],
    ]);
  });

  test('ignores files laracrew did not generate', () => {
    writeFileSync(path.join(binDir, 'stranger'), '#!/bin/sh\necho hi\n', 'utf8');
    expect(listLinks({ dir: binDir, env: home.env })).toEqual([]);
  });

  test('unlink removes every shim for the name', () => {
    linkStack('dual', { dir: binDir, env: home.env });
    const removed = unlinkCommandName('dual', { dir: binDir, env: home.env });

    expect(removed.length).toBe(process.platform === 'win32' ? 3 : 1);
    expect(existsSync(path.join(binDir, 'dual'))).toBe(false);
    expect(listLinks({ dir: binDir, env: home.env })).toEqual([]);
  });

  test('unlink refuses a file it did not create', () => {
    writeFileSync(path.join(binDir, 'stranger'), 'not ours', 'utf8');
    expect(() => unlinkCommandName('stranger', { dir: binDir, env: home.env })).toThrow(/not created by laracrew/);
    expect(existsSync(path.join(binDir, 'stranger'))).toBe(true);
  });

  test('unlink says so when there is nothing to remove', () => {
    expect(() => unlinkCommandName('ghost', { dir: binDir, env: home.env })).toThrow(/no laracrew command named/);
  });
});

describe('entryScript', () => {
  test('uses the script node was actually given', () => {
    expect(entryScript(['node', 'C:/app/dist/index.js'])).toBe(path.resolve('C:/app/dist/index.js'));
  });

  test('redirects a TypeScript entry to the built bundle', () => {
    // A shim runs plain node, which cannot execute .ts — so a dev run must point at dist/.
    const projectRoot = path.join(home.root, 'proj');
    mkdirSync(path.join(projectRoot, 'dist'), { recursive: true });
    mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'dist', 'index.js'), '// built', 'utf8');

    const entry = entryScript(['node', path.join(projectRoot, 'src', 'index.ts')]);
    expect(entry).toBe(path.join(projectRoot, 'dist', 'index.js'));
  });

  test('tells you to build when there is no bundle to point at', () => {
    const projectRoot = path.join(home.root, 'unbuilt');
    mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    expect(() => entryScript(['node', path.join(projectRoot, 'src', 'index.ts')])).toThrow(/npm run build/);
  });
});

describe('resolveBinDir', () => {
  test('LARACREW_BIN wins and is treated as already on PATH', () => {
    const custom = { ...home.env, LARACREW_BIN: binDir };
    expect(resolveBinDir(custom)).toEqual({ dir: path.resolve(binDir), onPath: true });
  });

  test('picks the PATH directory that holds laracrew itself', () => {
    const shim = path.join(binDir, process.platform === 'win32' ? 'laracrew.cmd' : 'laracrew');
    writeFileSync(shim, 'pretend shim', 'utf8');

    const env: NodeJS.ProcessEnv = { ...home.env, PATH: binDir, Path: binDir };
    delete env.LARACREW_BIN;

    expect(resolveBinDir(env)).toEqual({ dir: binDir, onPath: true });
  });

  test('falls back to ~/.laracrew/bin and flags that it is not on PATH', () => {
    const nowhere = path.join(home.root, 'nowhere');
    const env: NodeJS.ProcessEnv = { ...home.env, PATH: nowhere, Path: nowhere };
    delete env.LARACREW_BIN;
    delete env.APPDATA;

    const resolved = resolveBinDir(env);
    expect(resolved.dir).toBe(path.join(home.root, 'bin'));
    expect(resolved.onPath).toBe(false);
  });
});
