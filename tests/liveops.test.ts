import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AnalyticsSchema, gradeAnalytics, fetchAnalytics } from '../src/liveops/analytics.js';
import { propose, applyChanges } from '../src/liveops/propose.js';
import { validateDesign, type DesignDoc } from '../src/design/schema.js';
import { OpenCloud, type FetchLike } from '../src/opencloud/client.js';

function example(name: string): DesignDoc {
  const v = validateDesign(JSON.parse(readFileSync(new URL(`../docs/examples/design/${name}.json`, import.meta.url), 'utf8')));
  if (!v.ok) throw new Error('x');
  return v.doc;
}

describe('gradeAnalytics', () => {
  it('bands metrics against benchmarks and orders findings, funnel first when steep', () => {
    const a = AnalyticsSchema.parse({
      retention: { d1: 0.08, d7: 0.03 },
      sessionLengthMin: 12,
      payerConversion: 0.02,
      funnel: [{ step: 1, name: 'spawn', users: 1000 }, { step: 2, name: 'first-step', users: 900 }, { step: 3, name: 'open-wall1', users: 400 }],
    });
    const g = gradeAnalytics(a);
    expect(g.grades.map((x) => [x.metric, x.band])).toEqual([['d1', '<p50'], ['d7', '>=p75'], ['sessionLengthMin', '>=p50'], ['payerConversion', '<p50']]);
    expect(g.findings.map((f) => f.id)).toEqual(['funnel:open-wall1', 'below:payerConversion', 'below:d1']);
    expect(g.findings[0].detail).toMatch(/56% of players drop before onboarding step "open-wall1"/);
  });
  it('rejects malformed exports', () => {
    expect(AnalyticsSchema.safeParse({ retention: { d1: 10.3 } }).success).toBe(false);
  });
});

describe('propose', () => {
  it('ftue: cheaper first purchase, simulator-checked, assertions kept', () => {
    const d = example('steal-tycoon');
    const ps = propose(d, { id: 'funnel:first-egg', metric: 'funnel', lever: 'ftue', severity: 1, detail: 'drop' }, { runs: 5 });
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps) {
      expect(p.target.after).toBeLessThan(p.target.before);
      expect(p.assertions.after).toBeGreaterThanOrEqual(p.assertions.before);
    }
    expect(ps.some((p) => /first purchase "egg1" cost/.test(p.description) || /rate/.test(p.description))).toBe(true);
  });
  it('never proposes monetization changes', () => {
    expect(propose(example('incremental'), { id: 'below:payerConversion', metric: 'payerConversion', lever: 'monetization', severity: 1, detail: 'x' })).toEqual([]);
  });
  it('applyChanges refuses stale proposals', () => {
    const d = example('incremental');
    const r = applyChanges(d, [{ path: 'economy.rebirth.needs.base', from: 1, to: 2 }]);
    expect(r.ok).toBe(false);
    const ok = applyChanges(d, [{ path: 'economy.rebirth.needs.base', from: d.economy.rebirth!.needs.base, to: 2000 }]);
    expect(ok.ok && ok.doc.economy.rebirth!.needs.base).toBe(2000);
  });
});

describe('fetchAnalytics (fake API)', () => {
  it('maps metric series into the export shape', async () => {
    const seen: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      const metric = JSON.parse(String(init?.body)).metric as string;
      seen.push(metric);
      const v = { D1Retention: 0.12, D7Retention: 0.02, AverageSessionLength: 11 }[metric];
      return { ok: true, status: 200, text: async () => JSON.stringify(v === undefined ? { values: [] } : { values: [{ value: 0 }, { value: v }] }) };
    };
    const a = await fetchAnalytics(new OpenCloud({ apiKey: 'k', fetch }), 99);
    expect(a.retention).toEqual({ d1: 0.12, d7: 0.02 });
    expect(a.sessionLengthMin).toBe(11);
    expect(seen).toContain('PayerConversionRate');
  });
});
