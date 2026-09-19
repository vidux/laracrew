import { EventBus } from '../../core/events/bus.js';
import { loadSharedProjects, loadStack } from '../../core/config/load.js';
import { resolveStack, type ResolvedStack } from '../../core/config/resolve.js';
import { Supervisor } from '../../core/process/supervisor.js';
import { attachPlainRenderer } from '../render/plain.js';
import { paint } from '../render/colors.js';
import { onOutputClosed, write as safeWrite } from '../render/output.js';
import { runTui } from '../../tui/app.js';

export interface UpOptions {
  only?: string[];
  except?: string[];
  profile?: string;
  plain?: boolean;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
}

const splitList = (values: string[] | undefined): string[] =>
  (values ?? []).flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);

export const prepareStack = (name: string, options: UpOptions = {}): ResolvedStack => {
  const env = options.env ?? process.env;
  const loaded = loadStack(name, env);
  return resolveStack(loaded, {
    sharedProjects: loadSharedProjects(env),
    env,
    ...(options.profile ? { profile: options.profile } : {}),
    only: splitList(options.only),
    except: splitList(options.except),
  });
};

const attachJsonRenderer = (bus: EventBus): (() => void) =>
  bus.subscribe((event) => process.stdout.write(`${JSON.stringify(event)}\n`));

/**
 * Boots a stack and keeps running until the fleet stops or the user interrupts.
 * The TUI lands in M2; until then every run uses the plain renderer.
 */
/** The TUI is the default, but only when there is a real terminal to draw on. */
export const shouldUseTui = (options: UpOptions, stdout: { isTTY?: boolean } = process.stdout): boolean =>
  !options.plain && !options.json && Boolean(stdout.isTTY);

export const upCommand = async (name: string, options: UpOptions = {}): Promise<number> => {
  const stack = prepareStack(name, options);
  const bus = new EventBus();

  if (shouldUseTui(options)) {
    const supervisor = new Supervisor(stack, bus, options.env ? { env: options.env } : {});
    return runTui(supervisor, bus, options.env ? { env: options.env } : {});
  }

  const detach = options.json ? attachJsonRenderer(bus) : attachPlainRenderer(bus, { stack });

  const supervisor = new Supervisor(stack, bus, options.env ? { env: options.env } : {});

  let exitCode = 0;
  let stopping = false;

  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await supervisor.down(reason);
  };

  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) {
      // Second interrupt: the user is done being patient.
      console.error(paint('red', '\nforced exit — some children may survive'));
      process.exit(130);
    }
    void shutdown(`received ${signal}`);
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // `laracrew up --json | head` closes the pipe; that is a request to stop, not a crash.
  const releaseOutputHook = onOutputClosed(() => {
    void shutdown('output closed');
  });

  try {
    await supervisor.up();
    await waitUntilIdle(supervisor, () => stopping);
  } catch (error) {
    console.error(paint('red', error instanceof Error ? error.message : String(error)));
    exitCode = 1;
  } finally {
    await shutdown('done');
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    releaseOutputHook();
    detach();
  }

  return exitCode;
};

/** Resolves when every service has reached a terminal state, or a stop was requested. */
const waitUntilIdle = (supervisor: Supervisor, stopRequested: () => boolean): Promise<void> =>
  new Promise((resolve) => {
    const check = () => {
      if (stopRequested()) {
        clearInterval(timer);
        resolve();
        return;
      }
      const anyLive = supervisor.processes.some(
        (process) => process.state !== 'stopped' && process.state !== 'failed',
      );
      if (!anyLive) {
        clearInterval(timer);
        resolve();
      }
    };
    const timer = setInterval(check, 250);
    timer.unref?.();
  });
