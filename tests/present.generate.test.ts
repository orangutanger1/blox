import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateDesign, type DesignDoc } from '../src/design/schema.js';
import { titleCandidates, describe as describeGame, defaultShots } from '../src/present/generate.js';
import { validatePresentation } from '../src/present/schema.js';

function load(name: string): DesignDoc {
  const v = validateDesign(JSON.parse(readFileSync(new URL(`../docs/examples/design/${name}.json`, import.meta.url), 'utf8')));
  if (!v.ok) throw new Error('bad example');
  return v.doc;
}

describe('titleCandidates', () => {
  it('verb + article + object, +1 stat for incremental, and the current title', () => {
    expect(titleCandidates(load('steal-tycoon'))).toEqual(['Carve A Snow Beast', 'Carve a Snow Beast']);
    const inc = titleCandidates(load('incremental'));
    expect(inc).not.toContain('Run A Speed'); // the object is a stat, not a thing
    expect(inc).toContain('+1 Speed Escape');
    expect(inc).toContain('+1 Speed Escape'.length <= 50 ? '+1 Speed Escape' : '');
  });
  it('uses "An" before vowels and caps at 50 chars', () => {
    const d = load('steal-tycoon');
    d.meta.verb = 'Steal';
    d.meta.object = 'egg';
    expect(titleCandidates(d)[0]).toBe('Steal An Egg');
    d.meta.object = 'x'.repeat(60);
    expect(titleCandidates(d).every((t) => t.length <= 50)).toBe(true);
  });
  it('skips "Verb A Object" when the object is the verb itself ("Jump A Jump")', () => {
    const d = load('incremental');
    d.meta.verb = 'Jump';
    d.meta.object = 'jump';
    expect(titleCandidates(d).some((t) => /Jump A Jump/i.test(t))).toBe(false);
  });
});

describe('describe: no claims the design does not back', () => {
  it('no OFFLINE line when offline earning is off or nothing earns the currency offline', () => {
    const d = load('steal-tycoon');
    d.economy.offline = { fraction: 0, capSec: 0 };
    expect(describeGame(d)).not.toMatch(/OFFLINE/);
    const e = load('steal-tycoon');
    for (const g of e.economy.generators) g.produces = {};
    expect(describeGame(e)).not.toMatch(/OFFLINE/);
  });
  it('names the rebirth target when it is not everything', () => {
    const d = load('steal-tycoon');
    d.economy.rebirth!.mult = { target: d.economy.resources[0].id, per: 1.5 };
    expect(describeGame(d)).toMatch(new RegExp(`x1\\.5 ${d.economy.resources[0].id} boost`, 'i'));
  });
});

describe('defaultShots origin', () => {
  it('offsets cameras and subjects to the spawn', () => {
    const d = load('incremental');
    const a = defaultShots(d);
    const b = defaultShots(d, [400, 5, 0]);
    expect(b[0].camera.position[0]).toBe(a[0].camera.position[0] + 400);
    expect(b[0].camera.lookAt[1]).toBe(a[0].camera.lookAt[1] + 5);
    expect(b[0].subject!.at[0]).toBe(a[0].subject!.at[0] + 400);
  });
});

describe('describe', () => {
  it('follows the rising-game template from the design', () => {
    const text = describeGame(load('steal-tycoon'));
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/Welcome to Carve a Snow Beast!$/);
    expect(lines[1]).toBe('How to Play:');
    expect(text).toMatch(/Train/);
    expect(text).toMatch(/even while OFFLINE/);
    expect(text).toMatch(/Rebirth for a permanent x1\.5 boost/);
    expect(text).toMatch(/Supports Desktop, Console, Mobile, and Tablet/);
    expect(text).not.toMatch(/like/i);
    expect(text.length).toBeLessThanOrEqual(1000);
  });
});

describe('defaultShots + schema', () => {
  it('5 distinct thumbnails and an icon that validate', () => {
    const shots = defaultShots(load('incremental'));
    expect(shots.filter((s) => s.kind === 'thumbnail')).toHaveLength(5);
    expect(new Set(shots.filter((s) => s.kind === 'thumbnail').map((s) => s.theme)).size).toBe(5);
    expect(shots.filter((s) => s.kind === 'icon')).toHaveLength(1);
    const v = validatePresentation({ version: 1, title: 'T', description: 'D', shots });
    expect(v.ok).toBe(true);
  });
  it('schema rejects bad colours, duplicate ids and unknown keys', () => {
    const bad = validatePresentation({
      version: 1, title: 'T', description: 'D',
      shots: [
        { id: 'a', kind: 'thumbnail', theme: 'action', camera: { position: [0, 0, 0], lookAt: [0, 0, 1] }, overlay: { text: 'x', color: 'red' } },
        { id: 'a', kind: 'icon', theme: 'logo', camera: { position: [0, 0, 0], lookAt: [0, 0, 1] }, bogus: 1 },
      ],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    const msg = bad.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
    expect(msg).toMatch(/shots\.0\.overlay\.color/);
    expect(msg).toMatch(/shots\.1/);
  });
});
