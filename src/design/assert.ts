// src/design/assert.ts
import type { Assertion, DesignDoc } from './schema.js';
import type { Trace } from './sim.js';
import { fmtSeconds, metricValue, percentile, type MetricSpec } from './metrics.js';

export interface AssertionResult {
  id: string;
  ok: boolean;
  actual: number;
  detail: string;
}

const TIME_METRICS = new Set(['timeTo', 'maxIdleGap']);

function fmtValue(metric: string, v: number): string {
  if (TIME_METRICS.has(metric)) return fmtSeconds(v);
  if (!Number.isFinite(v)) return String(v);
  return Number(v.toPrecision(4)).toString();
}

function check(op: Assertion['op'], value: Assertion['value'], actual: number): boolean {
  if (Number.isNaN(actual)) return false;
  if (op === 'between') {
    const [lo, hi] = value as [number, number];
    return actual >= lo && actual <= hi;
  }
  return op === '<=' ? actual <= (value as number) : actual >= (value as number);
}

function spec(a: Assertion): MetricSpec {
  return { metric: a.metric === 'ratio' ? a.of! : a.metric, target: a.target, res: a.res, at: a.at, horizon: a.horizon, clock: a.clock };
}

export function evaluateAssertions(doc: DesignDoc, traces: Record<string, Trace[]>): AssertionResult[] {
  const out: AssertionResult[] = [];
  for (const a of doc.assertions) {
    const mine = traces[a.archetype];
    if (!mine?.length) continue;
    if (a.metric === 'ratio' && !traces[a.vs!]?.length) continue;
    const m = spec(a);
    const p = percentile(mine.map((t) => metricValue(t, m)), a.pct);
    let actual = p;
    let what = `${a.archetype} ${m.metric}${a.target ? ` ${a.target}` : ''}${a.res ? ` ${a.res}` : ''}${a.at !== undefined ? `@${a.at}` : ''}`;
    if (a.metric === 'ratio') {
      const q = percentile(traces[a.vs!].map((t) => metricValue(t, m)), a.pct);
      actual = q === 0 ? Infinity : p / q;
      what = `${a.archetype}/${a.vs} ${what.slice(a.archetype.length + 1)}`;
    }
    const shown = a.metric === 'ratio' ? fmtValue('ratio', actual) : fmtValue(m.metric, actual);
    const bound =
      a.op === 'between'
        ? `between ${(a.value as number[]).map((v) => (a.metric === 'ratio' ? fmtValue('ratio', v) : fmtValue(m.metric, v))).join('–')}`
        : `${a.op} ${a.metric === 'ratio' ? fmtValue('ratio', a.value as number) : fmtValue(m.metric, a.value as number)}`;
    out.push({ id: a.id, ok: check(a.op, a.value, actual), actual, detail: `${what} p${a.pct}=${shown} (${bound})` });
  }
  return out;
}

export function requiredProbes(doc: DesignDoc): number[] {
  const p = new Set<number>();
  for (const a of doc.assertions) {
    if ((a.metric === 'balanceAt' || a.of === 'balanceAt') && a.at !== undefined) p.add(a.at);
    if (a.horizon !== undefined) p.add(a.horizon);
  }
  return [...p];
}

export function requiredHorizon(doc: DesignDoc, base: number): number {
  return Math.max(base, ...requiredProbes(doc), ...doc.assertions.map((a) => (a.clock === 'wall' && a.at !== undefined ? a.at : 0)));
}
