import { EventEmitter } from 'node:events';

/**
 * `laracrew up --json | head` closes the pipe under us. Without this, Node turns the EPIPE
 * into an unhandled 'error' event and kills the process — which skips the shutdown path and
 * orphans every child. So a broken pipe is treated as "the reader left": stop writing, then
 * shut the stack down cleanly.
 */

export interface WritableLike extends EventEmitter {
  write(chunk: string): boolean;
}

let closed = false;
const handlers = new Set<() => void>();

export const outputClosed = (): boolean => closed;

/** Registers a callback for when stdout goes away. Returns an unsubscribe function. */
export const onOutputClosed = (handler: () => void): (() => void) => {
  handlers.add(handler);
  if (closed) handler();
  return () => {
    handlers.delete(handler);
  };
};

const markClosed = (): void => {
  if (closed) return;
  closed = true;
  for (const handler of handlers) {
    try {
      handler();
    } catch {
      // Nothing useful left to do — stdout is already gone.
    }
  }
};

const isPipeError = (error: NodeJS.ErrnoException): boolean =>
  error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED' || error.code === 'ERR_STREAM_WRITE_AFTER_END';

export const installPipeGuards = (streams: WritableLike[] = [process.stdout, process.stderr]): void => {
  for (const stream of streams) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (isPipeError(error)) {
        markClosed();
        return;
      }
      throw error;
    });
  }
};

/** The write every renderer should use: a no-op once the reader has gone. */
export const write = (text: string, stream: WritableLike = process.stdout): void => {
  if (closed) return;
  try {
    stream.write(text);
  } catch (error) {
    if (isPipeError(error as NodeJS.ErrnoException)) markClosed();
    else throw error;
  }
};

/** Test seam — the module-level flag would otherwise leak between cases. */
export const resetOutputState = (): void => {
  closed = false;
  handlers.clear();
};
