import { describe, it, expect } from 'vitest';
import { briefText, buildBrief } from '../src/idea/brief.js';
import { rankIdeas } from '../src/idea/score.js';
import { validateIdeas } from '../src/idea/idea.js';
import { DesignSchema } from '../src/design/schema.js';
import type { SnapGame, Snapshot } from '../src/idea/snapshot.js';

const g = (universeId: number, o: Partial<SnapGame> = {}): SnapGame => ({
  universeId, name: `[⚡] Game ${universeId}`, description: '', ccu: 1000 * universeId, up: 9, down: 1, visits: 5, maxPlayers: 8,
  created: '2026-09-01T00:00:00Z', genre: 'Simulation', subgenre: 'Tycoon', creator: '', sorts: [], passes: null, ...o,
});
const snap: Snapshot = {
  version: 1, at: '2026-10-03T00:00:00Z', date: '2026-10-03', device: 'all', sorts: [], notes: [],
  games: [
    g(1, { passes: [{ name: 'VIP', price: 400 }, { name: '2x', price: 200 }] }),
    g(2, { passes: [] }),
    g(3, { passes: [{ name: 'Big', price: 1000 }] }),
  ],
};
const base = { title: 'Steal a Pet', format: 'steal-tycoon', genre_l1: 'Simulation', genre_l2: 'Tycoon', theme: 'pets', hook: 'pets fight back', loop: ['hatch', 'steal', 'upgrade'], monetization: [{ kind: 'pass', name: 'VIP', priceRobux: 399 }, { kind: 'product', name: 'Coins pack' }], risks: ['crowded'] };
const v = validateIdeas([{ ...base, id: 'a', cites: [1, 2] }, { ...base, id: 'b', cites: [2, 2] }, { ...base, id: 'c', cites: [3, 1] }], snap);
if (!v.ok) throw new Error(v.errors.join());
const ranked = rankIdeas(v.ideas, snap);
const NOW = new Date('2026-10-03T13:00:00Z');

describe('buildBrief', () => {
  it('collects cited evidence and price anchors from cited passes', () => {
    const b = buildBrief(ranked.find((r) => r.id === 'a')!, snap, NOW);
    expect(b.version).toBe(1);
    expect(b.snapshot).toBe('2026-10-03');
    expect(b.evidence.map((e) => e.universeId)).toEqual([1, 2]);
    expect(b.evidence[0].name).toBe('Game 1'); // normalized
    expect(b.priceAnchors).toEqual({ p25: 250, p50: 300, p75: 350 });
    expect(b.priceSource).toBe('cited games');
    expect(b.openQuestions).toContain('crowded');
    expect(b.designHints).toEqual({ title: 'Steal a Pet', format: 'steal-tycoon', loop: ['hatch', 'steal', 'upgrade'], monetization: ['pass: VIP (399 R$)', 'product: Coins pack'] });
  });
  it('falls back to genre prices when cited games have no passes', () => {
    const b = buildBrief(ranked.find((r) => r.id === 'b')!, snap, NOW);
    expect(b.evidence).toHaveLength(1); // duplicate cite collapsed
    expect(b.priceSource).toBe('genre');
    expect(b.priceAnchors).toEqual({ p25: 300, p50: 400, p75: 700 });
  });
  it('designHints.format is a valid design.json meta.format', () => {
    const b = buildBrief(ranked[0], snap, NOW);
    expect(DesignSchema.shape.meta.shape.format.safeParse(b.designHints.format).success).toBe(true);
  });
  it('briefText names the idea, score and evidence', () => {
    const t = briefText(buildBrief(ranked.find((r) => r.id === 'a')!, snap, NOW));
    expect(t).toMatch(/Steal a Pet/);
    expect(t).toMatch(/Game 1/);
    expect(t).toMatch(/design \{action:"set"\}/);
  });
});
