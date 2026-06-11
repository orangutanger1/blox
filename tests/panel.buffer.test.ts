import { describe, it, expect } from 'vitest';
import { EventBuffer } from '../src/panel/buffer.js';
import type { PanelEvent } from '../src/panel/events.js';

const log = (text: string): PanelEvent => ({ type: 'log', text });

describe('EventBuffer', () => {
  it('appends events with increasing cursors and returns them since a cursor', () => {
    const b = new EventBuffer();
    b.append(log('a'));
    b.append(log('b'));
    const r = b.since(0);
    expect(r.cursor).toBe(2);
    expect(r.events).toEqual([log('a'), log('b')]);
    expect(b.since(2).events).toEqual([]);
    expect(b.since(1).events).toEqual([log('b')]);
  });

  it('evicts oldest events past capacity but keeps cursors monotonic', () => {
    const b = new EventBuffer(3);
    for (const t of ['a', 'b', 'c', 'd']) b.append(log(t));
    const r = b.since(0); // 'a' evicted
    expect(r.events).toEqual([log('b'), log('c'), log('d')]);
    expect(r.cursor).toBe(4);
  });

  it('notifies a waiter exactly once when an event arrives', async () => {
    const b = new EventBuffer();
    let woke = 0;
    const p = b.waitForChange().then(() => { woke += 1; });
    b.append(log('x'));
    await p;
    expect(woke).toBe(1);
    b.append(log('y')); // no pending waiter — must not throw
  });
});
