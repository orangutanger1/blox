// Real headless Blender run of the model pipeline. Gated: BLOX_LIVE_BLENDER=1.
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runModelPy } from '../../src/model/run.js';

describe.skipIf(!process.env.BLOX_LIVE_BLENDER)('model pipeline in Blender', () => {
  it('builds, checks, renders and exports a rigged voxel dog', async () => {
    const d = mkdtempSync(join(tmpdir(), 'blox-mdl-'));
    const blend = join(d, 'model.blend');
    const code = new URL('../fixtures/model/dog.py', import.meta.url).pathname;
    const run = (await runModelPy('run', { blend, code, budget: 2000 }, d)) as { triangles: number; bones: number; issues: string[]; size: number[] };
    expect(run.triangles).toBe(348);
    expect(run.bones).toBe(6);
    expect(run.size).toEqual([3, 6, 9]);
    expect(run.issues).toEqual([]);
    const check = (await runModelPy('check', { blend, views: join(d, 'views'), budget: 2000 }, d)) as { views: string[] };
    expect(check.views.map((v) => v.split('/').pop())).toEqual(['front.png', 'right.png', 'back.png', 'three_quarter.png']);
    for (const v of check.views) expect(existsSync(v)).toBe(true);
    const ex = (await runModelPy('export', { blend, out: join(d, 'export') }, d)) as { model: string; animations: Record<string, string>; preview: string };
    expect(Object.keys(ex.animations).sort()).toEqual(['Sleep', 'Walk']);
    const prev = JSON.parse(readFileSync(ex.preview, 'utf8')) as { triangles: { v: number[][] }[] };
    const ys = prev.triangles.flatMap((t) => t.v.map((p) => p[1]));
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(6, 3); // rest pose, Roblox Y up
  }, 180_000);
});
