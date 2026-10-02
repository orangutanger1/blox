import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blenderArgs, NORMALIZE_SCRIPT, parseNormalize, runNormalize, type Spawner } from '../src/assets/blender.js';

const input = () => {
  const f = join(mkdtempSync(join(tmpdir(), 'blox-bl-')), 'm.glb');
  writeFileSync(f, 'x');
  return f;
};

describe('normalize', () => {
  it('builds the headless command', () => {
    expect(blenderArgs('a.glb', 'a.fbx', 8000, 6)).toEqual(['-b', '--factory-startup', '--python', NORMALIZE_SCRIPT, '--', 'a.glb', 'a.fbx', '8000', '6']);
  });
  it('parses the report', () => {
    expect(parseNormalize('noise\nBLOX_NORMALIZE tris_before=52000 tris_after=9990 size=2.000,3.500,6.000\n', 'o.fbx')).toEqual({ out: 'o.fbx', trisBefore: 52000, trisAfter: 9990, size: [2, 3.5, 6] });
  });
  it('runs with an injected spawner and maps failures to readable errors', async () => {
    const ok: Spawner = async () => ({ code: 0, stdout: 'BLOX_NORMALIZE tris_before=10 tris_after=10 size=1,1,1', stderr: '' });
    expect((await runNormalize({ input: input(), out: 'o.fbx', tris: 100, height: 0, spawn: ok })).trisAfter).toBe(10);
    const missing: Spawner = async () => ({ code: null, stdout: '', stderr: 'spawn blender ENOENT', notFound: true });
    await expect(runNormalize({ input: input(), out: 'o', tris: 1, height: 0, spawn: missing })).rejects.toThrow(/Blender not found/);
    const bad: Spawner = async () => ({ code: 1, stdout: 'BLOX_ERROR unsupported format .txt', stderr: '' });
    await expect(runNormalize({ input: input(), out: 'o', tris: 1, height: 0, spawn: bad })).rejects.toThrow(/unsupported format/);
    await expect(runNormalize({ input: '/nope.glb', out: 'o', tris: 1, height: 0, spawn: ok })).rejects.toThrow(/input not found/);
  });
  it('normalize.py parses', () => {
    let py = 'python3';
    try { execFileSync(py, ['--version']); } catch { return; }
    // ast.parse: syntax check without writing __pycache__ into the repo
    expect(() => execFileSync(py, ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', NORMALIZE_SCRIPT])).not.toThrow();
  });
});
