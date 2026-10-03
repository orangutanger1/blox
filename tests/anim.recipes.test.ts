import { describe, it, expect } from 'vitest';
import { loadRecipes } from '../src/anim/recipes.js';
import { compilePoseAnimation } from '../src/anim/pose-compiler.js';
import { checkMotion } from '../src/anim/motion-checks.js';
import { rigFor } from '../src/anim/rigs.js';
import { listSkills } from '../src/skills.js';
import { rigFromModel } from '../src/anim/model-rig.js';
import { kneeDeclarations, partsDog } from './fixtures/anim/parts-dog.js';

const DOG = (() => { const r = rigFromModel({ ...partsDog({ knees: true, declarations: kneeDeclarations() }), path: 'Workspace.Dog' }); if (!r.ok) throw new Error(r.errors.join()); return r.rig; })();

const GAITS = new Set(['Walk', 'Run', 'WalkR6', 'DogWalk']);

describe('animation recipes', () => {
  const all = loadRecipes();
  it('ships the props-free recipes', () => {
    expect([...all.keys()].sort()).toEqual(['DogWalk', 'Idle', 'Jump', 'Run', 'TailWag', 'Walk', 'WalkR6', 'Wave', 'WaveR6']);
  });
  it.each([...loadRecipes().keys()])('%s compiles and passes every check that applies', (name) => {
    const model = (all.get(name) as { rig?: string }).rig === 'Workspace.Dog' ? DOG : undefined;
    const c = compilePoseAnimation(all.get(name), model);
    if (!c.ok) throw new Error(c.errors.join('\n'));
    const rig = model ?? rigFor(c.sequence.rig);
    const report = checkMotion(c.sequence, { locomotion: GAITS.has(name), grounded: name !== 'Jump' }, rig);
    expect(report.checks.filter((x) => x.status === 'fail').map((x) => `${x.id}: ${x.detail}`)).toEqual([]);
  });
  it('is served by the skill tool', () => {
    expect(listSkills().some((s) => s.name === 'character-animation')).toBe(true);
  });
});
