// tests/design.sim.test.ts
import { describe, it, expect } from 'vitest';
import { validateDesign, type DesignDoc } from '../src/design/schema.js';
import { simulate, ttr, mulberry32, SimError } from '../src/design/sim.js';

function doc(raw: Record<string, unknown>): DesignDoc {
  const r = validateDesign({ version: 1, meta: { title: 'T', format: 'other' }, ...raw });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.doc;
}
const always = [{ id: 'a', session: { lengthSec: 86400, perDay: 1 }, policy: 'roi' }];
const first = (tr: { events: { ref: string; n: number; t: number }[] }, ref: string, n = 1) => tr.events.find((e) => e.ref === ref && e.n >= n);

describe('ttr', () => {
  it('linear', () => expect(ttr(0, 10, 2, 0)).toBe(5));
  it('already there', () => expect(ttr(10, 10, 0, 0)).toBe(0));
  it('no income', () => expect(ttr(0, 10, 0, 0)).toBe(Infinity));
  it('decay below target equilibrium is never', () => expect(ttr(0, 10, 1, 0.2)).toBe(Infinity)); // eq = 5
  it('decay with reachable target', () => expect(ttr(0, 5, 1, 0.1)).toBeCloseTo(Math.log(2) / 0.1, 9)); // eq = 10
});

describe('mulberry32', () => {
  it('is deterministic per seed', () => {
    const a = mulberry32(7), b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(mulberry32(8)()).not.toBe(mulberry32(7)());
  });
});

describe('simulate', () => {
  it('buys the first generator when affordable (closed form)', () => {
    const d = doc({
      economy: {
        resources: [{ id: 'cash' }],
        actions: [{ id: 'click', yields: { cash: 2 }, perSec: 1 }],
        generators: [{ id: 'g', produces: { cash: 1 }, cost: { res: 'cash', base: 10 }, max: 1 }],
      },
      archetypes: always,
    });
    const tr = simulate(d, { archetype: 'a', horizonSec: 100, seed: 1 });
    expect(first(tr, 'generator:g')!.t).toBe(5);
  });
  it('generator cost grows by growth^owned', () => {
    const d = doc({
      economy: {
        resources: [{ id: 'cash', start: 100 }],
        generators: [{ id: 'g', produces: { cash: 0 }, cost: { res: 'cash', base: 10, growth: 2 }, max: 3 }],
      },
      archetypes: [{ id: 'a', session: { lengthSec: 86400, perDay: 1 }, policy: 'cheapest' }],
    });
    const tr = simulate(d, { archetype: 'a', horizonSec: 10, seed: 1 });
    expect(tr.events.filter((e) => e.ref === 'generator:g').length).toBe(3); // 10+20+40 = 70 <= 100
    expect(tr.samples.length).toBe(0);
  });
  it('requires gates purchases until the gate opens (auto-open on threshold)', () => {
    const d = doc({
      economy: {
        resources: [{ id: 'cash' }, { id: 'speed', spendable: false }],
        actions: [{ id: 'walk', yields: { speed: 1, cash: 1 }, perSec: 1 }],
        gates: [{ id: 'z2', needs: { res: 'speed', amount: 30 } }],
        generators: [{ id: 'g', produces: { cash: 1 }, cost: { res: 'cash', base: 1 }, max: 1, requires: 'gate:z2' }],
      },
      archetypes: always,
    });
    const tr = simulate(d, { archetype: 'a', horizonSec: 100, seed: 1 });
    expect(first(tr, 'gate:z2')!.t).toBe(30);
    expect(first(tr, 'generator:g')!.t).toBe(30);
  });
  it('offline earns fraction up to cap, actions stop offline', () => {
    const d = doc({
      economy: {
        resources: [{ id: 'cash', start: 0 }],
        upgrades: [{ id: 'base', cost: { res: 'cash', base: 1e12 }, effect: { target: 'cash', add: 1 } }],
        offline: { fraction: 0.5, capSec: 100 },
      },
      archetypes: [{ id: 'a', session: { lengthSec: 10, perDay: 1 }, policy: 'roi' }],
    });
    // no generators owned → no income at all; prove offline uses generator income only
    const tr = simulate(d, { archetype: 'a', horizonSec: 1000, seed: 1, probes: [1000] });
    expect(tr.samples.at(-1)!.bal.cash).toBe(0);
    const d2 = doc({
      economy: {
        resources: [{ id: 'cash', start: 10 }],
        generators: [{ id: 'g', produces: { cash: 1 }, cost: { res: 'cash', base: 10 }, max: 1 }],
        offline: { fraction: 0.5, capSec: 100 },
      },
      archetypes: [{ id: 'a', session: { lengthSec: 10, perDay: 1 }, policy: 'roi' }],
    });
    const t2 = simulate(d2, { archetype: 'a', horizonSec: 1000, seed: 1, probes: [10, 1000] });
    // bought at t=0, online 10s → 10 cash; offline 100s × 0.5 → +50
    expect(t2.samples[0].bal.cash).toBeCloseTo(10, 9);
    expect(t2.samples[1].bal.cash).toBeCloseTo(60, 9);
    expect(t2.endPlay).toBe(10);
  });
  it('drains decay balances', () => {
    const d = doc({
      economy: { resources: [{ id: 'cash', start: 1000 }], drains: [{ id: 'theft', res: 'cash', fractionPerHour: 0.5 }] },
      archetypes: always,
    });
    const tr = simulate(d, { archetype: 'a', horizonSec: 3600, seed: 1, probes: [3600] });
    expect(tr.samples[0].bal.cash).toBeCloseTo(1000 * Math.exp(-0.5), 6);
  });
  it('rebirth resets listed state, multiplies income, and re-grants owned passes', () => {
    const d = doc({
      monetization: [{ id: 'x2', kind: 'pass', effect: 'upgrade:x2' }],
      economy: {
        resources: [{ id: 'cash' }],
        actions: [{ id: 'click', yields: { cash: 1 }, perSec: 1 }],
        upgrades: [{ id: 'x2', cost: { res: 'cash', base: 1e9 }, effect: { target: 'cash', mult: 2 } }],
        rebirth: { needs: { res: 'cash', base: 100, growth: 1 }, mult: { target: '*', per: 2 }, resets: ['cash', 'upgrades'] },
      },
      archetypes: [{ id: 'a', session: { lengthSec: 86400, perDay: 1 }, policy: 'roi', owns: ['x2'] }],
    });
    const tr = simulate(d, { archetype: 'a', horizonSec: 200, seed: 1 });
    // income 2/s (pass) → rebirth 1 at 50s; then 4/s → rebirth 2 at 75s
    expect(first(tr, 'rebirth', 1)!.t).toBe(50);
    expect(first(tr, 'rebirth', 2)!.t).toBe(75);
  });
  it('chance rolls are seeded and deterministic', () => {
    const d = doc({
      economy: {
        resources: [{ id: 'cash', start: 1000 }],
        chance: [{ id: 'egg', cost: { res: 'cash', base: 10 }, max: 20, outcomes: [{ id: 'c', weight: 9, grants: { 'res:cash': 1 } }, { id: 'r', weight: 1, grants: { 'res:cash': 100 } }] }],
      },
      archetypes: [{ id: 'a', session: { lengthSec: 86400, perDay: 1 }, policy: 'cheapest' }],
    });
    const a = simulate(d, { archetype: 'a', horizonSec: 5, seed: 3, probes: [5] });
    const b = simulate(d, { archetype: 'a', horizonSec: 5, seed: 3, probes: [5] });
    expect(a.samples).toEqual(b.samples);
    const balances = new Set([1, 2, 3, 4, 5, 6].map((s) => simulate(d, { archetype: 'a', horizonSec: 5, seed: s, probes: [5] }).samples[0].bal.cash));
    expect(balances.size).toBeGreaterThan(1);
  });
  it('event skipping matches the plain 1 s loop', () => {
    const d = doc({
      economy: {
        resources: [{ id: 'cash' }],
        actions: [{ id: 'click', yields: { cash: 1 }, perSec: 1.5 }],
        generators: [{ id: 'g', produces: { cash: 0.7 }, cost: { res: 'cash', base: 7, growth: 1.13 } }],
        upgrades: [{ id: 'u', cost: { res: 'cash', base: 120 }, effect: { target: 'cash', mult: 1.5 }, max: 3 }],
        drains: [{ id: 'd', res: 'cash', fractionPerHour: 0.02 }],
        offline: { fraction: 0.3, capSec: 3600 },
      },
      archetypes: [{ id: 'a', session: { lengthSec: 1200, perDay: 3 }, policy: 'roi' }],
    });
    const o = { archetype: 'a', horizonSec: 86400, seed: 1, probes: [43200, 86400] };
    const skip = simulate(d, { ...o, mode: 'skip' });
    const tick = simulate(d, { ...o, mode: 'tick' });
    expect(skip.events.map((e) => `${e.ref}#${e.n}@${e.t}`)).toEqual(tick.events.map((e) => `${e.ref}#${e.n}@${e.t}`));
    expect(Math.abs(skip.samples[1].bal.cash - tick.samples[1].bal.cash) / tick.samples[1].bal.cash).toBeLessThan(1e-9);
  });
  it('runaway economies raise a named SimError', () => {
    const d = doc({
      economy: {
        resources: [{ id: 'cash', start: 1 }],
        actions: [{ id: 'click', yields: { cash: 1 }, perSec: 1 }],
        rebirth: { needs: { res: 'cash', base: 1, growth: 1 }, mult: { target: '*', per: 1000 }, resets: [] },
      },
      archetypes: always,
    });
    expect(() => simulate(d, { archetype: 'a', horizonSec: 86400, seed: 1 })).toThrow(SimError);
  });
  it('monetization with non-upgrade effect is ignored', () => {
    const d = doc({
      monetization: [{ id: 'luck', kind: 'product', effect: 'generator:g' }],
      economy: {
        resources: [{ id: 'cash' }],
        actions: [{ id: 'click', yields: { cash: 1 }, perSec: 1 }],
        generators: [{ id: 'g', produces: { cash: 1 }, cost: { res: 'cash', base: 5 }, max: 1 }],
      },
      archetypes: [{ id: 'a', session: { lengthSec: 86400, perDay: 1 }, policy: 'roi', owns: ['luck'] }],
    });
    expect(first(simulate(d, { archetype: 'a', horizonSec: 20, seed: 1 }), 'generator:g')!.t).toBe(5);
  });
  it('unknown archetype throws SimError', () => {
    const d = doc({ economy: { resources: [{ id: 'cash' }] }, archetypes: always });
    expect(() => simulate(d, { archetype: 'nope', horizonSec: 10, seed: 1 })).toThrow(/unknown archetype/);
  });
});
