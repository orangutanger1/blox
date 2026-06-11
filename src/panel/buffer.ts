import type { PanelEvent } from './events.js';

// Cursor-addressed ring buffer. Cursors are monotonic event counts (not array
// indices), so a reconnecting plugin replays from its last cursor even after
// eviction — it just silently misses anything older than `capacity`.
export class EventBuffer {
  private events: PanelEvent[] = [];
  private evicted = 0; // count of events dropped off the front
  private waiters: (() => void)[] = [];

  constructor(private capacity = 1000) {}

  append(event: PanelEvent): void {
    this.events.push(event);
    if (this.events.length > this.capacity) {
      const toRemove = this.events.length - this.capacity;
      this.events.splice(0, toRemove);
      this.evicted += toRemove;
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  cursor(): number {
    return this.evicted + this.events.length;
  }

  since(cursor: number): { events: PanelEvent[]; cursor: number } {
    const start = Math.max(cursor - this.evicted, 0);
    return { events: this.events.slice(start), cursor: this.cursor() };
  }

  // Resolves on the next append. Used by the server's long-poll hold.
  waitForChange(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
