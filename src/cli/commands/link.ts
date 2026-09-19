import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../../core/config/errors.js';
import { listStacks, loadStack } from '../../core/config/load.js';
import { paths } from '../../core/config/paths.js';
import { paint } from '../render/colors.js';

const IS_WINDOWS = process.platform === 'win32';

/** Stamped into every generated file so we never overwrite something we did not write. */
export const MARKER = 'laracrew-generated';

const RESERVED = new Set(['laracrew', 'node', 'npm', 'npx', 'php', 'git', 'cd', 'ls', 'rm', 'sh', 'bash']);
const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface ShimTarget {
  /** Absolute path to the node binary that should run laracrew. */
  node: string;
  /** Absolute path to laracrew's entry script. */
  entry: string;
  stack: string;
}

/**
 * The script the shim must hand to node. This is `process.argv[1]` — the entry Node was
 * actually given — not a path derived from this module's own location: tsup bundles the
 * whole program into one file, so any relative walk from here is wrong in a build.
 */
export const entryScript = (argv: string[] = process.argv): string => {
  const main = argv[1];
  if (!main) return fileURLToPath(import.meta.url);

  const resolved = path.resolve(main);
  if (!resolved.endsWith('.ts')) return resolved;

  // Running from TypeScript source (`npm run dev`): a shim cannot invoke .ts with plain
  // node, so point it at the built bundle instead.
  const dist = path.join(path.dirname(path.dirname(resolved)), 'dist', 'index.js');
  if (existsSync(dist)) return dist;

  throw new ConfigError('run `npm run build` first — a generated command has to point at dist/index.js');
};

/** Where laracrew is running from — embedded in the shim so PATH changes can't break it. */
export const currentTarget = (stack: string): ShimTarget => ({
  node: process.execPath,
  entry: entryScript(),
  stack,
});

const forward = (value: string): string => value.replace(/\\/g, '/');

export const shShim = ({ node, entry, stack }: ShimTarget): string =>
  `#!/bin/sh
# ${MARKER}: boots the "${stack}" stack. Regenerate with \`laracrew link ${stack}\`.
exec "${forward(node)}" "${forward(entry)}" up ${stack} "$@"
`;

export const cmdShim = ({ node, entry, stack }: ShimTarget): string =>
  `@ECHO OFF\r
REM ${MARKER}: boots the "${stack}" stack. Regenerate with \`laracrew link ${stack}\`.\r
"${node}" "${entry}" up ${stack} %*\r
`;

export const ps1Shim = ({ node, entry, stack }: ShimTarget): string =>
  `#!/usr/bin/env pwsh
# ${MARKER}: boots the "${stack}" stack. Regenerate with \`laracrew link ${stack}\`.
& "${node}" "${entry}" up ${stack} @args
exit $LASTEXITCODE
`;

/** The files one command needs: three on Windows (sh, cmd, PowerShell), one elsewhere. */
export const shimFiles = (name: string, target: ShimTarget): { file: string; contents: string; exec: boolean }[] => {
  const posix = { file: name, contents: shShim(target), exec: true };
  if (!IS_WINDOWS) return [posix];
  return [
    posix, // Git Bash reads the extensionless file
    { file: `${name}.cmd`, contents: cmdShim(target), exec: false },
    { file: `${name}.ps1`, contents: ps1Shim(target), exec: true },
  ];
};

const pathDirs = (env: NodeJS.ProcessEnv): string[] =>
  (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);

const samePath = (a: string, b: string): boolean =>
  IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;

/** The directory on PATH that holds the `laracrew` command itself. */
const ownBinDir = (env: NodeJS.ProcessEnv): string | undefined => {
  for (const dir of pathDirs(env)) {
    for (const candidate of IS_WINDOWS ? ['laracrew.cmd', 'laracrew'] : ['laracrew']) {
      try {
        if (existsSync(path.join(dir, candidate))) return dir;
      } catch {
        // An unreadable PATH entry is not our problem.
      }
    }
  }
  return undefined;
};

/**
 * Wherever `laracrew` itself lives is by definition on PATH and writable by whoever
 * installed it, so sibling commands belong there. Asking npm for its prefix would mean
 * spawning npm on every call — slower, and it trips Node's shell-argument deprecation.
 */
export const resolveBinDir = (env: NodeJS.ProcessEnv = process.env): { dir: string; onPath: boolean } => {
  if (env.LARACREW_BIN) return { dir: path.resolve(env.LARACREW_BIN), onPath: true };

  const own = ownBinDir(env);
  if (own) return { dir: own, onPath: true };

  // Not installed globally (running from source): try npm's default prefix.
  const conventional = IS_WINDOWS
    ? env.APPDATA
      ? path.join(env.APPDATA, 'npm')
      : undefined
    : path.dirname(process.execPath);

  if (conventional && existsSync(conventional) && pathDirs(env).some((dir) => samePath(dir, conventional))) {
    return { dir: conventional, onPath: true };
  }

  return { dir: path.join(paths(env).root, 'bin'), onPath: false };
};

const isOurs = (file: string): boolean => {
  try {
    return readFileSync(file, 'utf8').includes(MARKER);
  } catch {
    return false;
  }
};

export interface LinkResult {
  name: string;
  stack: string;
  dir: string;
  onPath: boolean;
  files: string[];
  replaced: boolean;
}

export const linkStack = (
  stackName: string,
  options: { as?: string; dir?: string; force?: boolean; env?: NodeJS.ProcessEnv } = {},
): LinkResult => {
  const env = options.env ?? process.env;
  const { config } = loadStack(stackName, env); // validates before we create anything

  const name = options.as ?? config.command ?? stackName;

  if (!VALID_NAME.test(name)) {
    throw new ConfigError(
      `"${name}" is not a usable command name — letters, digits, dot, dash and underscore only`,
    );
  }
  if (RESERVED.has(name.toLowerCase()) && !options.force) {
    throw new ConfigError(`"${name}" would shadow an important command`, {
      details: ['pick another with `--as <name>`, or pass --force if you really mean it'],
    });
  }

  const resolved = options.dir ? { dir: path.resolve(options.dir), onPath: true } : resolveBinDir(env);
  mkdirSync(resolved.dir, { recursive: true });

  const target = currentTarget(stackName);
  const planned = shimFiles(name, target);

  let replaced = false;
  for (const { file } of planned) {
    const full = path.join(resolved.dir, file);
    if (!existsSync(full)) continue;
    if (isOurs(full)) {
      replaced = true;
      continue;
    }
    if (!options.force) {
      throw new ConfigError(`"${full}" already exists and was not created by laracrew`, {
        details: ['choose another name with `--as <name>`, or pass --force to overwrite'],
      });
    }
    replaced = true;
  }

  const written: string[] = [];
  for (const { file, contents, exec } of planned) {
    const full = path.join(resolved.dir, file);
    writeFileSync(full, contents, 'utf8');
    if (exec && !IS_WINDOWS) chmodSync(full, 0o755);
    else if (exec) {
      try {
        chmodSync(full, 0o755);
      } catch {
        // Windows ignores the mode; Git Bash still honours the shebang.
      }
    }
    written.push(full);
  }

  return { name, stack: stackName, dir: resolved.dir, onPath: resolved.onPath, files: written, replaced };
};

export const unlinkCommandName = (
  name: string,
  options: { dir?: string; env?: NodeJS.ProcessEnv } = {},
): string[] => {
  const env = options.env ?? process.env;
  const dir = options.dir ? path.resolve(options.dir) : resolveBinDir(env).dir;

  const removed: string[] = [];
  for (const candidate of [name, `${name}.cmd`, `${name}.ps1`]) {
    const full = path.join(dir, candidate);
    if (!existsSync(full)) continue;
    if (!isOurs(full)) {
      throw new ConfigError(`"${full}" was not created by laracrew — leaving it alone`);
    }
    unlinkSync(full);
    removed.push(full);
  }

  if (removed.length === 0) throw new ConfigError(`no laracrew command named "${name}" in ${dir}`);
  return removed;
};

export interface InstalledLink {
  name: string;
  stack: string;
  file: string;
}

/** Every command in the bin directory that laracrew generated. */
export const listLinks = (options: { dir?: string; env?: NodeJS.ProcessEnv } = {}): InstalledLink[] => {
  const env = options.env ?? process.env;
  const dir = options.dir ? path.resolve(options.dir) : resolveBinDir(env).dir;
  if (!existsSync(dir)) return [];

  const found: InstalledLink[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry.endsWith('.cmd') || entry.endsWith('.ps1')) continue;
    const full = path.join(dir, entry);
    let contents: string;
    try {
      contents = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (!contents.includes(MARKER)) continue;
    const stack = /\bup ([^\s"]+)/.exec(contents)?.[1];
    if (stack) found.push({ name: entry, stack, file: full });
  }
  return found;
};

export const linkCommand = (
  stackName: string | undefined,
  options: { as?: string; dir?: string; force?: boolean; all?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): number => {
  const stacks = options.all ? listStacks(env) : stackName ? [stackName] : [];
  if (stacks.length === 0) {
    throw new ConfigError('name a stack to link, or pass --all');
  }

  const results: LinkResult[] = [];
  for (const stack of stacks) {
    // With --all, a stack that opts out by having no `command:` is skipped rather than
    // silently claiming a global name derived from its folder.
    if (options.all) {
      const { config } = loadStack(stack, env);
      if (!config.command) continue;
    }
    results.push(
      linkStack(stack, {
        ...(options.as ? { as: options.as } : {}),
        ...(options.dir ? { dir: options.dir } : {}),
        ...(options.force ? { force: options.force } : {}),
        env,
      }),
    );
  }

  if (results.length === 0) {
    console.log(paint('yellow', 'nothing to link — add `command: <name>` to the stacks you want a command for'));
    return 0;
  }

  for (const result of results) {
    const verb = result.replaced ? 'updated' : 'created';
    console.log(
      `${paint('green', verb)} ${paint('bold', result.name)} ${paint('gray', `-> laracrew up ${result.stack}`)}`,
    );
  }

  const first = results[0]!;
  console.log(paint('gray', `\nin ${first.dir}`));

  if (!first.onPath) {
    console.log(
      `\n${paint('yellow', 'that directory is not on your PATH.')} Add it once:\n` +
        (IS_WINDOWS
          ? `  ${paint('cyan', `setx PATH "%PATH%;${first.dir}"`)}   ${paint('gray', '(then reopen the terminal)')}`
          : `  ${paint('cyan', `echo 'export PATH="$PATH:${first.dir}"' >> ~/.bashrc`)}`),
    );
  } else {
    console.log(`\nRun it from anywhere:  ${paint('cyan', first.name)}`);
    console.log(paint('gray', `Flags pass straight through:  ${first.name} --only workers`));
  }

  return 0;
};

export const unlinkCommandAction = (name: string, env: NodeJS.ProcessEnv = process.env): number => {
  const removed = unlinkCommandName(name, { env });
  for (const file of removed) console.log(`${paint('red', 'removed')} ${file}`);
  return 0;
};
