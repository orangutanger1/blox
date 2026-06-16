import { describe, it, expect, vi } from 'vitest';
import { ccrReachable, ensureCcr } from '../src/ccrServe.js';

const noSleep = () => Promise.resolve();

describe('ccrReachable', () => {
  it('true when the fetch resolves (any HTTP response, even 404)', async () => {
    expect(await ccrReachable('http://x', async () => ({ status: 404 }))).toBe(true);
  });
  it('false when the fetch throws (connection refused)', async () => {
    expect(await ccrReachable('http://x', async () => { throw new Error('ECONNREFUSED'); })).toBe(false);
  });
});

describe('ensureCcr', () => {
  it('reused: returns true without spawning when already reachable', async () => {
    const spawn = vi.fn();
    const ok = await ensureCcr(() => {}, { fetchFn: async () => ({}), spawn });
    expect(ok).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawned: starts ccr, then succeeds once the port answers', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) throw new Error('down'); // initial probe + first poll fail
      return {}; // second poll succeeds
    });
    const spawn = vi.fn();
    const logs: string[] = [];
    const ok = await ensureCcr((m) => logs.push(m), { fetchFn, spawn, sleep: noSleep, delayMs: 0 });
    expect(ok).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
    expect(logs.some((l) => l.includes('starting'))).toBe(true);
    expect(logs.some((l) => l.includes('ready'))).toBe(true);
  });

  it('gives up after the poll window and returns false', async () => {
    const spawn = vi.fn();
    const logs: string[] = [];
    const ok = await ensureCcr((m) => logs.push(m), {
      fetchFn: async () => { throw new Error('down'); },
      spawn,
      attempts: 3,
      delayMs: 0,
      sleep: noSleep,
    });
    expect(ok).toBe(false);
    expect(spawn).toHaveBeenCalledOnce();
    expect(logs.some((l) => l.includes('did not come up'))).toBe(true);
  });
});
