import net from 'node:net';
import type { ReadyProbe } from '../config/schema.js';

export interface ProbeResult {
  ok: boolean;
  detail?: string;
}

export const tcpProbe = (target: string, timeoutMs = 2_000): Promise<ProbeResult> =>
  new Promise((resolve) => {
    const lastColon = target.lastIndexOf(':');
    const host = lastColon === -1 ? '127.0.0.1' : target.slice(0, lastColon) || '127.0.0.1';
    const port = Number(lastColon === -1 ? target : target.slice(lastColon + 1));

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      resolve({ ok: false, detail: `"${target}" is not host:port` });
      return;
    }

    const socket = net.connect({ host, port });
    const finish = (result: ProbeResult) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, detail: 'connect timed out' }));
    socket.once('error', (error) => finish({ ok: false, detail: (error as NodeJS.ErrnoException).code ?? error.message }));
  });

export const httpProbe = async (url: string, timeoutMs = 2_000): Promise<ProbeResult> => {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
      headers: { 'user-agent': 'laracrew' },
    });
    // Any answer means the server is up; a 404 on /up still proves it is listening.
    if (response.status >= 500) return { ok: false, detail: `HTTP ${response.status}` };
    return { ok: true, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
};

/** True when the port is free to bind — used by `doctor` to report clashes before booting. */
export const isPortFree = (port: number, host = '127.0.0.1'): Promise<boolean> =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });

export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
  signal?: AbortSignal;
}

/** Polls `probe` until it passes, the timeout expires, or the caller aborts. */
export const waitFor = async (
  probe: () => Promise<ProbeResult>,
  options: WaitOptions,
): Promise<ProbeResult> => {
  const deadline = Date.now() + options.timeoutMs;
  let last: ProbeResult = { ok: false, detail: 'not attempted' };

  while (Date.now() < deadline) {
    if (options.signal?.aborted) return { ok: false, detail: 'aborted' };
    last = await probe();
    if (last.ok) return last;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(options.intervalMs, remaining), options.signal);
  }

  return { ok: false, detail: last.detail ?? 'timed out' };
};

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** A human-readable label for what we are waiting on, shown in the boot screen. */
export const describeProbe = (probe: ReadyProbe): string => {
  if (probe.http) return `http ${probe.http}`;
  if (probe.tcp) return `tcp ${probe.tcp}`;
  if (probe.logMatch) return `log /${probe.logMatch}/`;
  if (probe.delayMs !== undefined) return `wait ${probe.delayMs}ms`;
  return 'spawn';
};
