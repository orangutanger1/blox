import type { DesignDoc } from '../design/schema.js';
import { validateDesign } from '../design/schema.js';
import { runSimulation, type SimReport } from '../design/report.js';
import type { Finding, Lever } from './analytics.js';

// Turns a live-ops finding into design changes the simulator vouches for:
// deterministic variants of the numbers that move the lever, each simulated;
// a variant survives if every assertion that passed still passes and the
// lever's target metric improves. Monetization is never touched (human).

export interface Change {
  path: string;
  from: number;
  to: number;
}
export interface Proposal {
  id: string;
  finding: string;
  lever: Lever;
  description: string;
  changes: Change[];
  target: { metric: string; before: number; after: number; better: 'lower' | 'higher' };
  assertions: { before: number; after: number; total: number };
  applied?: string;
}

const round = (v: number) => Number(v.toPrecision(6));

export function getPath(o: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((x, k) => (x === null || x === undefined ? undefined : (x as Record<string, unknown>)[k]), o);
}
export function setPath(o: unknown, path: string, v: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = keys.reduce<unknown>((x, k) => (x as Record<string, unknown>)[k], o) as Record<string, unknown>;
  parent[last] = v;
}

interface Variant {
  description: string;
  changes: Change[];
}

function monetized(doc: DesignDoc): Set<string> {
  return new Set(doc.monetization.map((m) => m.effect.split(':')[1]));
}

function variants(doc: DesignDoc, lever: Lever): Variant[] {
  const out: Variant[] = [];
  const scale = (path: string, f: number, label: string, cap?: number) => {
    const from = getPath(doc, path);
    if (typeof from !== 'number') return;
    const to = round(cap !== undefined ? Math.min(cap, from * f) : from * f);
    if (to !== from) out.push({ description: label, changes: [{ path, from, to }] });
  };
  const paid = monetized(doc);
  const e = doc.economy;
  if (lever === 'ftue') {
    const items = [
      ...e.generators.map((g, i) => ({ id: g.id, base: g.cost.base, path: `economy.generators.${i}.cost.base` })),
      ...e.upgrades.map((u, i) => ({ id: u.id, base: u.cost.base, path: `economy.upgrades.${i}.cost.base` })),
      ...e.chance.map((c, i) => ({ id: c.id, base: c.cost.base, path: `economy.chance.${i}.cost.base` })),
    ].filter((x) => !paid.has(x.id));
    const first = items.sort((a, b) => a.base - b.base)[0];
    if (first) for (const f of [0.8, 0.6]) scale(first.path, f, `first purchase "${first.id}" cost ×${f}`);
    e.actions.forEach((a, i) => scale(`economy.actions.${i}.perSec`, 1.25, `action "${a.id}" rate ×1.25`));
  } else if (lever === 'offline') {
    if (e.offline) {
      scale('economy.offline.fraction', 1.25, 'offline earnings fraction ×1.25', 1);
      scale('economy.offline.capSec', 1.5, 'offline cap ×1.5');
    }
  } else if (lever === 'progression') {
    if (e.rebirth) for (const f of [0.85, 0.7]) scale('economy.rebirth.needs.base', f, `rebirth cost ×${f}`);
    e.generators.forEach((g, i) => {
      if (g.cost.growth > 1.05 && !paid.has(g.id)) out.push({ description: `generator "${g.id}" cost growth −0.02`, changes: [{ path: `economy.generators.${i}.cost.growth`, from: g.cost.growth, to: round(g.cost.growth - 0.02) }] });
    });
  }
  return out;
}

function target(doc: DesignDoc, rep: SimReport, lever: Lever): { metric: string; value: number; better: 'lower' | 'higher' } {
  const arch = doc.archetypes[0].id;
  const ms = rep.milestones[arch] ?? [];
  if (lever === 'ftue') return { metric: `${arch} first milestone p50 (s)`, value: ms[0]?.p50 ?? Infinity, better: 'lower' };
  if (lever === 'offline') {
    const casual = doc.archetypes[doc.archetypes.length - 1].id;
    return { metric: `${casual} milestones reached in the horizon`, value: (rep.milestones[casual] ?? []).filter((m) => Number.isFinite(m.p50)).length, better: 'higher' };
  }
  const rb = ms.find((m) => m.ref === 'rebirth');
  return rb ? { metric: `${arch} first rebirth p50 (s)`, value: rb.p50, better: 'lower' } : { metric: `${arch} milestones reached`, value: ms.filter((m) => Number.isFinite(m.p50)).length, better: 'higher' };
}

export function propose(doc: DesignDoc, finding: Finding, o: { runs?: number } = {}): Proposal[] {
  if (finding.lever === 'monetization') return [];
  const runs = o.runs ?? 10;
  const base = runSimulation(doc, { runs });
  const passing = new Set(base.assertions.filter((a) => a.ok).map((a) => a.id));
  const t0 = target(doc, base, finding.lever);
  const out: Proposal[] = [];
  variants(doc, finding.lever).forEach((v, i) => {
    const raw = structuredClone(doc) as unknown;
    for (const c of v.changes) setPath(raw, c.path, c.to);
    const valid = validateDesign(raw);
    if (!valid.ok) return;
    const rep = runSimulation(valid.doc, { runs });
    if ([...passing].some((id) => !rep.assertions.find((a) => a.id === id)?.ok)) return;
    const t1 = target(valid.doc, rep, finding.lever);
    const improved = t0.better === 'lower' ? t1.value < t0.value : t1.value > t0.value;
    if (!improved) return;
    out.push({
      id: `${finding.id.replace(/[^\w-]+/g, '-')}-${i + 1}`,
      finding: finding.detail,
      lever: finding.lever,
      description: v.description,
      changes: v.changes,
      target: { metric: t0.metric, before: t0.value, after: t1.value, better: t0.better },
      assertions: { before: passing.size, after: rep.assertions.filter((a) => a.ok).length, total: rep.assertions.length },
    });
  });
  const gain = (p: Proposal) => Math.abs(p.target.after - p.target.before) / Math.max(1e-9, Math.abs(p.target.before));
  return out.sort((a, b) => gain(b) - gain(a));
}

// Apply to a design (refuses if the numbers moved since the proposal was made).
export function applyChanges(doc: DesignDoc, changes: Change[]): { ok: true; doc: DesignDoc } | { ok: false; error: string } {
  const raw = structuredClone(doc) as unknown;
  for (const c of changes) {
    const cur = getPath(raw, c.path);
    if (cur !== c.from) return { ok: false, error: `stale proposal: ${c.path} is ${String(cur)}, expected ${c.from}` };
    setPath(raw, c.path, c.to);
  }
  const v = validateDesign(raw);
  return v.ok ? { ok: true, doc: v.doc } : { ok: false, error: v.errors.map((e) => `${e.path}: ${e.message}`).join('; ') };
}
