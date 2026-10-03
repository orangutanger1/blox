import { describe, expect, it } from 'vitest';
import { suggestJoints } from '../src/anim/rigSuggest.js';
import { parseBuildJoints, planRigBuild, type PiecesReading } from '../src/anim/rig-build.js';
import { dogJoints, dogPieces } from './fixtures/anim/dog-pieces.js';

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const strip = (j: Record<string, unknown>) => { const { why: _w, loose: _l, ...rest } = j; return rest; };
const box = (name: string, at: [number, number, number], size: [number, number, number]) => ({ name, cframe: [...at, 1, 0, 0, 0, 1, 0, 0, 0, 1], size });
const reading = (parts: PiecesReading['parts']): PiecesReading => ({ path: 'Workspace.Thing', revision: 'rp1:x', pivot: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], parts, joints: [], welds: [], controllers: [] });

describe('suggestJoints on the Parts dog', () => {
  for (const turn of [0, 37]) {
    it(`proposes the hand rig's tree, names and pivots (turned ${turn}°)`, () => {
      const s = suggestJoints(dogPieces({ turn }), 'quadruped');
      expect(s.trunk).toBe('Body');
      const hand = dogJoints({ turn });
      const byPart = new Map(s.joints.map((j) => [j.part, j]));
      expect([...byPart.keys()].sort()).toEqual(hand.map((j) => j.part).sort());
      for (const h of hand) {
        const got = byPart.get(h.part)!;
        expect(got.parent, h.part).toBe(h.parent);
        expect(got.name ?? got.part, h.part).toBe(h.name ?? h.part);
        expect(dist(got.pivot, h.pivot), h.part).toBeLessThanOrEqual(0.15);
      }
      expect([...(byPart.get('Head')!.with ?? [])].sort()).toEqual(['LeftEar', 'Nose', 'RightEar']);
      expect(s.joints.every((j) => j.loose === undefined)).toBe(true);
    });
  }
  it('its output, stripped of why, plans a sound rig', () => {
    const s = suggestJoints(dogPieces(), 'quadruped');
    const parsed = parseBuildJoints(s.joints.map((j) => strip(j as unknown as Record<string, unknown>)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = planRigBuild(dogPieces(), { joints: parsed.joints, controller: 'Humanoid', plan: 'quadruped', replaceImporter: false });
    expect(r.ok, r.ok ? '' : r.errors.join('\n')).toBe(true);
  });
});

describe('suggestJoints on other bodies', () => {
  it('a biped: arms and legs on the torso, head on top', () => {
    const s = suggestJoints(reading([
      box('Torso', [0, 3, 0], [2, 2, 1]),
      box('Head', [0, 4.5, 0], [1, 1, 1]),
      box('LeftArm', [-1.5, 3, 0], [1, 2, 1]),
      box('RightArm', [1.5, 3, 0], [1, 2, 1]),
      box('LeftLeg', [-0.5, 1, 0], [1, 2, 1]),
      box('RightLeg', [0.5, 1, 0], [1, 2, 1]),
    ]), 'custom');
    expect(s.trunk).toBe('Torso');
    const parents = Object.fromEntries(s.joints.map((j) => [j.part, j.parent]));
    expect(parents).toEqual({ Head: 'Torso', LeftArm: 'Torso', RightArm: 'Torso', LeftLeg: 'Torso', RightLeg: 'Torso' });
    const leg = s.joints.find((j) => j.part === 'LeftLeg')!;
    expect(leg.pivot[1]).toBeCloseTo(2, 5); // the top of the leg, where it meets the torso
    const arm = s.joints.find((j) => j.part === 'LeftArm')!;
    expect(arm.pivot[0]).toBeCloseTo(-1, 5); // the arm's inner face
  });
  it('a snake: a chain from the biggest segment, each turning where it meets the last', () => {
    const segs = [0, 1, 2, 3].map((i) => box(`Seg${i}`, [0, 1, i * 2], i === 0 ? [1.2, 1.2, 2] : [1, 1, 2]));
    const s = suggestJoints(reading(segs), 'custom');
    expect(s.trunk).toBe('Seg0');
    expect(s.joints.map((j) => [j.part, j.parent])).toEqual([['Seg1', 'Seg0'], ['Seg2', 'Seg1'], ['Seg3', 'Seg2']]);
    expect(s.joints[1].pivot[2]).toBeCloseTo(3, 5);
  });
  it('a loose part is still joined, flagged with its gap', () => {
    const s = suggestJoints(reading([box('Body', [0, 0, 0], [2, 2, 2]), box('Orb', [0, 3, 0], [1, 1, 1])]), 'custom');
    const orb = s.joints.find((j) => j.part === 'Orb')!;
    expect(orb.parent).toBe('Body');
    expect(orb.loose).toBeCloseTo(1.5, 5);
    expect(s.notes.join('\n')).toMatch(/Orb touches nothing/);
  });
  it('a small part on the trunk keeps its own joint (the trunk has no joint to ride)', () => {
    const s = suggestJoints(reading([box('Body', [0, 0, 0], [4, 2, 4]), box('Gem', [0, 1.1, 0], [0.2, 0.2, 0.2])]), 'custom');
    expect(s.joints).toHaveLength(1);
    expect(s.joints[0].part).toBe('Gem');
  });
  it('quadruped names it cannot find become notes, never renames', () => {
    const s = suggestJoints(reading([box('Body', [0, 0, 0], [2, 1, 4]), box('Leg1', [0, -1, 0], [0.5, 1, 0.5])]), 'quadruped');
    expect(s.notes.join('\n')).toMatch(/FrontLeft/);
    expect(s.joints[0].part).toBe('Leg1');
  });
  it('skips hidden parts and a root an earlier build made', () => {
    const r = reading([box('Body', [0, 0, 0], [2, 2, 2]), box('Arm', [1.5, 0, 0], [1, 1, 1]), { ...box('HumanoidRootPart', [0, 0, 0], [2, 2, 2]), hidden: true, madeRoot: true }]);
    const s = suggestJoints(r, 'custom');
    expect(s.joints.map((j) => j.part)).toEqual(['Arm']);
  });
});
