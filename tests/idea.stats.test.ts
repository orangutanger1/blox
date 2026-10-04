// tests/idea.stats.test.ts
import { describe, it, expect } from 'vitest';
import { genreStats, priceBand, quantile, statFor } from '../src/idea/stats.js';
import { normalizeName, themeCounts, themeDeltas } from '../src/idea/themes.js';
import type { SnapGame, Snapshot } from '../src/idea/snapshot.js';

const g = (universeId: number, o: Partial<SnapGame> = {}): SnapGame => ({
  universeId, name: `Game ${universeId}`, description: '', ccu: 100, up: 90, down: 10, visits: 0, maxPlayers: 8,
  created: '2025-01-01T00:00:00Z', genre: 'Simulation', subgenre: 'Tycoon', creator: '', sorts: ['top-trending'], passes: null, ...o,
});
const snap = (games: SnapGame[]): Snapshot => ({ version: 1, at: '2026-10-03T00:00:00Z', date: '2026-10-03', device: 'all', sorts: [], games, notes: [] });

describe('quantile / priceBand', () => {
  it('interpolates', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([5], 0.75)).toBe(5);
    expect(priceBand([])).toBeNull();
    expect(priceBand([100, 200, 300, 400, 500])).toEqual({ p25: 200, p50: 300, p75: 400 });
  });
});

describe('genreStats', () => {
  const s = snap([
    g(1, { ccu: 9000, created: '2026-08-01T00:00:00Z', passes: [{ name: 'VIP', price: 399 }, { name: '2x', price: 199 }] }),
    g(2, { ccu: 1000, passes: [] }),
    g(3, { ccu: 500, genre: 'Strategy', subgenre: 'Tower Defense', up: 50, down: 50 }),
  ]);
  const stats = genreStats(s);
  it('aggregates per genre and genre/subgenre, ccu desc', () => {
    expect(stats.map((x) => x.key)).toEqual(['Simulation', 'Simulation/Tycoon', 'Strategy', 'Strategy/Tower Defense']);
    const sim = stats[0];
    expect(sim.games).toBe(2);
    expect(sim.ccu).toBe(10000);
    expect(sim.medianCcu).toBe(5000);
    expect(sim.topShare).toBeCloseTo(0.9);
    expect(sim.fresh).toBe(0.5); // game 1 created within 180 days
    expect(sim.likeRatio).toBeCloseTo(0.9);
    expect(sim.medianPasses).toBe(1); // [2, 0]
    expect(sim.price).toEqual({ p25: 249, p50: 299, p75: 349 });
    expect(stats[2].medianPasses).toBeNull(); // passes never fetched
    expect(stats[2].price).toBeNull();
  });
  it('statFor prefers subgenre, case-insensitive, falls back to genre', () => {
    expect(statFor(stats, 'simulation', 'tycoon')!.key).toBe('Simulation/Tycoon');
    expect(statFor(stats, 'Simulation', 'Nope')!.key).toBe('Simulation');
    expect(statFor(stats, 'Horror')).toBeUndefined();
  });
});

describe('themes', () => {
  it('normalizes chart names', () => {
    expect(normalizeName('[⚡] Ride A Pet')).toBe('Ride A Pet');
    expect(normalizeName('Steal An Egg 🥚 [UPD]')).toBe('Steal An Egg');
    expect(normalizeName('Grow a Garden (x2 LUCK!)')).toBe('Grow a Garden');
    expect(normalizeName('🆕 UPDATE Pet Sim 99 NEW')).toBe('Pet Sim 99');
    expect(normalizeName('[🔥] 🥚🥚')).toBe('');
    expect(normalizeName('Mukbang Game [Testing')).toBe('Mukbang Game'); // unclosed tag
    expect(normalizeName('+1 Speed Keyboard Escape | Candy & Chocolate')).toBe('+1 Speed Keyboard Escape'); // subtitle after |
  });
  it('description words count only when some chart name uses them (filler like "welcome" is not a theme)', () => {
    const s = snap([
      g(1, { name: 'Steal An Egg', description: 'Welcome! Steal eggs from other players and earn cash', ccu: 999 }),
      g(2, { name: 'Egg Farm', description: 'Welcome to the farm, update soon', ccu: 99 }),
    ]);
    const terms = themeCounts(s).map((t) => t.term);
    expect(terms).toContain('egg');
    expect(terms).toContain('steal');
    expect(terms).not.toContain('welcome');
    expect(terms).not.toContain('earn');
    expect(terms).not.toContain('update');
    expect(themeCounts(s).find((t) => t.term === 'egg')!.games).toBe(2);
    const filler = themeCounts(snap([g(3, { name: 'Welcome Players: How To Make One Experience', description: 'welcome players' })])).map((t) => t.term);
    expect(filler.filter((t) => !t.includes(' '))).toEqual([]); // filler words are stopwords even in names
  });
  it('counts words and name bigrams once per game, weighted by log ccu', () => {
    const s = snap([
      g(1, { name: '[⚡] Ride A Pet', description: 'Hatch pets and ride them', ccu: 999 }),
      g(2, { name: 'Pet Simulator', description: 'collect every pet', ccu: 99 }),
      g(3, { name: '[🔥] 🥚🥚', ccu: 9 }),
    ]);
    const t = themeCounts(s);
    const pet = t.find((x) => x.term === 'pet')!;
    expect(pet.games).toBe(2);
    expect(pet.weight).toBeCloseTo(3 + 2, 5); // log10(1000) + log10(100)
    expect(t.find((x) => x.term === 'ride pet')).toBeDefined(); // bigram from name, stopword "a" dropped
    expect(t.find((x) => x.term === 'and')).toBeUndefined(); // stopword
    expect(t[0].term).toBe('pet'); // weight desc
  });
  it('deltas: rising first, new flagged, small changes hidden', () => {
    const d = themeDeltas(
      [{ term: 'steal', weight: 6, games: 3 }, { term: 'pet', weight: 5, games: 2 }, { term: 'obby', weight: 2, games: 1 }],
      [{ term: 'pet', weight: 5.2, games: 2 }, { term: 'obby', weight: 4, games: 2 }],
    );
    expect(d).toEqual([
      { term: 'steal', delta: 6, isNew: true },
      { term: 'obby', delta: -2, isNew: false },
    ]);
  });
});
