import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Command, ResolvedService } from '../config/resolve.js';

const IS_WINDOWS = process.platform === 'win32';

/**
 * On Windows, `npm`/`npx`/`yarn`/`pnpm` are .cmd shims. Recent Node refuses to spawn them
 * without a shell, so these have to go through cmd.exe even in argv form.
 */
const SHIM_NAMES = new Set(['npm', 'npx', 'yarn', 'pnpm', 'bun', 'composer']);

const needsShell = (file: string): boolean => {
  if (!IS_WINDOWS) return false;
  const base = file.replace(/\\/g, '/').split('/').pop() ?? file;
  if (/\.(cmd|bat)$/i.test(base)) return true;
  return SHIM_NAMES.has(base.replace(/\.[^.]+$/, '').toLowerCase());
};

/** A quoted, human-readable rendering of the command — used in logs and the TUI header. */
export const describeCommand = (command: Command): string =>
  command.kind === 'shell'
    ? command.line
    : [command.file, ...command.args].map((part) => (part.includes(' ') ? `"${part}"` : part)).join(' ');

export const buildEnv = (service: ResolvedService, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({
  ...base,
  ...service.env,
  LARACREW: '1',
  LARACREW_SERVICE: service.name,
  ...(service.project ? { LARACREW_PROJECT: service.project.key } : {}),
});

export interface SpawnedChild {
  child: ChildProcess;
  description: string;
}

export const spawnService = (service: ResolvedService, base: NodeJS.ProcessEnv = process.env): SpawnedChild => {
  const command = service.command;
  if (!command) throw new Error(`service "${service.name}" has no command to run`);

  const options: SpawnOptions = {
    cwd: service.cwd,
    env: buildEnv(service, base),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // POSIX: a new process group means one kill(-pid) takes the whole tree down.
    // Windows has no equivalent, so stop.ts uses `taskkill /T` there instead.
    detached: !IS_WINDOWS,
  };

  const child =
    command.kind === 'shell'
      ? spawn(command.line, { ...options, shell: true })
      : spawn(command.file, command.args, { ...options, shell: needsShell(command.file) });

  return { child, description: describeCommand(command) };
};

/** Runs a short-lived command to completion; used for artisan hooks and task steps. */
export const runOnce = (
  command: Command,
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    };

    const child =
      command.kind === 'shell'
        ? spawn(command.line, { ...spawnOptions, shell: true })
        : spawn(command.file, command.args, { ...spawnOptions, shell: needsShell(command.file) });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
        }, options.timeoutMs)
      : undefined;
    timer?.unref?.();

    child.once('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
