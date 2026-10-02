// tests/design.report.test.ts
import { describe, it, expect } from 'vitest';
import { validateDesign, type DesignDoc } from '../src/design/schema.js';
import { runSimulation, formatReport } from '../src/design/report.js';

function doc(extra: Record<string, unknown> = {}): DesignDoc {
  const r = validateDesign({
    version: 1,
    meta: { title: 'T', format: 'incremental' },
    economy: {
      resources: [{ id: 'cash' }],
      actions: [{ id: 'c', yields: { cash: 1 }, perSec: 1 }],
      generators: [{ id: 'g', produces: { cash: 1 }, cost: { res: 'cash', base: 10, growth: 1.2 } }],
      chance: [{ id: 'egg', cost: { res: 'cash', base: 50, growth: 1.1 }, outcomes: [{ id: 'c', weight: 9, grants: { 'income:cash': 0.5 } }, { id: 'r', weight: 1, grants: { 'income:cash': 5 } }] }],
      rebirth: { needs: { res: 'cash', base: 5000, growth: 2 }, mult: { target: '*', per: 1.5 }, resets: ['cash', 'generators', 'chance'] },
      offline: { fraction: 0.5, capSec: 28800 },
    },
    archetypes: [
      { id: 'active', session: { lengthSec: 1800, perDay: 2 }, policy: 'roi' },
      { id: 'casual', session: { lengthSec: 600, perDay: 1 }, policy: 'cheapest' },
    ],
    assertions: [
      { id: 'first-g', archetype: 'active', metric: 'timeTo', target: 'generator:g', op: '<=', value: 15 },
      { id: 'payer-gap', archetype: 'active', vs: 'casual', metric: 'ratio', of: 'timeTo', target: 'generator:g:5', op: '<=', value: 10 },
    ],
    ...extra,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.doc;
}

describe('runSimulation', () => {
  it('runs every archetype and evaluates assertions', () => {
    const r = runSimulation(doc(), { runs: 10 });
    expect(r.archetypes).toEqual(['active', 'casual']);
    expect(r.assertions.map((a) => a.id)).toEqual(['first-g', 'payer-gap']);
    expect(r.assertions[0].ok).toBe(true);
    expect(r.milestones.active[0]).toMatchObject({ ref: 'generator:g' });
    expect(r.curves.active.length).toBeGreaterThanOrEqual(48);
  });
  it('archetype filter skips assertions needing others', () => {
    const r = runSimulation(doc(), { runs: 5, archetypes: ['active'] });
    expect(r.assertions.map((a) => a.id)).toEqual(['first-g']);
  });
  it('rejects unknown archetype filters', () => {
    expect(() => runSimulation(doc(), { archetypes: ['nope'] })).toThrow(/unknown archetype/);
  });
  it('is deterministic for a seed', () => {
    const a = runSimulation(doc(), { runs: 5, seed: 9 });
    const b = runSimulation(doc(), { runs: 5, seed: 9 });
    expect({ ...a, ranAt: '' }).toEqual({ ...b, ranAt: '' });
  });
  it('50 runs x 7 days stays fast', () => {
    const t0 = Date.now();
    runSimulation(doc(), { runs: 50, horizonSec: 7 * 86400 });
    // ~0.7s alone; the full suite runs files in parallel and doubles+ it.
    // The limit catches an order-of-magnitude regression, not jitter.
    expect(Date.now() - t0).toBeLessThan(6000);
  });
});

describe('formatReport', () => {
  it('prints a pass/fail table and milestones', () => {
    const text = formatReport(runSimulation(doc(), { runs: 5 }));
    expect(text).toMatch(/^design sim: 5 runs × 1d, seed 1 — \d\/2 assertions pass/);
    expect(text).toMatch(/✓ first-g/);
    expect(text).toMatch(/active: generator:g/);
  });
});
