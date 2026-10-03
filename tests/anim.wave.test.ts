// The wave generator: a description's waves become rotation keys that send a
// sine down a chain of joints, each trailing the one before; a loop meets
// itself; and what a wave cannot do is refused with its path.
import { describe, expect, test } from 'vitest';
import { prepareAnimation } from '../src/anim/animation-tool.js';
import { buildTracks, sampleTrack } from '../src/anim/motion.js';
import { compilePoseAnimation, type KeyframeSequenceDescription } from '../src/anim/pose-compiler.js';
import type { Rig } from '../src/anim/rig.js';

/** A part's turn about X and about Z at a time, in degrees: its joint's frame is the body's. */
function turnOf(sequence: KeyframeSequenceDescription, part: string, time: number): { x: number; z: number } {
  const r = sampleTrack(buildTracks(sequence).get(part), time).r;
  const degrees = (radians: number) => (radians * 180) / Math.PI;
  // CFrame.Angles(x, 0, z) is Rx * Rz.
  return { x: degrees(Math.atan2(-r[5], r[8])), z: degrees(Math.atan2(-r[1], r[0])) };
}

describe('a wave on the stock rigs', () => {
  test('a wave works on R15 too', () => {
    const result = compilePoseAnimation({ name: 'Sway', rig: 'R15', loop: true, duration: 2, waves: [{ joints: ['Waist', 'Neck'], axis: 'Z', amplitude: [4, 8], lag: 0.2 }] });
    expect(result.ok && result.sequence.joints).toEqual(['Waist', 'Neck']);
  });
});
