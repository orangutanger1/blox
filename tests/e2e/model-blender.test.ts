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
  it('exports a rigid-piece dog: pieces-only GLB + pivots.json', async () => {
    const d = mkdtempSync(join(tmpdir(), 'blox-mdl-rigid-'));
    const blend = join(d, 'model.blend');
    const code = new URL('../fixtures/model/rigid-dog.py', import.meta.url).pathname;
    await runModelPy('run', { blend, code, budget: 2000 }, d);
    const ex = (await runModelPy('export', { blend, out: join(d, 'export') }, d)) as { pivots?: string; upload?: string; pieces?: number };
    expect(ex.pivots).toBeTruthy();
    expect(ex.pieces).toBe(7);
    const chk = (await runModelPy('check', { blend, views: join(d, 'views') }, d)) as { issues: string[]; uploadParts: number };
    expect(chk.issues.join('\n')).not.toMatch(/no mesh is skinned/);
    expect(chk.uploadParts).toBe(7);
    expect(existsSync(ex.upload!)).toBe(true);
    const p = JSON.parse(readFileSync(ex.pivots!, 'utf8')) as { pieces: { name: string; center: number[]; size: number[] }[]; joints: { name: string; part: string; parent: string; pivot: number[] }[]; riders: Record<string, string[]> };
    expect(p.pieces.map((x) => x.name).sort()).toEqual(['Body', 'FrontLeft', 'FrontRight', 'Head', 'HindLeft', 'HindRight', 'Nose']);
    expect(p.joints.map((j) => [j.part, j.parent]).sort()).toEqual([['FrontLeft', 'Body'], ['FrontRight', 'Body'], ['Head', 'Body'], ['HindLeft', 'Body'], ['HindRight', 'Body']]);
    expect(p.riders).toEqual({ Head: ['Nose'] });
    const hip = p.joints.find((j) => j.part === 'FrontLeft')!;
    expect(hip.pivot).toEqual([-0.7, -1.4, 1.6]);
    expect(p.pieces.find((x) => x.name === 'Body')!.size).toEqual([2, 4, 1.2]);
  }, 180_000);
});
