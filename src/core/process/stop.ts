import { spawn, type ChildProcess } from 'node:child_process';

const IS_WINDOWS = process.platform === 'win32';

export const isAlive = (pid: number): boolean => {
  try {
    // Signal 0 performs the permission/existence check without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * `php artisan serve` spawns a child PHP server and `npm run dev` spawns Vite. Killing only
 * the parent orphans those and leaves the port bound — the single most common way a dev
 * process manager ruins your afternoon. So every kill is a tree kill.
 */
export const killTree = async (pid: number, signal: NodeJS.Signals = 'SIGKILL'): Promise<void> => {
  if (IS_WINDOWS) {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => resolve());
      killer.once('close', () => resolve());
    });
    return;
  }

  try {
    // Negative pid = the whole process group created by `detached: true`.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
};

export const waitForExit = (child: ChildProcess, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      child.removeListener('close', onClose);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();

    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('close', onClose);
  });

export interface StopLadderOptions {
  child: ChildProcess;
  /** Step 1: Laravel-native graceful shutdown, e.g. `php artisan queue:restart`. */
  graceful?: () => Promise<void>;
  signal: NodeJS.Signals;
  graceMs: number;
  onStep?: (step: string) => void;
}

export type StopOutcome = 'graceful' | 'signal' | 'tree-kill' | 'already-gone' | 'survived';

/**
 * Ordered stop, each step only attempted if the previous one timed out:
 *   1. Laravel graceful  (worker finishes its current job, then exits by itself)
 *   2. Signal            (POSIX only — Windows has no real SIGTERM)
 *   3. Tree kill         (taskkill /T /F, or kill the process group)
 */
export const stopLadder = async (options: StopLadderOptions): Promise<StopOutcome> => {
  const { child, graceful, signal, graceMs, onStep } = options;
  const pid = child.pid;

  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return 'already-gone';

  if (graceful) {
    onStep?.('graceful');
    try {
      await graceful();
      if (await waitForExit(child, graceMs)) return 'graceful';
    } catch {
      // A failed graceful hook is not fatal; fall through to the harder steps.
    }
  }

  if (!IS_WINDOWS) {
    onStep?.('signal');
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        return 'already-gone';
      }
    }
    if (await waitForExit(child, Math.min(graceMs, 5_000))) return 'signal';
  }

  onStep?.('tree-kill');
  await killTree(pid);
  if (await waitForExit(child, 5_000)) return 'tree-kill';

  return isAlive(pid) ? 'survived' : 'tree-kill';
};
