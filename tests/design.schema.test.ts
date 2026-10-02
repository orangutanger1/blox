// tests/design.schema.test.ts
import { describe, it, expect } from 'vitest';
import { validateDesign, parseRef } from '../src/design/schema.js';

export function minimal(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    meta: { title: 'T', format: 'incremental' },
    economy: {
      resources: [{ id: 'cash', start: 0 }],
      actions: [{ id: 'click', yields: { cash: 1 }, perSec: 1 }],
      generators: [{ id: 'dropper', produces: { cash: 1 }, cost: { res: 'cash', base: 10, growth: 1.15 } }],
    },
    archetypes: [{ id: 'active', session: { lengthSec: 900, perDay: 2 }, policy: 'roi' }],
    assertions: [{ id: 'first-dropper', archetype: 'active', metric: 'timeTo', target: 'generator:dropper', op: '<=', value: 60 }],
    ...over,
  };
}
const errs = (raw: unknown) => {
  const r = validateDesign(raw);
  return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
};

describe('validateDesign', () => {
  it('accepts a minimal doc and applies defaults', () => {
    const r = validateDesign(minimal());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.economy.resources[0].spendable).toBe(true);
    expect(r.doc.assertions[0].pct).toBe(50);
    expect(r.doc.assertions[0].clock).toBe('play');
    expect(r.doc.tunables).toEqual({});
  });
  it('reports zod shape errors with paths', () => {
    expect(errs({ ...minimal(), version: 2 }).join()).toMatch(/^version:/);
  });
  it('rejects unknown keys', () => {
    expect(errs({ ...minimal(), bogus: 1 }).length).toBeGreaterThan(0);
  });
  it('rejects duplicate ids', () => {
    const d = minimal();
    (d.economy as any).resources.push({ id: 'cash' });
    expect(errs(d).join()).toMatch(/duplicate id "cash"/);
  });
  it('rejects dangling refs', () => {
    const d = minimal();
    (d.economy as any).generators[0].requires = 'gate:nope';
    expect(errs(d).join()).toMatch(/economy\.generators\.0\.requires: unknown ref "gate:nope"/);
  });
  it('rejects costs on non-spendable resources', () => {
    const d = minimal();
    (d.economy as any).resources.push({ id: 'speed', spendable: false });
    (d.economy as any).generators[0].cost.res = 'speed';
    expect(errs(d).join()).toMatch(/not spendable/);
  });
  it('rejects growth below 1', () => {
    const d = minimal();
    (d.economy as any).generators[0].cost.growth = 0.9;
    expect(errs(d).length).toBeGreaterThan(0);
  });
  it('rejects a gate whose resource nothing produces', () => {
    const d = minimal();
    (d.economy as any).resources.push({ id: 'gems' });
    (d.economy as any).gates = [{ id: 'z2', needs: { res: 'gems', amount: 5 } }];
    expect(errs(d).join()).toMatch(/nothing produces "gems"/);
  });
  it('rejects consume on a stat', () => {
    const d = minimal();
    (d.economy as any).resources.push({ id: 'speed', spendable: false });
    (d.economy as any).actions[0].yields.speed = 1;
    (d.economy as any).gates = [{ id: 'z2', needs: { res: 'speed', amount: 5, consume: true } }];
    expect(errs(d).join()).toMatch(/cannot consume/);
  });
  it('rejects sessions longer than their slot', () => {
    const d = minimal({ archetypes: [{ id: 'active', session: { lengthSec: 50000, perDay: 2 }, policy: 'roi' }] });
    expect(errs(d).join()).toMatch(/longer than its slot/);
  });
  it('requires target for timeTo, res+at for balanceAt, of+vs for ratio', () => {
    const d = minimal({
      archetypes: [
        { id: 'active', session: { lengthSec: 900, perDay: 2 }, policy: 'roi' },
        { id: 'payer', session: { lengthSec: 900, perDay: 2 }, policy: 'roi' },
      ],
      assertions: [
        { id: 'a', archetype: 'active', metric: 'timeTo', op: '<=', value: 1 },
        { id: 'b', archetype: 'active', metric: 'balanceAt', op: '>=', value: 1 },
        { id: 'c', archetype: 'active', metric: 'ratio', op: '<=', value: 3 },
        { id: 'd', archetype: 'active', metric: 'balanceAt', res: 'cash', at: 60, clock: 'play', op: '>=', value: 1 },
        { id: 'e', archetype: 'active', metric: 'timeTo', target: 'generator:dropper', op: 'between', value: 5 },
        { id: 'f', archetype: 'active', metric: 'timeTo', target: 'generator:dropper', op: 'between', value: [9, 2] },
      ],
    });
    const e = errs(d).join('\n');
    expect(e).toMatch(/assertions\.0: timeTo needs target/);
    expect(e).toMatch(/assertions\.1: balanceAt needs res and at/);
    expect(e).toMatch(/assertions\.2: ratio needs of and vs/);
    expect(e).toMatch(/assertions\.3: balanceAt supports clock "wall" only/);
    expect(e).toMatch(/assertions\.4: between needs \[lo, hi\]/);
    expect(e).toMatch(/assertions\.5: between needs lo <= hi/);
  });
  it('accepts non-upgrade monetization effects (sim ignores them)', () => {
    const d = minimal({ monetization: [{ id: 'luck', kind: 'product', effect: 'generator:dropper' }] });
    expect(errs(d)).toEqual([]);
  });
  it('rejects owns that is not a monetization id', () => {
    const d = minimal({ archetypes: [{ id: 'active', session: { lengthSec: 900, perDay: 2 }, policy: 'roi', owns: ['vip'] }] });
    expect(errs(d).join()).toMatch(/unknown monetization "vip"/);
  });
  it('rejects rebirth refs when no rebirth is defined', () => {
    const d = minimal();
    (d.assertions as any)[0].target = 'rebirth:1';
    expect(errs(d).join()).toMatch(/unknown ref "rebirth:1"/);
  });
  it('rejects add on target "*"', () => {
    const d = minimal();
    (d.economy as any).upgrades = [{ id: 'u', cost: { res: 'cash', base: 5 }, effect: { target: '*', add: 1 } }];
    expect(errs(d).join()).toMatch(/add needs a resource target/);
  });
  it('rejects upgrades with both or neither of mult/add', () => {
    const d = minimal();
    (d.economy as any).upgrades = [{ id: 'u', cost: { res: 'cash', base: 5 }, effect: { target: 'cash' } }];
    expect(errs(d).join()).toMatch(/exactly one of mult or add/);
  });
});

describe('parseRef', () => {
  it('splits kind, id and optional count', () => {
    expect(parseRef('generator:dropper:3')).toEqual({ kind: 'generator', id: 'dropper', n: 3 });
    expect(parseRef('gate:z2')).toEqual({ kind: 'gate', id: 'z2' });
    expect(parseRef('rebirth:2')).toEqual({ kind: 'rebirth', id: '2' });
  });
});
