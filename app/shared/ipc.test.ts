import { describe, it, expect } from 'vitest';
import { IPC } from './ipc.js';

describe('IPC channel names', () => {
  it('are unique and stable', () => {
    const names = Object.values(IPC);
    expect(new Set(names).size).toBe(names.length);
    expect(IPC.runStart).toBe('run:start');
  });
});
