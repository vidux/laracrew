import type { ChildProcess } from 'node:child_process';
import type { ResolvedService } from '../config/resolve.js';
import type { EventBus } from '../events/bus.js';
import type { LogLine, ServiceState } from '../events/types.js';
import { RingBuffer } from '../logs/ring-buffer.js';
import { LineSplitter } from '../logs/sanitize.js';
import { describeProbe, httpProbe, sleep, tcpProbe, waitFor, type ProbeResult } from '../health/probes.js';
import { describeCommand, runOnce, spawnService } from './spawn.js';
import { stopLadder } from './stop.js';

export interface ManagedProcessOptions {
  logCapacity?: number;
  env?: NodeJS.ProcessEnv;
}

/** One supervised child: its state machine, its logs, and its restart policy. */
export class ManagedProcess {
  readonly service: ResolvedService;
  readonly logs: RingBuffer<LogLine>;

  #bus: EventBus;
  #env: NodeJS.ProcessEnv;
  #child?: ChildProcess;
  #state: ServiceState = 'queued';
  #intentionalStop = false;
  #restarts = 0;
  #attempt = 0;
  #startedAt?: number;
  #readyAt?: number;
  #backoffTimer?: NodeJS.Timeout;
  #logWatchers = new Set<(line: string) => void>();
  #disposed = false;

  constructor(service: ResolvedService, bus: EventBus, options: ManagedProcessOptions = {}) {
    this.service = service;
    this.#bus = bus;
    this.#env = options.env ?? process.env;
    this.logs = new RingBuffer<LogLine>(options.logCapacity ?? 5_000);
  }

  get state(): ServiceState {
    return this.#state;
  }
  get pid(): number | undefined {
    return this.#child?.pid;
  }
  get restarts(): number {
    return this.#restarts;
  }
  get startedAt(): number | undefined {
    return this.#startedAt;
  }
  get uptimeMs(): number | undefined {
    return this.#startedAt === undefined ? undefined : Date.now() - this.#startedAt;
  }
  get readyDurationMs(): number | undefined {
    return this.#readyAt !== undefined && this.#startedAt !== undefined ? this.#readyAt - this.#startedAt : undefined;
  }

  #setState(to: ServiceState, detail?: string): void {
    if (this.#state === to) return;
    const from = this.#state;
    this.#state = to;
    this.#bus.emit({
      type: 'service:state',
      service: this.service.name,
      from,
      to,
      ...(detail ? { detail } : {}),
      at: Date.now(),
    });
  }

  #log(line: string, stream: LogLine['stream'] = 'system'): void {
    const entry: LogLine = { service: this.service.name, stream, line, at: Date.now() };
    this.logs.push(entry);
    this.#bus.emit({ type: 'service:log', log: entry });
    for (const watcher of this.#logWatchers) watcher(line);
  }

  /**
   * Spawns (unless external) and resolves once the readiness probe passes.
   * Rejects when the gate fails, which is what aborts a boot.
   */
  async start(): Promise<void> {
    if (this.#disposed) throw new Error(`service "${this.service.name}" has been disposed`);
    this.#intentionalStop = false;
    this.#setState('starting');
    this.#startedAt = Date.now();
    this.#readyAt = undefined;

    if (this.service.external) {
      await this.#awaitReady();
      return;
    }

    const { child, description } = spawnService(this.service, this.#env);
    this.#child = child;

    child.once('error', (error) => {
      this.#log(`failed to spawn: ${error.message}`, 'stderr');
      this.#setState('failed', error.message);
    });

    this.#pipe(child, 'stdout');
    this.#pipe(child, 'stderr');
    child.once('close', (code, signal) => this.#onExit(code, signal));

    if (child.pid !== undefined) {
      this.#bus.emit({
        type: 'service:spawned',
        service: this.service.name,
        pid: child.pid,
        command: description,
        cwd: this.service.cwd,
        at: Date.now(),
      });
    }

    await this.#awaitReady();
  }

  #pipe(child: ChildProcess, stream: 'stdout' | 'stderr'): void {
    const source = child[stream];
    if (!source) return;
    const splitter = new LineSplitter();
    source.setEncoding('utf8');
    source.on('data', (chunk: string) => {
      for (const line of splitter.push(chunk)) this.#log(line, stream);
    });
    source.once('end', () => {
      for (const line of splitter.flush()) this.#log(line, stream);
    });
  }

  async #awaitReady(): Promise<void> {
    const probe = this.service.ready;

    if (!probe) {
      this.#readyAt = Date.now();
      this.#setState('running');
      return;
    }

    const label = describeProbe(probe);
    const result = await this.#runProbe(probe);

    if (!result.ok) {
      this.#setState('failed', `readiness gate failed: ${label}${result.detail ? ` (${result.detail})` : ''}`);
      throw new Error(
        `service "${this.service.name}" never became ready: ${label}${result.detail ? ` — ${result.detail}` : ''}`,
      );
    }

    this.#readyAt = Date.now();
    this.#bus.emit({
      type: 'service:ready',
      service: this.service.name,
      durationMs: this.readyDurationMs ?? 0,
      probe: label,
      at: Date.now(),
    });
    this.#setState(this.service.external ? 'ready' : 'running');
  }

  async #runProbe(probe: NonNullable<ResolvedService['ready']>): Promise<ProbeResult> {
    if (probe.delayMs !== undefined && !probe.tcp && !probe.http && !probe.logMatch) {
      await sleep(probe.delayMs);
      return { ok: true };
    }
    if (probe.logMatch) return this.#waitForLogMatch(probe.logMatch, probe.timeoutMs);
    if (probe.http) {
      const url = probe.http;
      return waitFor(() => httpProbe(url, probe.intervalMs * 4), {
        timeoutMs: probe.timeoutMs,
        intervalMs: probe.intervalMs,
      });
    }
    const target = probe.tcp!;
    return waitFor(() => tcpProbe(target, probe.intervalMs * 4), {
      timeoutMs: probe.timeoutMs,
      intervalMs: probe.intervalMs,
    });
  }

  /** Readiness by output, for tools that announce themselves (Vite, Reverb). */
  #waitForLogMatch(source: string, timeoutMs: number): Promise<ProbeResult> {
    let pattern: RegExp;
    try {
      pattern = new RegExp(source);
    } catch (error) {
      return Promise.resolve({ ok: false, detail: `invalid logMatch regex: ${String(error)}` });
    }

    // Lines that already arrived count — the child may be faster than this gate.
    for (const entry of this.logs.toArray()) {
      if (pattern.test(entry.line)) return Promise.resolve({ ok: true, detail: 'matched buffered output' });
    }

    return new Promise((resolve) => {
      const done = (result: ProbeResult) => {
        clearTimeout(timer);
        this.#logWatchers.delete(watcher);
        resolve(result);
      };
      const watcher = (line: string) => {
        if (pattern.test(line)) done({ ok: true });
      };
      const timer = setTimeout(() => done({ ok: false, detail: 'no matching output' }), timeoutMs);
      timer.unref?.();
      this.#logWatchers.add(watcher);
    });
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasIntentional = this.#intentionalStop;
    const uptime = this.uptimeMs ?? 0;
    this.#child = undefined;

    this.#bus.emit({
      type: 'service:exit',
      service: this.service.name,
      code,
      signal,
      intentional: wasIntentional,
      at: Date.now(),
    });

    if (wasIntentional || this.#disposed) {
      this.#setState('stopped');
      return;
    }

    // A long, healthy run means the earlier failures are ancient history.
    if (uptime >= this.service.backoff.resetAfterMs) this.#attempt = 0;

    const clean = code === 0 && signal === null;
    const policy = this.service.restart;
    const shouldRestart = policy === 'always' || (policy === 'on-failure' && !clean);

    this.#setState('crashed', signal ? `killed by ${signal}` : `exit code ${code}`);

    if (!shouldRestart) {
      this.#setState(clean ? 'stopped' : 'failed', clean ? undefined : `exited with code ${code}`);
      return;
    }

    if (this.#attempt >= this.service.backoff.maxRestarts) {
      this.#setState('failed', `gave up after ${this.#attempt} restarts`);
      return;
    }

    this.#attempt += 1;
    this.#restarts += 1;
    const { initialMs, factor, maxMs } = this.service.backoff;
    const delayMs = Math.min(Math.round(initialMs * factor ** (this.#attempt - 1)), maxMs);

    this.#setState('backoff', `restarting in ${delayMs}ms`);
    this.#bus.emit({
      type: 'service:restart',
      service: this.service.name,
      attempt: this.#attempt,
      maxAttempts: this.service.backoff.maxRestarts,
      delayMs,
      at: Date.now(),
    });

    this.#backoffTimer = setTimeout(() => {
      this.#backoffTimer = undefined;
      if (this.#disposed || this.#intentionalStop) return;
      void this.start().catch((error: unknown) => {
        this.#log(`restart failed: ${error instanceof Error ? error.message : String(error)}`, 'stderr');
      });
    }, delayMs);
    this.#backoffTimer.unref?.();
  }

  /**
   * Step 1 of the stop ladder: ask the process to finish what it is holding and exit by
   * itself. What that command is — `queue:restart`, `celery control shutdown`, a drain
   * script — was decided in `resolve.ts`; this only runs it.
   */
  #graceful(): (() => Promise<void>) | undefined {
    const graceful = this.service.graceful;
    if (!graceful) return undefined;

    return async () => {
      this.#log(`stop: ${describeCommand(graceful.command)}`);
      await runOnce(graceful.command, { cwd: graceful.cwd, env: this.#env, timeoutMs: 15_000 });
    };
  }

  async stop(): Promise<void> {
    this.#intentionalStop = true;

    if (this.#backoffTimer) {
      clearTimeout(this.#backoffTimer);
      this.#backoffTimer = undefined;
    }

    if (this.service.external) {
      this.#setState('stopped');
      return;
    }

    const child = this.#child;
    if (!child) {
      this.#setState('stopped');
      return;
    }

    this.#setState('stopping');

    const graceful = this.#graceful();
    const outcome = await stopLadder({
      child,
      ...(graceful ? { graceful } : {}),
      signal: this.service.stop.signal as NodeJS.Signals,
      graceMs: this.service.stop.graceMs,
      onStep: (step) => this.#log(`stop: ${step}`),
    });

    if (outcome === 'survived') {
      this.#bus.emit({
        type: 'notice',
        level: 'error',
        service: this.service.name,
        message: `process ${child.pid} survived the stop ladder — kill it manually`,
        at: Date.now(),
      });
    }

    this.#setState('stopped');
  }

  async restart(): Promise<void> {
    await this.stop();
    this.#attempt = 0;
    this.#restarts += 1;
    await this.start();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.stop();
    this.#logWatchers.clear();
  }
}
