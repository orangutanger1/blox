import type { DesignDoc } from '../design/schema.js';
import { simulate } from '../design/sim.js';
import { fmtSeconds } from '../design/metrics.js';

// Game-feel metrics from a real playtest: FTUE step timings and loop-soak
// health, evaluated deterministically from BloxTelemetry's dump (see
// kits/_common/files/src/ReplicatedStorage/BloxTelemetry.luau).

export interface TelemetrySample {
  t: number; // seconds since telemetry start
  memMb: number;
  stats: Record<string, Record<string, number>>; // userId → leaderstats name → value
}
export interface TelemetryDump {
  elapsed: number;
  players: Record<string, { joinedAt: number; steps: Record<string, number> }>; // steps: seconds since join
  events: { t: number; uid: string; name: string; value?: number }[]; // t: seconds since that player joined
  samples: TelemetrySample[];
}
export interface MetricResult {
  id: string;
  ok: boolean;
  actual: number | null;
  detail: string;
}
export interface MetricsReport {
  ranAt: string;
  mode: 'ftue' | 'soak';
  seconds: number;
  bot: string;
  results: MetricResult[];
  notes: string[];
  // the bot player's Telemetry events, oldest first: what happened when a check failed
  timeline?: TimelineEvent[];
}
export interface TimelineEvent {
  t: number;
  name: string;
  value?: number;
}

const obj = <T>(v: unknown): Record<string, T> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {});
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

// Luau's JSONEncode turns empty tables into [] — normalise to the declared shape.
export function normalizeDump(raw: unknown): TelemetryDump {
  const r = obj<unknown>(raw);
  const players: TelemetryDump['players'] = {};
  for (const [uid, p] of Object.entries(obj<{ joinedAt?: number; steps?: unknown }>(r.players))) {
    players[uid] = { joinedAt: Number(p.joinedAt ?? 0), steps: obj<number>(p.steps) };
  }
  return {
    elapsed: Number(r.elapsed ?? 0),
    players,
    events: arr<TelemetryDump['events'][number]>(r.events).map((e) => ({ ...e, uid: String(e.uid) })),
    samples: arr<TelemetrySample>(r.samples).map((s) => ({ t: s.t, memMb: s.memMb, stats: obj(s.stats) })),
  };
}

function firstPlayer(d: TelemetryDump): string | null {
  const ids = Object.keys(d.players).sort((a, b) => d.players[a].joinedAt - d.players[b].joinedAt);
  return ids[0] ?? null;
}

export const DEFAULT_BUDGETS = { firstCurrencySec: 60 };

export function evaluateFtue(d: TelemetryDump, doc: DesignDoc | null, budgets = DEFAULT_BUDGETS): MetricResult[] {
  const uid = firstPlayer(d);
  if (!uid) return [{ id: 'ftue:player', ok: false, actual: null, detail: 'no player joined during the playtest' }];
  const steps = d.players[uid].steps;
  const window = Math.max(0, d.elapsed - d.players[uid].joinedAt);
  const check = (id: string, target: number): MetricResult => {
    const t = steps[id];
    if (t === undefined) return { id: `ftue:${id}`, ok: false, actual: null, detail: `${id} never reached in ${fmtSeconds(window)} (target ${fmtSeconds(target)})` };
    return { id: `ftue:${id}`, ok: t <= target, actual: t, detail: `${id} at ${fmtSeconds(t)} (<= ${fmtSeconds(target)})` };
  };
  return [...(doc?.ftue ?? []).map((f) => check(f.id, f.targetSec)), check('auto:first-currency', budgets.firstCurrencySec)];
}

// Memory growth in MB/min: least squares over the second half of the samples
// (the first half absorbs load-time allocation). Null with fewer than 3 points.
export function memorySlope(samples: TelemetrySample[]): number | null {
  if (!samples.length) return null;
  const mid = (samples[0].t + samples[samples.length - 1].t) / 2;
  const pts = samples.filter((s) => s.t >= mid);
  if (pts.length < 3) return null;
  const n = pts.length;
  const mx = pts.reduce((a, s) => a + s.t, 0) / n;
  const my = pts.reduce((a, s) => a + s.memMb, 0) / n;
  let num = 0;
  let den = 0;
  for (const s of pts) {
    num += (s.t - mx) * (s.memMb - my);
    den += (s.t - mx) ** 2;
  }
  return den === 0 ? 0 : (num / den) * 60;
}

export interface SoakOptions {
  seconds: number;
  maxMemGrowthMbPerMin?: number;
  doc?: DesignDoc | null;
  archetype?: string;
  tolerance?: number;
  expect?: string[];
}

const PACE_SLACK = 15;

export function evaluateSoak(d: TelemetryDump, errorCount: number, o: SoakOptions): MetricResult[] {
  const out: MetricResult[] = [{ id: 'soak:errors', ok: errorCount === 0, actual: errorCount, detail: `${errorCount} runtime error(s)` }];
  const limit = o.maxMemGrowthMbPerMin ?? 10;
  const slope = memorySlope(d.samples);
  out.push(
    slope === null
      ? { id: 'soak:memory', ok: false, actual: null, detail: 'need >= 3 memory samples in the second half: soak >= 30s with BloxTelemetry running' }
      : { id: 'soak:memory', ok: slope <= limit, actual: slope, detail: `memory growth ${slope.toFixed(1)} MB/min (<= ${limit})` },
  );
  if (o.doc && o.archetype) {
    const tol = o.tolerance ?? 2;
    const sim = simulate(o.doc, { archetype: o.archetype, horizonSec: o.seconds, seed: 1 });
    const simFirst = new Map<string, number>();
    for (const e of sim.events) if (!simFirst.has(e.ref) && e.play <= o.seconds - PACE_SLACK) simFirst.set(e.ref, e.play);
    const uid = firstPlayer(d);
    const seen = new Map<string, number>();
    for (const e of d.events) if (e.uid === uid && !seen.has(e.name)) seen.set(e.name, e.t);
    const bad: string[] = [];
    for (const [ref, ts] of simFirst) {
      const to = seen.get(ref);
      if (to === undefined) bad.push(`${ref} never vs sim ${fmtSeconds(ts)}`);
      else if (to < ts / tol - PACE_SLACK || to > ts * tol + PACE_SLACK) bad.push(`${ref} at ${fmtSeconds(to)} vs sim ${fmtSeconds(ts)}`);
    }
    out.push({
      id: 'soak:pace',
      ok: bad.length === 0,
      actual: bad.length,
      detail: bad.length
        ? `${bad.length}/${simFirst.size} milestones off pace (×${tol} ±${PACE_SLACK}s): ${bad.slice(0, 5).join('; ')}`
        : `${simFirst.size} milestones within ×${tol} ±${PACE_SLACK}s of the ${o.archetype} simulation`,
    });
  }
  if (o.expect?.length) {
    const uid = firstPlayer(d);
    for (const name of o.expect) {
      const hit = d.events.find((e) => e.uid === uid && e.name === name);
      out.push(
        hit
          ? { id: `soak:expect:${name}`, ok: true, actual: hit.t, detail: `${name} at ${fmtSeconds(hit.t)}` }
          : { id: `soak:expect:${name}`, ok: false, actual: null, detail: `${name} never logged in ${fmtSeconds(o.seconds)}` },
      );
    }
  }
  return out;
}

export function playerTimeline(d: TelemetryDump, max = 300): TimelineEvent[] {
  const uid = firstPlayer(d);
  const mine = d.events.filter((e) => e.uid === uid).sort((a, b) => a.t - b.t);
  return mine.slice(-max).map((e) => (e.value === undefined ? { t: e.t, name: e.name } : { t: e.t, name: e.name, value: e.value }));
}

export function formatMetrics(r: MetricsReport): string {
  const pass = r.results.filter((x) => x.ok).length;
  const lines = [`metrics ${r.mode} (${r.seconds}s, bot ${r.bot}): ${pass}/${r.results.length} pass`];
  for (const x of r.results) lines.push(`  ${x.ok ? '✓' : '✗'} ${x.id}  ${x.detail}`);
  for (const n of r.notes) lines.push(`  note: ${n}`);
  const last = r.timeline?.at(-1);
  if (last) lines.push(`  timeline: ${r.timeline!.length} event(s), last ${last.name} at ${fmtSeconds(last.t)} (metrics-report.json timeline)`);
  return lines.join('\n');
}
