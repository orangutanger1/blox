// tests/design.assert.test.ts
import { describe, it, expect } from 'vitest';
import { percentile, metricValue, fmtSeconds } from '../src/design/metrics.js';
import { evaluateAssertions, requiredProbes, requiredHorizon } from '../src/design/assert.js';
import { validateDesign, type DesignDoc } from '../src/design/schema.js';
import type { Trace } from '../src/design/sim.js';

const tr = (events: [number, number, string, number][], samples: [number, number, number][] = [], endPlay = 1000): Trace => ({
  archetype: 'a',
  seed: 1,
  horizonSec: 1000,
  events: events.map(([t, play, ref, n]) => ({ t, play, ref, n })),
  samples: samples.map(([t, play, cash]) => ({ t, play, bal: { cash } })),
  endPlay,
});

describe('percentile', () => {
  it('nearest rank', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 10)).toBe(1);
    expect(percentile([5, 1, 3, 2, 4], 90)).toBe(5);
    expect(percentile([1, Infinity], 90)).toBe(Infinity);
  });
});

describe('metricValue', () => {
  const t = tr([[10, 10, 'generator:g', 1], [30, 20, 'generator:g', 2], [50, 40, 'rebirth', 1], [70, 60, 'gate:z', 1]], [[100, 80, 42]], 90);
  it('timeTo by play (default) and wall', () => {
    expect(metricValue(t, { metric: 'timeTo', target: 'generator:g:2', clock: 'play' })).toBe(20);
    expect(metricValue(t, { metric: 'timeTo', target: 'generator:g:2', clock: 'wall' })).toBe(30);
    expect(metricValue(t, { metric: 'timeTo', target: 'rebirth:1', clock: 'play' })).toBe(40);
    expect(metricValue(t, { metric: 'timeTo', target: 'rebirth:2', clock: 'play' })).toBe(Infinity);
  });
  it('countAt', () => expect(metricValue(t, { metric: 'countAt', target: 'generator:g', at: 25, clock: 'play' })).toBe(2));
  it('balanceAt reads the probe sample', () => expect(metricValue(t, { metric: 'balanceAt', res: 'cash', at: 100, clock: 'wall' })).toBe(42));
  it('maxIdleGap over play time incl. start and end', () =>
    expect(metricValue(t, { metric: 'maxIdleGap', clock: 'play' })).toBe(30)); // 90-60
  it('maxIdleGap with horizon uses the probe at that wall time', () =>
    expect(metricValue(t, { metric: 'maxIdleGap', horizon: 100, clock: 'play' })).toBe(20)); // gaps 10,10,20,20,20(80-60)
});

describe('fmtSeconds', () => {
  it('formats', () => {
    expect(fmtSeconds(38)).toBe('38s');
    expect(fmtSeconds(725)).toBe('12m05s');
    expect(fmtSeconds(3720)).toBe('1h02m');
    expect(fmtSeconds(Infinity)).toBe('never (within horizon)');
  });
});

function doc(assertions: unknown[]): DesignDoc {
  const r = validateDesign({
    version: 1,
    meta: { title: 'T', format: 'other' },
    economy: { resources: [{ id: 'cash' }], actions: [{ id: 'c', yields: { cash: 1 }, perSec: 1 }], generators: [{ id: 'g', produces: { cash: 1 }, cost: { res: 'cash', base: 1 } }] },
    archetypes: [
      { id: 'a', session: { lengthSec: 900, perDay: 1 }, policy: 'roi' },
      { id: 'b', session: { lengthSec: 900, perDay: 1 }, policy: 'roi' },
    ],
    assertions,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.doc;
}

describe('evaluateAssertions', () => {
  const a1 = tr([[10, 10, 'generator:g', 1]]);
  const a2 = tr([[30, 30, 'generator:g', 1]]);
  const b1 = tr([[5, 5, 'generator:g', 1]]);
  it('<=, >=, between with pct', () => {
    const d = doc([
      { id: 'le', archetype: 'a', metric: 'timeTo', target: 'generator:g', op: '<=', value: 20, pct: 10 },
      { id: 'ge', archetype: 'a', metric: 'timeTo', target: 'generator:g', op: '>=', value: 20, pct: 90 },
      { id: 'bt', archetype: 'a', metric: 'timeTo', target: 'generator:g', op: 'between', value: [25, 35], pct: 50 },
    ]);
    const r = evaluateAssertions(d, { a: [a1, a2] });
    expect(r.map((x) => [x.id, x.ok])).toEqual([['le', true], ['ge', true], ['bt', false]]);
    expect(r[2].detail).toMatch(/p50=10s/);
  });
  it('ratio of two archetypes', () => {
    const d = doc([{ id: 'r', archetype: 'a', vs: 'b', metric: 'ratio', of: 'timeTo', target: 'generator:g', op: '<=', value: 3 }]);
    const r = evaluateAssertions(d, { a: [a2], b: [b1] });
    expect(r[0].actual).toBe(6);
    expect(r[0].ok).toBe(false);
  });
  it('never-reached targets fail with a readable detail', () => {
    const d = doc([{ id: 'n', archetype: 'a', metric: 'timeTo', target: 'generator:g:5', op: '<=', value: 60 }]);
    const r = evaluateAssertions(d, { a: [a1] });
    expect(r[0].ok).toBe(false);
    expect(r[0].detail).toMatch(/never \(within horizon\)/);
  });
  it('skips assertions whose archetypes were not simulated', () => {
    const d = doc([{ id: 'r', archetype: 'a', vs: 'b', metric: 'ratio', of: 'timeTo', target: 'generator:g', op: '<=', value: 3 }]);
    expect(evaluateAssertions(d, { a: [a1] })).toEqual([]);
  });
  it('requiredProbes / requiredHorizon', () => {
    const d = doc([
      { id: 'b', archetype: 'a', metric: 'balanceAt', res: 'cash', at: 500, clock: 'wall', op: '>=', value: 1 },
      { id: 'g', archetype: 'a', metric: 'maxIdleGap', horizon: 200000, op: '<=', value: 300 },
    ]);
    expect(requiredProbes(d).sort((x, y) => x - y)).toEqual([500, 200000]);
    expect(requiredHorizon(d, 86400)).toBe(200000);
  });
});
