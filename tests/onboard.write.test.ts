import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePlan } from '../src/onboard/write.js';
import type { LayoutPlan } from '../src/onboard/layout.js';
import type { SpawnFn } from '../src/sync/rojo.js';

const plan: LayoutPlan = {
  files: [{ path: 'src/ReplicatedStorage/Mod.luau', source: 'return 1' }],
  project: { name: 'g', tree: { $className: 'DataModel', ReplicatedStorage: { $path: 'src/ReplicatedStorage' } } },
  conflicts: [],
  renamed: [],
};

// Records git invocations, always succeeds.
function fakeSpawn(): { fn: SpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  const fn: SpawnFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    // After a fresh `git init`, freshly written files show as untracked (`??`).
    if (cmd === 'git' && args[0] === 'status') return { stdout: '?? src/ReplicatedStorage/Mod.luau', stderr: '', code: 0 };
    if (cmd === 'git' && args[0] === 'rev-parse') return { stdout: 'abc123', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  return { fn, calls };
}

describe('writePlan', () => {
  it('writes files + default.project.json and makes a baseline commit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-onboard-'));
    const { fn, calls } = fakeSpawn();
    const r = await writePlan(dir, plan, { force: false, spawn: fn });
    expect(existsSync(join(dir, 'src/ReplicatedStorage/Mod.luau'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'default.project.json'), 'utf8')).name).toBe('g');
    expect(r.written).toContain('src/ReplicatedStorage/Mod.luau');
    expect(r.baselineSha).toBe('abc123');
    expect(calls.some((c) => c[0] === 'git' && c[1] === 'init')).toBe(true);
  });

  it('refuses when default.project.json exists and force is false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-onboard-'));
    writeFileSync(join(dir, 'default.project.json'), '{}');
    const { fn, calls } = fakeSpawn();
    const r = await writePlan(dir, plan, { force: false, spawn: fn });
    expect(r.refused).toBe(true);
    expect(r.written).toEqual([]);
    expect(calls).toHaveLength(0); // refused before any git/fs side effects
  });

  it('writes nothing (no project file, no commit) for an empty plan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-onboard-'));
    const { fn, calls } = fakeSpawn();
    const empty: LayoutPlan = { ...plan, files: [], project: { name: 'g', tree: { $className: 'DataModel' } } };
    const r = await writePlan(dir, empty, { force: false, spawn: fn });
    expect(r.written).toEqual([]);
    expect(r.baselineSha).toBeNull();
    expect(existsSync(join(dir, 'default.project.json'))).toBe(false);
    expect(calls).toHaveLength(0); // no git init / commit on an empty onboard
  });

  it('writes nothing when an abort plan has conflicts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-onboard-'));
    const { fn, calls } = fakeSpawn();
    const conflicted: LayoutPlan = { ...plan, files: [], conflicts: [{ fullName: 'X.Dup', path: 'src/X/Dup.luau', reason: 'duplicate-path' }] };
    const r = await writePlan(dir, conflicted, { force: false, spawn: fn });
    expect(r.conflictsAborted).toBe(true);
    expect(existsSync(join(dir, 'default.project.json'))).toBe(false);
    expect(calls).toHaveLength(0); // aborted before any git/fs side effects
  });
});
