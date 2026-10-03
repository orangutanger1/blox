import { describe, it, expect } from 'vitest';
import { compilePoseAnimation } from '../src/anim/pose-compiler.js';
import { renderContactSheet } from '../src/anim/contact-sheet.js';
import { rigFor } from '../src/anim/rigs.js';

const wave = {
  name: 'Wave', rig: 'R15', loop: true,
  keyframes: [
    { time: 0, joints: { RightShoulder: { rotation: [0, 0, 150] } } },
    { time: 0.5, joints: { RightShoulder: { rotation: [0, 0, 120] } } },
    { time: 1, joints: { RightShoulder: { rotation: [0, 0, 150] } } },
  ],
};

describe('contact sheet', () => {
  it('renders a PNG of the rig at several moments', () => {
    const c = compilePoseAnimation(wave);
    if (!c.ok) throw new Error(c.errors.join('\n'));
    const sheet = renderContactSheet(c.sequence, undefined, { rig: rigFor('R15') });
    expect(sheet.png.subarray(1, 4).toString()).toBe('PNG');
    expect(sheet.times.length).toBeGreaterThanOrEqual(5);
    expect(sheet.width).toBeGreaterThan(0);
  });
});
