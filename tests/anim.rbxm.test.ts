import { describe, it, expect } from 'vitest';
import { compilePoseAnimation } from '../src/anim/pose-compiler.js';
import { loadRecipes } from '../src/anim/recipes.js';
import { sequenceXml } from '../src/anim/rbxm.js';

const seq = () => {
  const c = compilePoseAnimation(loadRecipes().get('Jump'));
  if (!c.ok) throw new Error(c.errors.join());
  return c.sequence;
};

describe('sequenceXml', () => {
  it('writes the KeyframeSequence with nested Poses, weights, easing tokens and priority', () => {
    const s = seq();
    const xml = sequenceXml(s);
    expect(xml).toMatch(/^<roblox /);
    expect(xml.match(/class="Keyframe"/g)!.length).toBe(s.keyframes.length);
    expect(xml.match(/class="Pose"/g)!.length).toBe(s.poseCount);
    expect(xml).toMatch(/<string name="Name">HumanoidRootPart<\/string>/);
    expect(xml).toMatch(/<float name="Weight">0<\/float>/); // hierarchy placeholders
    expect(xml).toContain(`<bool name="Loop">${s.loop}</bool>`);
    expect(xml).toMatch(/<token name="Priority">\d+<\/token>/);
  });
  it('escapes names', () => {
    const s = { ...seq(), name: 'A<&>' };
    expect(sequenceXml(s)).toContain('A&lt;&amp;&gt;');
  });
  it('writes markers as KeyframeMarker items', () => {
    const s = seq();
    s.keyframes[0] = { ...s.keyframes[0], markers: [{ name: 'Hit', value: 'x' }] };
    expect(sequenceXml(s)).toMatch(/class="KeyframeMarker".*<string name="Name">Hit<\/string>.*<string name="Value">x<\/string>/s);
  });
});
