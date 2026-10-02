// src/design/report.ts
import type { DesignDoc } from './schema.js';
import { simulate, SimError, type SimSample, type Trace } from './sim.js';
import { evaluateAssertions, requiredHorizon, requiredProbes, type AssertionResult } from './assert.js';
import { fmtSeconds, percentile } from './metrics.js';

export interface SimReport {
  ranAt: string;
  runs: number;
  seed: number;
  horizonSec: number;
  archetypes: string[];
  assertions: AssertionResult[];
  milestones: Record<string, { ref: string; p10: number; p50: number; p90: number }[]>;
  curves: Record<string, SimSample[]>;
}
export interface RunOptions {
  archetypes?: string[];
  horizonSec?: number;
  runs?: number;
  seed?: number;
}

const CURVE_POINTS = 48;
const MAX_MILESTONES = 30;

export function runSimulation(doc: DesignDoc, o: RunOptions = {}): SimReport {
  const runs = o.runs ?? 50;
  const seed = o.seed ?? 1;
  const H = requiredHorizon(doc, o.horizonSec ?? 86400);
  const ids = o.archetypes ?? doc.archetypes.map((a) => a.id);
  for (const id of ids) if (!doc.archetypes.some((a) => a.id === id)) throw new SimError(`unknown archetype "${id}"`);
  const grid = Array.from({ length: CURVE_POINTS + 1 }, (_, i) => Math.round((i * H) / CURVE_POINTS));
  const probes = [...new Set([...grid, ...requiredProbes(doc)])];
  // Without chance tables every run is identical — simulate once.
  const deterministic = doc.economy.chance.length === 0;
  const traces: Record<string, Trace[]> = {};
  for (const id of ids) {
    const list: Trace[] = [];
    for (let i = 0; i < runs; i++) {
      list.push(deterministic && i > 0 ? list[0] : simulate(doc, { archetype: id, horizonSec: H, seed: seed + i, probes }));
    }
    traces[id] = list;
  }
  const milestones: SimReport['milestones'] = {};
  const curves: SimReport['curves'] = {};
  for (const id of ids) {
    const list = traces[id];
    const refs: string[] = [];
    for (const e of list[0].events) if (!refs.includes(e.ref) && refs.length < MAX_MILESTONES) refs.push(e.ref);
    milestones[id] = refs.map((ref) => {
      const times = list.map((t) => t.events.find((e) => e.ref === ref)?.play ?? Infinity);
      return { ref, p10: percentile(times, 10), p50: percentile(times, 50), p90: percentile(times, 90) };
    });
    curves[id] = list[0].samples.filter((s) => grid.includes(s.t));
  }
  return { ranAt: new Date().toISOString(), runs, seed, horizonSec: H, archetypes: ids, assertions: evaluateAssertions(doc, traces), milestones, curves };
}

function fmtHorizon(s: number): string {
  return s % 86400 === 0 ? `${s / 86400}d` : fmtSeconds(s);
}

export function formatReport(r: SimReport): string {
  const pass = r.assertions.filter((a) => a.ok).length;
  const lines = [`design sim: ${r.runs} runs × ${fmtHorizon(r.horizonSec)}, seed ${r.seed} — ${pass}/${r.assertions.length} assertions pass`];
  for (const a of r.assertions) lines.push(`  ${a.ok ? '✓' : '✗'} ${a.id}  ${a.detail}`);
  lines.push('milestones (p50 play time):');
  for (const id of r.archetypes) {
    const ms = r.milestones[id].slice(0, 12).map((m) => `${m.ref} ${fmtSeconds(m.p50)}`);
    lines.push(`  ${id}: ${ms.join(' · ') || '(nothing happened)'}`);
  }
  return lines.join('\n');
}
