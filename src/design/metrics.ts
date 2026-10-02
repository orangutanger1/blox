// src/design/metrics.ts
import { parseRef } from './schema.js';
import type { SimEvent, Trace } from './sim.js';

export type MetricSpec = {
  metric: 'timeTo' | 'countAt' | 'balanceAt' | 'maxIdleGap';
  target?: string;
  res?: string;
  at?: number;
  horizon?: number;
  clock: 'play' | 'wall';
};

export function percentile(values: number[], pct: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[idx];
}

function matcher(target: string, withCount: boolean): (e: SimEvent) => boolean {
  const { kind, id, n } = parseRef(target);
  if (kind === 'rebirth') {
    const need = withCount ? Number(id) : 1;
    return (e) => e.ref === 'rebirth' && e.n >= need;
  }
  const ref = `${kind}:${id}`;
  const need = withCount ? n ?? 1 : 1;
  return (e) => e.ref === ref && e.n >= need;
}

const at = (e: SimEvent, clock: 'play' | 'wall') => (clock === 'wall' ? e.t : e.play);

export function metricValue(tr: Trace, m: MetricSpec): number {
  switch (m.metric) {
    case 'timeTo': {
      const e = tr.events.find(matcher(m.target!, true));
      return e ? at(e, m.clock) : Infinity;
    }
    case 'countAt': {
      const match = matcher(m.target!, false);
      return tr.events.filter((e) => match(e) && at(e, m.clock) <= m.at!).length;
    }
    case 'balanceAt': {
      const s = tr.samples.find((x) => x.t === m.at);
      return s ? s.bal[m.res!] ?? NaN : NaN;
    }
    case 'maxIdleGap': {
      let end = tr.endPlay;
      let events = tr.events;
      if (m.horizon !== undefined) {
        const s = tr.samples.find((x) => x.t === m.horizon);
        if (s) end = s.play;
        events = events.filter((e) => e.t <= m.horizon!);
      }
      let prev = 0;
      let gap = 0;
      for (const e of events) {
        gap = Math.max(gap, e.play - prev);
        prev = e.play;
      }
      return Math.max(gap, end - prev);
    }
  }
}

export function fmtSeconds(s: number): string {
  if (!Number.isFinite(s)) return 'never (within horizon)';
  const r = Math.round(s);
  if (r < 60) return `${r}s`;
  if (r < 3600) return `${Math.floor(r / 60)}m${String(r % 60).padStart(2, '0')}s`;
  return `${Math.floor(r / 3600)}h${String(Math.floor((r % 3600) / 60)).padStart(2, '0')}m`;
}
