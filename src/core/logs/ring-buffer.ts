import type { LogLine } from '../events/types.js';

/**
 * Bounded per-service history. A chatty worker must not grow the heap forever, and the
 * TUI only ever renders a window of this anyway.
 */
export class RingBuffer<T = LogLine> {
  #items: (T | undefined)[];
  #next = 0;
  #count = 0;
  #dropped = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.#items = Array.from({ length: capacity });
  }

  push(item: T): void {
    if (this.#count === this.capacity) this.#dropped += 1;
    this.#items[this.#next] = item;
    this.#next = (this.#next + 1) % this.capacity;
    this.#count = Math.min(this.#count + 1, this.capacity);
  }

  /** Oldest to newest. */
  toArray(): T[] {
    const out: T[] = [];
    const start = this.#count === this.capacity ? this.#next : 0;
    for (let i = 0; i < this.#count; i += 1) {
      out.push(this.#items[(start + i) % this.capacity]!);
    }
    return out;
  }

  /** The last `n` items, oldest to newest — what a log pane actually needs. */
  tail(n: number): T[] {
    if (n >= this.#count) return this.toArray();
    const out: T[] = [];
    for (let i = this.#count - n; i < this.#count; i += 1) {
      const start = this.#count === this.capacity ? this.#next : 0;
      out.push(this.#items[(start + i) % this.capacity]!);
    }
    return out;
  }

  clear(): void {
    this.#items = Array.from({ length: this.capacity });
    this.#next = 0;
    this.#count = 0;
    this.#dropped = 0;
  }

  get size(): number {
    return this.#count;
  }

  /** How many items fell off the back — worth showing in the UI. */
  get dropped(): number {
    return this.#dropped;
  }
}
