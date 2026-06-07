import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitChanges } from '../src/git/commit.js';
import { realSpawn } from '../src/sync/rojo.js';

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'blox-git-'));
  await realSpawn('git', ['init'], { cwd: dir });
  await realSpawn('git', ['config', 'user.email', 'test@blox.dev'], { cwd: dir });
  await realSpawn('git', ['config', 'user.name', 'blox test'], { cwd: dir });
  return dir;
}

describe('commitChanges', () => {
  it('returns null sha and empty files when nothing changed', async () => {
    const dir = await initRepo();
    const res = await commitChanges(dir, 'noop');
    expect(res.sha).toBeNull();
    expect(res.files).toEqual([]);
  });

  it('stages and commits changed files, returning the sha', async () => {
    const dir = await initRepo();
    writeFileSync(join(dir, 'a.luau'), 'return 1\n');
    const res = await commitChanges(dir, 'add a.luau');
    expect(res.files).toContain('a.luau');
    expect(res.sha).toMatch(/^[0-9a-f]{7,40}$/);
  });
});
