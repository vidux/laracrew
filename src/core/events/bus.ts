import type { EventListener, LaracrewEvent } from './types.js';

/**
 * Deliberately not an EventEmitter: subscribers get *every* event, which keeps the
 * renderers dumb and makes the daemon's IPC stream a straight passthrough.
 */
export class EventBus {
  #listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(event: LaracrewEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        // A broken renderer must never take the supervisor down with it.
        process.emitWarning(
          `laracrew: event listener threw: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** Resolves on the first event matching `predicate`, or rejects on timeout. */
  next(predicate: (event: LaracrewEvent) => boolean, timeoutMs = 10_000): Promise<LaracrewEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error('timed out waiting for event'));
      }, timeoutMs);
      timer.unref?.();

      const unsubscribe = this.subscribe((event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      });
    });
  }

  get size(): number {
    return this.#listeners.size;
  }
}
