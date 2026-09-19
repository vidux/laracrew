import type { Supervisor } from '../core/process/supervisor.js';
import type { LogLine, ServiceState } from '../core/events/types.js';
import { describeProbe } from '../core/health/probes.js';

/**
 * What the views render. Built by polling the supervisor rather than by streaming events:
 * the ring buffers already hold everything, so a poll is cheaper than a re-render per line
 * and a chatty worker cannot stall the UI.
 */

export interface ProcessRow {
  index: number;
  name: string;
  state: ServiceState;
  pid: number | undefined;
  uptimeMs: number | undefined;
  restarts: number;
  external: boolean;
  autostart: boolean;
  /** What laracrew waits on, e.g. "tcp 127.0.0.1:6379". Shown for dependencies. */
  probe: string | undefined;
  project: string | undefined;
  command: string | undefined;
  cwd: string;
  url: string | undefined;
  groups: string[];
  logLines: number;
}

export interface StackView {
  name: string;
  /** Processes laracrew starts and stops. Indices here are what the digit keys select. */
  rows: ProcessRow[];
  /** `external: true` services — health-checked, never managed. Not selectable. */
  dependencies: ProcessRow[];
  running: number;
  total: number;
  restarts: number;
  failed: number;
  dependenciesDown: number;
}

const commandOf = (supervisor: Supervisor, name: string): string | undefined => {
  const service = supervisor.stack.services.find((entry) => entry.name === name);
  if (!service?.command) return undefined;
  return service.command.kind === 'shell'
    ? service.command.line
    : [service.command.file, ...service.command.args].join(' ');
};

export const buildStackView = (supervisor: Supervisor): StackView => {
  const all: ProcessRow[] = supervisor.processes.map((managed) => ({
    index: -1, // assigned below, once externals are out of the way
    name: managed.service.name,
    state: managed.state,
    pid: managed.pid,
    uptimeMs: managed.uptimeMs,
    restarts: managed.restarts,
    external: managed.service.external,
    autostart: managed.service.autostart,
    probe: managed.service.ready ? describeProbe(managed.service.ready) : undefined,
    project: managed.service.project?.key,
    command: commandOf(supervisor, managed.service.name),
    cwd: managed.service.cwd,
    url: managed.service.url,
    groups: managed.service.groups,
    logLines: managed.logs.size,
  }));

  // Externals are checked, not run. Keeping them out of the numbered list means a digit key
  // always selects something laracrew can actually start and stop.
  const dependencies = all.filter((row) => row.external);
  const rows = all.filter((row) => !row.external).map((row, index) => ({ ...row, index }));

  return {
    name: supervisor.stack.name,
    rows,
    dependencies,
    running: rows.filter((row) => row.state === 'running' || row.state === 'ready').length,
    total: rows.length,
    restarts: rows.reduce((sum, row) => sum + row.restarts, 0),
    failed: rows.filter((row) => row.state === 'failed' || row.state === 'crashed').length,
    dependenciesDown: dependencies.filter((row) => row.state !== 'ready' && row.state !== 'running').length,
  };
};

export const logsFor = (supervisor: Supervisor, name: string, limit: number): LogLine[] =>
  supervisor.get(name)?.logs.tail(limit) ?? [];

/** Merged view: the newest `limit` lines across every service, oldest first. */
export const mergedLogs = (supervisor: Supervisor, limit: number): LogLine[] => {
  const perService = Math.max(20, Math.ceil(limit / Math.max(1, supervisor.processes.length)) * 4);
  const all: LogLine[] = [];
  for (const managed of supervisor.processes) all.push(...managed.logs.tail(perService));
  all.sort((a, b) => a.at - b.at);
  return all.slice(-limit);
};
