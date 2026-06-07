import { describe, it, expect } from 'vitest';
import { syncProject, type SpawnFn } from '../src/sync/rojo.js';

const okSpawn: SpawnFn = async () => ({ code: 0, stdout: '{}', stderr: '' });
const failSpawn: SpawnFn = async () => ({ code: 1, stdout: '', stderr: 'bad project' });

describe('syncProject', () => {
  it('reports ok when rojo sourcemap succeeds', async () => {
    const res = await syncProject('/game', okSpawn);
    expect(res.ok).toBe(true);
  });

  it('reports failure with stderr detail', async () => {
    const res = await syncProject('/game', failSpawn);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('bad project');
  });

  it('invokes rojo sourcemap in the project dir', async () => {
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const spy: SpawnFn = async (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return { code: 0, stdout: '{}', stderr: '' };
    };
    await syncProject('/game', spy);
    expect(calls[0]).toEqual({ cmd: 'rojo', args: ['sourcemap'], cwd: '/game' });
  });
});
