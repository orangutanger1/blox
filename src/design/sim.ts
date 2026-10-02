// src/design/sim.ts
import { parseRef, type Archetype, type DesignDoc } from './schema.js';

// Offline economy simulator. Rates are constant between events, so balances
// advance in closed form (linear, or exponential approach when drains apply)
// and the clock jumps straight to the next moment something can change
// (an item becomes affordable, a gate threshold, a session edge, a probe).
// mode 'tick' forces 1 s online steps; tests use it to prove skipping is exact.

export interface SimEvent {
  t: number;
  play: number;
  ref: string;
  n: number;
}
export interface SimSample {
  t: number;
  play: number;
  bal: Record<string, number>;
}
export interface Trace {
  archetype: string;
  seed: number;
  horizonSec: number;
  events: SimEvent[];
  samples: SimSample[];
  endPlay: number;
}
export interface SimOptions {
  archetype: string;
  horizonSec: number;
  seed: number;
  probes?: number[];
  mode?: 'skip' | 'tick';
}
export class SimError extends Error {}

export const MAX_STEPS = 2_000_000;
const EPS = 1e-9;
const ge = (a: number, b: number) => a >= b - EPS * Math.max(1, Math.abs(b));

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Seconds until balance b0 reaches target under income `rate` and proportional
// decay `decay` (per second). Infinity when it never does.
export function ttr(b0: number, target: number, rate: number, decay: number): number {
  if (ge(b0, target)) return 0;
  if (decay === 0) return rate > 0 ? (target - b0) / rate : Infinity;
  const eq = rate / decay;
  if (eq <= target) return Infinity;
  return Math.log((eq - b0) / (eq - target)) / decay;
}

type Kind = 'generator' | 'upgrade' | 'chance' | 'gate' | 'rebirth';
interface Item {
  ref: string;
  kind: Kind;
  id: string;
  cost: { res: string; base: number; growth: number };
  max: number;
  requires?: string;
  goal: boolean;
}
interface State {
  t: number;
  play: number;
  bal: Record<string, number>;
  owned: Record<string, number>;
  open: Set<string>;
  chanceIncome: Record<string, number>;
}

function buildItems(doc: DesignDoc): Item[] {
  const e = doc.economy;
  const items: Item[] = [];
  for (const g of e.generators) items.push({ ref: `generator:${g.id}`, kind: 'generator', id: g.id, cost: g.cost, max: g.max ?? Infinity, requires: g.requires, goal: false });
  for (const u of e.upgrades) items.push({ ref: `upgrade:${u.id}`, kind: 'upgrade', id: u.id, cost: u.cost, max: u.max, requires: u.requires, goal: false });
  for (const c of e.chance) items.push({ ref: `chance:${c.id}`, kind: 'chance', id: c.id, cost: c.cost, max: c.max ?? Infinity, requires: c.requires, goal: false });
  for (const g of e.gates)
    if (g.needs.consume)
      items.push({ ref: `gate:${g.id}`, kind: 'gate', id: g.id, cost: { res: g.needs.res, base: g.needs.amount, growth: 1 }, max: 1, requires: g.requires, goal: true });
  if (e.rebirth) items.push({ ref: 'rebirth', kind: 'rebirth', id: 'rebirth', cost: e.rebirth.needs, max: Infinity, goal: true });
  return items;
}

function requiresMet(s: State, ref: string | undefined): boolean {
  if (!ref) return true;
  const { kind, id, n } = parseRef(ref);
  if (kind === 'gate') return s.open.has(id);
  if (kind === 'rebirth') return (s.owned.rebirth ?? 0) >= Number(id);
  if (kind === 'action') return true;
  return (s.owned[`${kind}:${id}`] ?? 0) >= (n ?? 1);
}

const count = (s: State, i: Item) => s.owned[i.ref] ?? 0;
const costOf = (s: State, i: Item) => i.cost.base * Math.pow(i.cost.growth, count(s, i));
const available = (s: State, i: Item) => requiresMet(s, i.requires) && count(s, i) < i.max && !(i.kind === 'gate' && s.open.has(i.id));

function rates(doc: DesignDoc, s: State, online: boolean): Record<string, number> {
  const e = doc.economy;
  const base: Record<string, number> = {};
  for (const r of e.resources) base[r.id] = 0;
  if (online)
    for (const a of e.actions) if (requiresMet(s, a.requires)) for (const [r, v] of Object.entries(a.yields)) base[r] += v * a.perSec;
  for (const g of e.generators) {
    const n = s.owned[`generator:${g.id}`] ?? 0;
    if (n) for (const [r, v] of Object.entries(g.produces)) base[r] += v * n;
  }
  for (const u of e.upgrades) {
    const n = s.owned[`upgrade:${u.id}`] ?? 0;
    if (n && u.effect.add !== undefined) base[u.effect.target] += u.effect.add * n;
  }
  for (const [r, v] of Object.entries(s.chanceIncome)) base[r] += v;
  // Multipliers compose per resource; "*" applies to every resource.
  let all = 1;
  const mult: Record<string, number> = {};
  for (const u of e.upgrades) {
    const n = s.owned[`upgrade:${u.id}`] ?? 0;
    if (!n || u.effect.mult === undefined) continue;
    const f = Math.pow(u.effect.mult, n);
    if (u.effect.target === '*') all *= f;
    else mult[u.effect.target] = (mult[u.effect.target] ?? 1) * f;
  }
  const rb = e.rebirth;
  const rbf = rb ? Math.pow(rb.mult.per, s.owned.rebirth ?? 0) : 1;
  if (rb && rb.mult.target === '*') all *= rbf;
  else if (rb) mult[rb.mult.target] = (mult[rb.mult.target] ?? 1) * rbf;
  const out: Record<string, number> = {};
  for (const r of Object.keys(base)) out[r] = base[r] * all * (mult[r] ?? 1);
  return out;
}

function decays(doc: DesignDoc): Record<string, number> {
  const k: Record<string, number> = {};
  for (const r of doc.economy.resources) k[r.id] = 0;
  for (const d of doc.economy.drains) k[d.res] += d.fractionPerHour / 3600;
  return k;
}

function advance(s: State, dt: number, r: Record<string, number>, k: Record<string, number>): void {
  for (const id of Object.keys(s.bal)) {
    const b0 = s.bal[id];
    if (k[id] === 0) s.bal[id] = b0 + r[id] * dt;
    else {
      const eq = r[id] / k[id];
      s.bal[id] = eq + (b0 - eq) * Math.exp(-k[id] * dt);
    }
  }
}

function grantOwned(doc: DesignDoc, s: State, arch: Archetype): void {
  for (const m of doc.monetization) {
    if (!arch.owns.includes(m.id)) continue;
    const { kind, id } = parseRef(m.effect);
    if (kind !== 'upgrade') continue; // v1 simulates upgrade effects only
    const u = doc.economy.upgrades.find((x) => x.id === id)!;
    s.owned[`upgrade:${id}`] = u.max;
  }
}

function applyGrants(s: State, grants: Record<string, number>): void {
  for (const [g, v] of Object.entries(grants)) {
    const { kind, id } = parseRef(g);
    if (kind === 'income') s.chanceIncome[id] = (s.chanceIncome[id] ?? 0) + v;
    else s.bal[id] += v;
  }
}

function applyEffect(doc: DesignDoc, s: State, arch: Archetype, i: Item, roll: () => number): void {
  s.owned[i.ref] = count(s, i) + 1;
  if (i.kind === 'gate') s.open.add(i.id);
  if (i.kind === 'chance') {
    const c = doc.economy.chance.find((x) => x.id === i.id)!;
    const total = c.outcomes.reduce((a, o) => a + o.weight, 0);
    let x = roll() * total;
    const o = c.outcomes.find((o) => (x -= o.weight) < 0) ?? c.outcomes[c.outcomes.length - 1];
    applyGrants(s, o.grants);
  }
  if (i.kind === 'rebirth') {
    for (const r of doc.economy.rebirth!.resets) {
      const res = doc.economy.resources.find((x) => x.id === r);
      if (res) s.bal[r] = res.start;
      else if (r === 'gates') s.open.clear();
      else {
        const prefix = r === 'generators' ? 'generator:' : r === 'upgrades' ? 'upgrade:' : 'chance:';
        for (const key of Object.keys(s.owned)) if (key.startsWith(prefix)) delete s.owned[key];
        if (r === 'chance') s.chanceIncome = {};
      }
    }
    grantOwned(doc, s, arch);
  }
}

function payback(doc: DesignDoc, s: State, i: Item, now: Record<string, number>): number {
  // Rates after one more of a non-goal item: bump it in place (chance at its
  // expected income), read the rates, restore. Cheaper than cloning the state.
  const c = costOf(s, i);
  const income = s.chanceIncome;
  s.owned[i.ref] = count(s, i) + 1;
  if (i.kind === 'chance') {
    s.chanceIncome = { ...income };
    const ch = doc.economy.chance.find((x) => x.id === i.id)!;
    const total = ch.outcomes.reduce((a, o) => a + o.weight, 0);
    for (const o of ch.outcomes)
      for (const [g, v] of Object.entries(o.grants)) {
        const { kind, id } = parseRef(g);
        if (kind === 'income') s.chanceIncome[id] = (s.chanceIncome[id] ?? 0) + (v * o.weight) / total;
      }
  }
  const next = rates(doc, s, true);
  s.owned[i.ref] -= 1;
  if (!s.owned[i.ref]) delete s.owned[i.ref];
  s.chanceIncome = income;
  const res = i.cost.res;
  const d = next[res] - now[res];
  if (d > EPS) return c / d;
  let rel = 0;
  for (const r of Object.keys(next)) {
    const dd = next[r] - now[r];
    if (dd > EPS) rel += now[r] > 0 ? dd / now[r] : 1;
  }
  return rel > 0 && now[res] > 0 ? c / (now[res] * rel) : Infinity;
}

function choose(doc: DesignDoc, s: State, arch: Archetype, items: Item[], r: Record<string, number>, k: Record<string, number>): Item | null {
  const avail = items.filter((i) => available(s, i));
  const affordable = avail.filter((i) => ge(s.bal[i.cost.res], costOf(s, i)));
  const cheapest = () => affordable.sort((a, b) => costOf(s, a) - costOf(s, b) || (a.ref < b.ref ? -1 : 1))[0] ?? null;
  if (arch.policy === 'cheapest') return cheapest();
  const goalWeight = arch.policy === 'saver' ? 0.5 : 1;
  let best: Item | null = null;
  let bestScore = Infinity;
  for (const i of avail) {
    const t = ttr(s.bal[i.cost.res], costOf(s, i), r[i.cost.res], k[i.cost.res]);
    if (!i.goal && t >= bestScore) continue; // payback >= 0, so it cannot win
    const score = i.goal ? t * goalWeight : t + payback(doc, s, i, r);
    if (score < bestScore) {
      best = i;
      bestScore = score;
    }
  }
  if (!best) return cheapest(); // nothing scores finite: fall back to cheapest affordable
  return affordable.includes(best) ? best : null; // otherwise save for the best item
}

export function simulate(doc: DesignDoc, opts: SimOptions): Trace {
  const arch = doc.archetypes.find((a) => a.id === opts.archetype);
  if (!arch) throw new SimError(`unknown archetype "${opts.archetype}"`);
  const H = opts.horizonSec;
  const roll = mulberry32(opts.seed);
  const items = buildItems(doc);
  const k = decays(doc);
  const zero: Record<string, number> = Object.fromEntries(doc.economy.resources.map((r) => [r.id, 0]));
  const s: State = { t: 0, play: 0, bal: Object.fromEntries(doc.economy.resources.map((r) => [r.id, r.start])), owned: {}, open: new Set(), chanceIncome: {} };
  grantOwned(doc, s, arch);
  const autoGates = doc.economy.gates.filter((g) => !g.needs.consume);
  const period = Math.floor(86400 / arch.session.perDay);
  const len = arch.session.lengthSec;
  const probes = [...new Set(opts.probes ?? [])].filter((p) => p >= 0 && p <= H).sort((a, b) => a - b);
  let pi = 0;
  const events: SimEvent[] = [];
  const samples: SimSample[] = [];
  let steps = 0;
  let last = 'start';
  const bump = () => {
    if (++steps > MAX_STEPS) throw new SimError(`runaway economy: over ${MAX_STEPS} steps (last: ${last})`);
  };
  const openGates = () => {
    for (const g of autoGates)
      if (!s.open.has(g.id) && requiresMet(s, g.requires) && ge(s.bal[g.needs.res], g.needs.amount)) {
        s.open.add(g.id);
        events.push({ t: s.t, play: s.play, ref: `gate:${g.id}`, n: 1 });
      }
  };

  for (;;) {
    while (pi < probes.length && probes[pi] <= s.t) {
      samples.push({ t: s.t, play: s.play, bal: { ...s.bal } });
      pi++;
    }
    if (s.t >= H) break;
    const dayPos = s.t % period;
    const online = dayPos < len;
    const edge = s.t - dayPos + (online ? len : period);
    const bound = Math.min(edge, H, pi < probes.length ? probes[pi] : Infinity) - s.t;
    let dt: number;
    if (online) {
      openGates();
      for (;;) {
        const r = rates(doc, s, true);
        const it = choose(doc, s, arch, items, r, k);
        if (!it) break;
        s.bal[it.cost.res] -= costOf(s, it);
        applyEffect(doc, s, arch, it, roll);
        events.push({ t: s.t, play: s.play, ref: it.ref, n: s.owned[it.ref] });
        last = it.ref;
        bump();
        openGates();
      }
      const r = rates(doc, s, true);
      let need = Infinity;
      for (const i of items) if (available(s, i)) need = Math.min(need, ttr(s.bal[i.cost.res], costOf(s, i), r[i.cost.res], k[i.cost.res]) || Infinity);
      for (const g of autoGates)
        if (!s.open.has(g.id) && requiresMet(s, g.requires)) need = Math.min(need, ttr(s.bal[g.needs.res], g.needs.amount, r[g.needs.res], k[g.needs.res]) || Infinity);
      dt = Math.min(opts.mode === 'tick' ? 1 : Math.max(1, Math.ceil(need)), bound);
      advance(s, dt, r, k);
      s.play += dt;
    } else {
      const capEnd = s.t - dayPos + len + (doc.economy.offline?.capSec ?? 0);
      if (doc.economy.offline && s.t < capEnd) {
        const f = doc.economy.offline.fraction;
        const r = Object.fromEntries(Object.entries(rates(doc, s, false)).map(([id, v]) => [id, v * f]));
        dt = Math.min(bound, capEnd - s.t);
        advance(s, dt, r, k);
      } else {
        dt = bound;
        advance(s, dt, zero, k);
      }
    }
    s.t += dt;
    bump();
    for (const [id, v] of Object.entries(s.bal)) if (!Number.isFinite(v)) throw new SimError(`balance of "${id}" became ${v} (last: ${last})`);
  }
  return { archetype: arch.id, seed: opts.seed, horizonSec: H, events, samples, endPlay: s.play };
}
