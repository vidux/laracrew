/**
 * The single vocabulary every renderer speaks. `core/` emits these; the TUI, the plain
 * printer, the JSON printer and the daemon's IPC stream are all just subscribers.
 * Nothing in core may import a renderer.
 */

export type ServiceState =
  | 'queued'
  | 'starting'
  | 'ready'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'crashed'
  | 'backoff'
  | 'failed';

/** States from which the service is not going to produce more output on its own. */
export const TERMINAL_STATES: ReadonlySet<ServiceState> = new Set(['stopped', 'failed']);

export const isLive = (state: ServiceState): boolean =>
  state === 'starting' || state === 'ready' || state === 'running';

export interface LogLine {
  service: string;
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
  at: number;
}

export type LaracrewEvent =
  | { type: 'stack:starting'; stack: string; services: string[]; at: number }
  | { type: 'stack:ready'; stack: string; durationMs: number; at: number }
  | { type: 'stack:stopping'; stack: string; at: number }
  | { type: 'stack:stopped'; stack: string; at: number }
  | {
      type: 'service:state';
      service: string;
      from: ServiceState;
      to: ServiceState;
      detail?: string;
      at: number;
    }
  | { type: 'service:spawned'; service: string; pid: number; command: string; cwd: string; at: number }
  | { type: 'service:ready'; service: string; durationMs: number; probe: string; at: number }
  | {
      type: 'service:exit';
      service: string;
      code: number | null;
      signal: NodeJS.Signals | null;
      intentional: boolean;
      at: number;
    }
  | { type: 'service:restart'; service: string; attempt: number; maxAttempts: number; delayMs: number; at: number }
  | { type: 'service:log'; log: LogLine }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string; service?: string; at: number };

export type EventListener = (event: LaracrewEvent) => void;
