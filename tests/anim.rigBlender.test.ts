import { describe, expect, it } from 'vitest';
import { AXIS_ROTATIONS, fitBlenderPivots, type BlenderPivots } from '../src/anim/rigBlender.js';
import { dogJoints, dogPieces } from './fixtures/anim/dog-pieces.js';

type V3 = [number, number, number];
const mul = (m: number[], v: readonly number[]): V3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const tr = (m: number[]) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const absM = (m: number[]) => m.map(Math.abs);
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The dog as Blender would describe it if Roblox's import turned Blender
 * coordinates by `m` and moved them by `t`, in the model's own (unturned) frame.
 * `turn` turns the inserted model about Y.
 */
function blenderDog(m: number[], t: V3, turn = 0, rename: (n: string) => string = (n) => n): { pivots: BlenderPivots; parts: ReturnType<typeof dogPieces>['parts'] } {
  const pieces = dogPieces({ turn });
  const flat = dogPieces();
  const back = (q: readonly number[]) => mul(tr(m), [q[0] - t[0], q[1] - t[1], q[2] - t[2]]);
  const hand = dogJoints();
  const riders = hand.filter((j) => j.with?.length).map((j) => [j.part, j.with!] as const);
  return {
    parts: pieces.parts.map((p) => ({ ...p, name: rename(p.name) })),
    pivots: {
      pieces: flat.parts.map((p) => ({ name: p.name, bone: p.name, center: back(p.cframe.slice(0, 3)), size: mul(absM(tr(m)), p.size) })),
      joints: hand.map((j) => ({ name: j.name ?? j.part, part: j.part, parent: j.parent, pivot: back(j.pivot) })),
      riders: Object.fromEntries(riders),
    },
  };
}

describe('fitBlenderPivots', () => {
  it('there are 24 proper axis rotations', () => {
    expect(AXIS_ROTATIONS).toHaveLength(24);
  });
  it('recovers every axis rotation and offset, matched by name', () => {
    for (const m of AXIS_ROTATIONS) {
      const { pivots, parts } = blenderDog(m, [3, -1, 7]);
      const fit = fitBlenderPivots(pivots, parts);
      expect(fit.ok, fit.ok ? '' : fit.errors.join('\n')).toBe(true);
      if (!fit.ok) continue;
      expect(fit.matchedBy).toBe('name');
      for (const h of dogJoints()) {
        const got = fit.joints.find((j) => j.part === h.part)!;
        expect(dist(got.pivot, h.pivot)).toBeLessThan(1e-6);
        expect(got.parent).toBe(h.parent);
      }
      expect(fit.joints.find((j) => j.part === 'Head')!.with).toEqual(['LeftEar', 'RightEar', 'Nose']);
    }
  });
  it('places pivots on a model turned 37° after insert', () => {
    const { pivots, parts } = blenderDog(AXIS_ROTATIONS[5], [0, 2, 0], 37);
    const fit = fitBlenderPivots(pivots, parts);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    for (const h of dogJoints({ turn: 37 })) expect(dist(fit.joints.find((j) => j.part === h.part)!.pivot, h.pivot)).toBeLessThan(1e-6);
  });
  it('tolerates small noise, refuses a residual over tolerance', () => {
    const { pivots, parts } = blenderDog(AXIS_ROTATIONS[0], [0, 0, 0]);
    const noisy = { ...pivots, pieces: pivots.pieces.map((p, i) => ({ ...p, center: [p.center[0] + (i % 2 ? 0.01 : -0.01), p.center[1], p.center[2]] as V3 })) };
    expect(fitBlenderPivots(noisy, parts).ok).toBe(true);
    const moved = { ...pivots, pieces: pivots.pieces.map((p) => (p.name === 'Tail' ? { ...p, center: [p.center[0] + 1, p.center[1], p.center[2]] as V3 } : p)) };
    const r = fitBlenderPivots(moved, parts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/0\.05/);
  });
  it('matches by position when the upload renamed every piece', () => {
    const { pivots, parts } = blenderDog(AXIS_ROTATIONS[3], [1, 1, 1], 0, (n) => `Mesh_${n}`);
    const fit = fitBlenderPivots(pivots, parts);
    expect(fit.ok, fit.ok ? '' : fit.errors.join('\n')).toBe(true);
    if (!fit.ok) return;
    expect(fit.matchedBy).toBe('position');
    expect(fit.joints.find((j) => j.part === 'Mesh_Head')!.parent).toBe('Mesh_Body');
  });
  it('refuses names that do not match when the counts differ too', () => {
    const { pivots, parts } = blenderDog(AXIS_ROTATIONS[0], [0, 0, 0]);
    const r = fitBlenderPivots(pivots, parts.filter((p) => p.name !== 'Tail'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/Tail/);
  });
  it('refuses a fit more than one rotation explains (pieces on one line)', () => {
    const line = ['A', 'B', 'C'].map((name, i) => ({ name, cframe: [0, 0, i * 2, 1, 0, 0, 0, 1, 0, 0, 0, 1], size: [1, 1, 2] as V3 }));
    const pivots: BlenderPivots = {
      pieces: line.map((p) => ({ name: p.name, bone: p.name, center: [0, p.cframe[2], 0], size: [1, 2, 1] })),
      joints: [{ name: 'B', part: 'B', parent: 'A', pivot: [0, 1, 0] }],
      riders: {},
    };
    const r = fitBlenderPivots(pivots, line);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/more than one/);
  });
  it('refuses pieces turned differently from each other', () => {
    const { pivots, parts } = blenderDog(AXIS_ROTATIONS[0], [0, 0, 0]);
    const odd = parts.map((p) => (p.name === 'Tail' ? { ...p, cframe: [...p.cframe.slice(0, 3), 0, 0, 1, 0, 1, 0, -1, 0, 0] } : p));
    const r = fitBlenderPivots(pivots, odd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/turned differently/);
  });
});
