import { describe, it, expect } from 'vitest';
import { rates, type SimState } from '../src/design/sim.js';
import { LUNE_DIR, luneBin, runLune } from './helpers/lune.js';
import { kitDesign, kitProject } from './helpers/kit.js';

// The kit's runtime economy must be the simulator's economy: same rates, same
// costs, same closed-form advance — so simulated pacing is shipped pacing.

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

describe.skipIf(!luneBin())('kit economy ↔ simulator parity', () => {
  it('rates, costs and hour-long advance match on scripted states', () => {
    const doc = kitDesign();
    const start = Object.fromEntries(doc.economy.resources.map((r) => [r.id, r.start]));
    const states: (Omit<SimState, 'open' | 't' | 'play'> & { open: Record<string, boolean> })[] = [
      { bal: { ...start }, owned: {}, open: {}, chanceIncome: {} },
      { bal: { ...start, wins: 50 }, owned: { 'generator:pet': 7 }, open: { wall1: true }, chanceIncome: {} },
      { bal: { wins: 1234.5, speed: 900 }, owned: { 'generator:pet': 25, 'upgrade:shoes': 3, rebirth: 2 }, open: { wall1: true, wall2: true }, chanceIncome: {} },
      { bal: { wins: 9, speed: 20000 }, owned: { 'generator:pet': 40, 'upgrade:shoes': 10, 'upgrade:speed2x': 1, rebirth: 5 }, open: { wall1: true, wall2: true, wall3: true }, chanceIncome: { wins: 3.5 } },
    ];
    const lua = JSON.parse(runLune(`${LUNE_DIR}parity.luau`, [kitProject()], JSON.stringify(states)).trim()) as {
      online: Record<string, number>;
      offline: Record<string, number>;
      costs: Record<string, number>;
      after: Record<string, number>;
    }[];
    expect(lua).toHaveLength(states.length);
    states.forEach((st, i) => {
      const s: SimState = { t: 0, play: 0, bal: { ...st.bal }, owned: st.owned, open: new Set(Object.keys(st.open)), chanceIncome: st.chanceIncome };
      for (const online of [true, false]) {
        const ts = rates(doc, s, online);
        const lu = lua[i][online ? 'online' : 'offline'];
        for (const r of Object.keys(ts)) expect(close(lu[r] ?? 0, ts[r]), `state ${i} ${online ? 'on' : 'off'}line ${r}: luau ${lu[r]} vs sim ${ts[r]}`).toBe(true);
      }
      const items = [
        ...doc.economy.generators.map((g) => [`generator:${g.id}`, g.cost] as const),
        ...doc.economy.upgrades.map((u) => [`upgrade:${u.id}`, u.cost] as const),
        ['rebirth', doc.economy.rebirth!.needs] as const,
      ];
      for (const [ref, c] of items) expect(close(lua[i].costs[ref], c.base * Math.pow(c.growth, st.owned[ref] ?? 0)), `cost ${ref}`).toBe(true);
      // closed-form advance (no drains in this design → linear)
      const r = rates(doc, s, true);
      for (const res of Object.keys(st.bal)) expect(close(lua[i].after[res], st.bal[res] + r[res] * 3600), `advance ${res}`).toBe(true);
    });
  });
});
