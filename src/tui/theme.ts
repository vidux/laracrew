import type { ServiceState } from '../core/events/types.js';

/**
 * Restrained on purpose: colour carries state, nothing else. The glyph and the word always
 * say the same thing, so a mono terminal loses nothing.
 */

const asciiOnly = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.LARACREW_ASCII === '1' || env.TERM === 'dumb';

export interface Glyphs {
  running: string;
  ready: string;
  starting: string;
  stopped: string;
  failed: string;
  queued: string;
  branch: string;
  lastBranch: string;
  pipe: string;
  pointer: string;
  restart: string;
  rule: string;
  dot: string;
  tick: string;
}

const UNICODE: Glyphs = {
  running: '●',
  ready: '●',
  starting: '◐',
  stopped: '◼',
  failed: '✖',
  queued: '○',
  branch: '├─',
  lastBranch: '└─',
  pipe: '│',
  pointer: '▸',
  restart: '⟳',
  rule: '─',
  dot: '·',
  tick: '✔',
};

const ASCII: Glyphs = {
  running: '*',
  ready: '*',
  starting: 'o',
  stopped: '#',
  failed: 'X',
  queued: '.',
  branch: '|-',
  lastBranch: '`-',
  pipe: '|',
  pointer: '>',
  restart: 'r',
  rule: '-',
  dot: '.',
  tick: 'v',
};

export const glyphs = (env: NodeJS.ProcessEnv = process.env): Glyphs => (asciiOnly(env) ? ASCII : UNICODE);

export type StateColor = 'green' | 'yellow' | 'red' | 'gray' | 'cyan';

export interface StateStyle {
  glyph: keyof Glyphs;
  color: StateColor;
  label: string;
}

export const STATE_STYLE: Record<ServiceState, StateStyle> = {
  queued: { glyph: 'queued', color: 'gray', label: 'QUEUED' },
  starting: { glyph: 'starting', color: 'yellow', label: 'STARTING' },
  ready: { glyph: 'ready', color: 'cyan', label: 'READY' },
  running: { glyph: 'running', color: 'green', label: 'RUNNING' },
  stopping: { glyph: 'starting', color: 'yellow', label: 'STOPPING' },
  stopped: { glyph: 'stopped', color: 'gray', label: 'STOPPED' },
  crashed: { glyph: 'failed', color: 'red', label: 'CRASHED' },
  backoff: { glyph: 'starting', color: 'yellow', label: 'RESTARTING' },
  failed: { glyph: 'failed', color: 'red', label: 'FAILED' },
};

/** 00:15:27 — the header clock. */
export const formatUptime = (ms: number | undefined): string => {
  if (ms === undefined || ms < 0) return '--:--:--';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
};

/** 1m 02s — compact, for a table column. */
export const formatDuration = (ms: number | undefined): string => {
  if (ms === undefined || ms < 0) return '—';
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
};

export const formatClock = (at: number): string => {
  const date = new Date(at);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
};
