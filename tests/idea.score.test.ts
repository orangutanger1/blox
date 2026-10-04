import { describe, it, expect } from 'vitest';
import { validateIdeas, type Idea } from '../src/idea/idea.js';
import { FORMAT_FIT, rankIdeas, scoreIdea, WEIGHTS } from '../src/idea/score.js';
import { genreStats } from '../src/idea/stats.js';
import type { SnapGame, Snapshot } from '../src/idea/snapshot.js';

const g = (universeId: number, o: Partial<SnapGame> = {}): SnapGame => ({
  universeId, name: `Game ${universeId}`, description: '', ccu: 100, up: 90, down: 10, visits: 0, maxPlayers: 8,
  created: '2026-09-01T00:00:00Z', genre: 'Simulation', subgenre: 'Tycoon', creator: '', sorts: [], passes: null, ...o,
});
const snap: Snapshot = {
  version: 1, at: '2026-10-03T00:00:00Z', date: '2026-10-03', device: 'all', sorts: [], notes: [],
  games: [
    g(1, { ccu: 50000 }), g(2, { ccu: 40000 }),
    g(3, { ccu: 900000, genre: 'Strategy', subgenre: 'Tower Defense', created: '2020-01-01T00:00:00Z' }),
    g(4, { ccu: 1000, genre: 'Strategy', subgenre: 'Tower Defense', created: '2020-01-01T00:00:00Z' }),
  ],
};
const idea = (o: Partial<Idea> = {}): Record<string, unknown> => ({
  id: 'pet_steal', title: 'Steal a Pet', format: 'steal-tycoon', genre_l1: 'Simulation', genre_l2: 'Tycoon',
  theme: 'pets', hook: 'pets fight back', loop: ['hatch', 'steal', 'upgrade base'], monetization: [{ kind: 'pass', name: 'VIP', priceRobux: 399 }],
  cites: [1, 2], ...o,
});

describe('validateIdeas', () => {
  it('accepts an array or {ideas}', () => {
    const three = [idea(), idea({ id: 'b' }), idea({ id: 'c' })];
    expect(validateIdeas(three, snap).ok).toBe(true);
    expect(validateIdeas({ ideas: three }, snap).ok).toBe(true);
  });
  it('string ids: coerces cited ids', () => {
    const r = validateIdeas([idea({ cites: ['1', '2'] as unknown as number[] }), idea({ id: 'b' }), idea({ id: 'c' })], snap);
    expect(r.ok && r.ideas[0].cites).toEqual([1, 2]);
  });
  it('refuses citations not in the snapshot, listing them', () => {
    const r = validateIdeas([idea({ cites: [1, 77] }), idea({ id: 'b' }), idea({ id: 'c' })], snap);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join('\n')).toMatch(/pet_steal.*77/);
  });
  it('refuses a genre none of the cited games has', () => {
    const r = validateIdeas([idea({ genre_l1: 'Horror' }), idea({ id: 'b' }), idea({ id: 'c' })], snap);
    expect(!r.ok && r.errors.join('\n')).toMatch(/genre_l1 "Horror"/);
  });
  it('refuses fewer than 3, more than 6, duplicate ids, bad format', () => {
    expect(validateIdeas([idea(), idea({ id: 'b' })], snap).ok).toBe(false);
    expect(validateIdeas(Array.from({ length: 7 }, (_, i) => idea({ id: `i${i}` })), snap).ok).toBe(false);
    expect(validateIdeas([idea(), idea(), idea({ id: 'c' })], snap).ok).toBe(false);
    expect(validateIdeas([idea({ format: 'mmo' as Idea['format'] }), idea({ id: 'b' }), idea({ id: 'c' })], snap).ok).toBe(false);
  });
});

describe('score', () => {
  const stats = genreStats(snap);
  it('weights sum to 1 and fit table covers every format', () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(FORMAT_FIT['steal-tycoon']).toBe(1);
    expect(FORMAT_FIT.incremental).toBe(1);
    expect(FORMAT_FIT.round).toBe(0.6);
    expect(FORMAT_FIT.other).toBe(0.3);
  });
  it('parts: demand vs biggest genre, freshness, monopoly penalty, fit', () => {
    const v = validateIdeas([idea(), idea({ id: 'td', format: 'round', genre_l1: 'Strategy', genre_l2: 'Tower Defense', cites: [3, 4] }), idea({ id: 'c' })], snap);
    if (!v.ok) throw new Error(v.errors.join());
    const sim = scoreIdea(v.ideas[0], stats);
    const td = scoreIdea(v.ideas[1], stats);
    expect(sim.genreKey).toBe('Simulation/Tycoon');
    expect(td.parts.demand).toBe(1); // biggest genre
    expect(sim.parts.demand).toBeLessThan(1);
    expect(sim.parts.fresh).toBe(1);
    expect(td.parts.fresh).toBe(0);
    expect(td.parts.open).toBeLessThan(0.1); // one game owns ~99.9%
    expect(sim.parts.open).toBe(1); // top share 0.56 <= 0.6
    expect(sim.parts.fit).toBe(1);
    expect(sim.score).toBeGreaterThan(td.score);
    expect(sim.score).toBeLessThanOrEqual(100);
  });
  it('rankIdeas sorts by score, ties keep input order', () => {
    const v = validateIdeas([idea({ id: 'a', format: 'other' }), idea({ id: 'b' }), idea({ id: 'c' })], snap);
    if (!v.ok) throw new Error(v.errors.join());
    expect(rankIdeas(v.ideas, snap).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });
});
