// The gait generator: a description's gait steps every leg of a rig, its
// planted feet travelling straight back along the ground, in the order its
// pattern gives; and what a gait cannot do is refused with its path.
import { describe, expect, test } from 'vitest';
import { prepareAnimation } from '../src/anim/animation-tool.js';
import { buildTracks, pointToWorld, poseRig } from '../src/anim/motion.js';
import { compilePoseAnimation, type KeyframeSequenceDescription } from '../src/anim/pose-compiler.js';
import type { Rig } from '../src/anim/rig.js';
import { R15_RIG } from '../src/anim/r15-rig.js';
import { R6_RIG } from '../src/anim/r6-rig.js';

const LEGS = ['FrontLeft', 'FrontRight', 'HindLeft', 'HindRight'];

function prepared(rig: Rig, gait: Record<string, unknown>, more: Record<string, unknown> = {}) {
  const result = prepareAnimation({ name: 'Gait', rig: rig.name, loop: true, priority: 'Movement', duration: 1, gait, ...more }, { locomotion: true }, rig);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.value;
}

const errorsOf = (rig: Rig, input: Record<string, unknown>): string[] => {
  const result = compilePoseAnimation({ name: 'Gait', rig: rig.name, loop: true, duration: 1, ...input }, rig);
  return result.ok ? [] : result.errors;
};

/** Where a foot part's sole centre is at a time, in the root part's frame. */
function sole(sequence: KeyframeSequenceDescription, rig: Rig, part: string, time: number): [number, number, number] {
  const posed = poseRig(buildTracks(sequence), time, rig);
  return pointToWorld(posed.parts.get(part)!, [0, -rig.parts[part][1] / 2, 0]);
}

/** When in the cycle each leg's foot comes down: the first sample it is on the ground after being off it. */
function touchdowns(sequence: KeyframeSequenceDescription, rig: Rig): Record<string, number> {
  const samples = 200;
  const out: Record<string, number> = {};
  for (const leg of LEGS) {
    const down = Array.from({ length: samples }, (_unused, index) => sole(sequence, rig, `${leg}Lower`, (sequence.duration * index) / samples)[1] - rig.ground <= 0.02);
    const index = down.findIndex((on, at) => on && !down[(at + samples - 1) % samples]);
    out[leg] = (Math.round((index / samples) * 20) / 20) % 1;
  }
  return out;
}

describe('legs of one piece', () => {

  test('on R6 a walk passes the checks R6 has', () => {
    const walk = prepared(R6_RIG, { pattern: 'walk', stride: 1.6 }, { rig: 'R6', duration: 0.8 });
    expect(walk.failing).toEqual([]);
  });
});

describe('a gait on R15', () => {
  test('a walk alternates the legs, and passes every locomotion check', () => {
    const walk = prepared(R15_RIG, { pattern: 'walk', stride: 2.4 }, { rig: 'R15', duration: 0.8 });
    expect(walk.failing).toEqual([]);
    const symmetry = walk.report.checks.find((check) => check.id === 'gaitSymmetry')!;
    expect(symmetry.status).toBe('pass');
    expect(walk.report.groundSpeed).toBeCloseTo(2.4 / (0.65 * 0.8), 0);
  });
});

