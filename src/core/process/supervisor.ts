import path from 'node:path';
import type { ResolvedStack } from '../config/resolve.js';
import type { EventBus } from '../events/bus.js';
import { isLive, type ServiceState } from '../events/types.js';
import { LogWriter } from '../logs/file-sink.js';
import { paths } from '../config/paths.js';
import { ManagedProcess } from './managed-process.js';

export interface SupervisorOptions {
  env?: NodeJS.ProcessEnv;
  /** Override where log files land. Defaults to ~/.laracrew/logs/<stack>. */
  logDir?: string;
}

export interface ServiceSnapshot {
  name: string;
  state: ServiceState;
  pid?: number;
  uptimeMs?: number;
  restarts: number;
  autostart: boolean;
  groups: string[];
  project?: string;
  url?: string;
  command?: string;
  external: boolean;
  color: string;
}

/**
 * Owns the whole fleet: starts it in dependency order, stops it in reverse, and never
 * leaves a half-started stack behind when a readiness gate fails.
 */
export class Supervisor {
  readonly stack: ResolvedStack;

  #bus: EventBus;
  #processes = new Map<string, ManagedProcess>();
  #startedOrder: string[] = [];
  #shuttingDown = false;
  #logWriter?: LogWriter;

  constructor(stack: ResolvedStack, bus: EventBus, options: SupervisorOptions = {}) {
    this.stack = stack;
    this.#bus = bus;

    for (const service of stack.services) {
      this.#processes.set(
        service.name,
        new ManagedProcess(service, bus, {
          logCapacity: stack.logs.maxLines,
          ...(options.env ? { env: options.env } : {}),
        }),
      );
    }

    if (stack.logs.toFile) {
      this.#logWriter = new LogWriter({
        dir: options.logDir ?? path.join(paths(options.env ?? process.env).logsDir, stack.name),
        services: stack.services.map((service) => service.name),
        maxBytes: stack.logs.maxFileBytes,
        keep: stack.logs.keepFiles,
      });
      this.#logWriter.attach(bus);
    }
  }

  /** Where a service's output is being written, if anywhere. */
  logFileFor(service: string): string | undefined {
    return this.#logWriter?.fileFor(service);
  }

  get(name: string): ManagedProcess | undefined {
    return this.#processes.get(name);
  }

  get processes(): ManagedProcess[] {
    return [...this.#processes.values()];
  }

  snapshot(): ServiceSnapshot[] {
    return this.processes.map((process) => ({
      name: process.service.name,
      state: process.state,
      ...(process.pid !== undefined ? { pid: process.pid } : {}),
      ...(process.uptimeMs !== undefined && isLive(process.state) ? { uptimeMs: process.uptimeMs } : {}),
      restarts: process.restarts,
      autostart: process.service.autostart,
      groups: process.service.groups,
      ...(process.service.project ? { project: process.service.project.key } : {}),
      ...(process.service.url ? { url: process.service.url } : {}),
      external: process.service.external,
      color: process.service.color,
    }));
  }

  /**
   * Starts every level in order; everything inside a level goes in parallel.
   * A failure rolls back what already started, so Ctrl-C is never needed to clean up.
   */
  async up(): Promise<void> {
    const startedAt = Date.now();
    this.#bus.emit({
      type: 'stack:starting',
      stack: this.stack.name,
      services: this.stack.services.map((service) => service.name),
      at: startedAt,
    });

    for (const level of this.stack.levels) {
      // `autostart: false` services stay in `queued` — defined, visible, startable on demand.
      const toStart = level.filter((name) => this.#processes.get(name)?.service.autostart !== false);

      const results = await Promise.allSettled(
        toStart.map(async (name) => {
          const process = this.#processes.get(name)!;
          await process.start();
          this.#startedOrder.push(name);
        }),
      );

      const failures = results
        .map((result, index) => ({ result, name: toStart[index]! }))
        .filter((entry): entry is { result: PromiseRejectedResult; name: string } => entry.result.status === 'rejected');

      if (failures.length > 0) {
        const reasons = failures.map((failure) => {
          const error: unknown = failure.result.reason;
          return error instanceof Error ? error.message : String(error);
        });
        for (const reason of reasons) {
          this.#bus.emit({ type: 'notice', level: 'error', message: reason, at: Date.now() });
        }
        await this.down('boot failed');
        throw new Error(`could not boot "${this.stack.name}":\n  ${reasons.join('\n  ')}`);
      }
    }

    this.#bus.emit({
      type: 'stack:ready',
      stack: this.stack.name,
      durationMs: Date.now() - startedAt,
      at: Date.now(),
    });
  }

  /** Reverse topological order, parallel within a level. */
  async down(reason?: string): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;

    this.#bus.emit({ type: 'stack:stopping', stack: this.stack.name, at: Date.now() });
    if (reason) {
      this.#bus.emit({ type: 'notice', level: 'info', message: `stopping: ${reason}`, at: Date.now() });
    }

    for (const level of [...this.stack.levels].reverse()) {
      await Promise.all(
        level.map(async (name) => {
          const process = this.#processes.get(name);
          if (!process) return;
          try {
            await process.dispose();
          } catch (error) {
            this.#bus.emit({
              type: 'notice',
              level: 'error',
              service: name,
              message: `stop failed: ${error instanceof Error ? error.message : String(error)}`,
              at: Date.now(),
            });
          }
        }),
      );
    }

    this.#bus.emit({ type: 'stack:stopped', stack: this.stack.name, at: Date.now() });
    // Flush and close the log files last, so the shutdown itself is recorded.
    await this.#logWriter?.close();
    this.#shuttingDown = false;
  }

  async restart(name: string): Promise<void> {
    const process = this.#requireProcess(name);
    await process.restart();
  }

  async stopService(name: string): Promise<void> {
    await this.#requireProcess(name).stop();
  }

  async startService(name: string): Promise<void> {
    await this.#requireProcess(name).start();
  }

  /** Every service carrying `group`, in dependency order. */
  servicesInGroup(group: string): string[] {
    return this.stack.services.filter((service) => service.groups.includes(group)).map((service) => service.name);
  }

  #requireProcess(name: string): ManagedProcess {
    const process = this.#processes.get(name);
    if (!process) {
      const available = [...this.#processes.keys()].join(', ');
      throw new Error(`no service "${name}" in stack "${this.stack.name}". Available: ${available}`);
    }
    return process;
  }
}
