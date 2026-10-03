import { describe, expect, it } from 'vitest';
import { mergeDeclarations, planDeclarations } from '../src/anim/body-plans.js';
import { rigFromModel } from '../src/anim/model-rig.js';
import { partsDog } from './fixtures/anim/parts-dog.js';

const jointsOf = (r: ReturnType<typeof partsDog>) => r.joints.map((j) => ({ name: j.name, parentPart: j.part0, childPart: j.part1 }));

describe('body plans', () => {
  it('quadruped declares feet, knees and ranges from part names, and the rig accepts them', () => {
    const reading = partsDog({ knees: true });
    const planned = planDeclarations('quadruped', jointsOf(reading));
    expect(planned.feet).toEqual(['FrontLeftLower', 'FrontRightLower', 'HindLeftLower', 'HindRightLower']);
    expect(planned.hinges?.FrontLeftKnee).toEqual({ axis: 'X', flex: -1 });
    expect(planned.hinges?.HindLeftKnee).toEqual({ axis: 'X', flex: 1 });
    const r = rigFromModel({ ...reading, declarations: JSON.stringify(planned) });
    expect(r.ok && r.rig.feet.length).toBe(4);
  });
  it('custom declares only what is given; given values win joint by joint', () => {
    expect(planDeclarations('custom', jointsOf(partsDog()))).toEqual({ version: 1 });
    const merged = mergeDeclarations(planDeclarations('quadruped', jointsOf(partsDog({ knees: true }))), { limits: { Tail: { turn: 30 } } });
    expect((merged.limits as Record<string, unknown>).Tail).toEqual({ turn: 30 });
    expect((merged.limits as Record<string, unknown>).FrontLeft).toEqual({ turn: 120 });
  });
});
