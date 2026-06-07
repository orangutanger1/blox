import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { syncProject } from '../src/sync/rojo.js';

function rojoAvailable(): boolean {
  try {
    execSync('rojo --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Self-skips when rojo is not installed, so CI without rojo stays green.
describe.skipIf(!rojoAvailable())('syncProject (real rojo)', () => {
  it('produces a sourcemap for the fixture game', async () => {
    const fixture = resolve(__dirname, '../test-fixtures/game');
    const res = await syncProject(fixture);
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('ok');
  });

  it('fails cleanly on a directory with no Rojo project', async () => {
    const res = await syncProject(resolve(__dirname, '..'));
    expect(res.ok).toBe(false);
  });
});
