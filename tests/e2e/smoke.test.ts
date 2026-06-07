import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { realSpawn } from '../../src/sync/rojo.js';

const enabled = process.env.BLOX_E2E === '1' && !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!enabled)('blox e2e smoke', () => {
  it('edits a script and commits via the built CLI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-e2e-'));
    cpSync(resolve(__dirname, '../../test-fixtures/game'), dir, { recursive: true });
    await realSpawn('git', ['init'], { cwd: dir });
    await realSpawn('git', ['config', 'user.email', 'e2e@blox.dev'], { cwd: dir });
    await realSpawn('git', ['config', 'user.name', 'blox e2e'], { cwd: dir });
    await realSpawn('git', ['add', '-A'], { cwd: dir });
    await realSpawn('git', ['commit', '-m', 'init'], { cwd: dir });

    const cli = resolve(__dirname, '../../dist/cli.js');
    const res = await realSpawn(
      'node',
      [cli, '--mock', '--project', dir, 'Add a one-line comment to the top of Greeter.luau'],
      { cwd: dir },
    );
    expect(res.code).toBe(0);

    const log = await realSpawn('git', ['log', '--oneline'], { cwd: dir });
    expect(log.stdout).toMatch(/blox:/);
  }, 180_000);
});
