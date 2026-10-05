import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherSnapshot } from '../src/idea/fetch.js';
import { latestSnapshot, listSnapshots, loadSnapshot, previousSnapshot, saveSnapshot, type Snapshot } from '../src/idea/snapshot.js';
import { fakeFetch, WEB } from './helpers/ideaWeb.js';

const chartGame = (universeId: number, name: string, playerCount: number) => ({
  universeId, rootPlaceId: universeId + 1, name, playerCount, totalUpVotes: 900, totalDownVotes: 100, isSponsored: false, genreL1: 'Simulation',
});
const NOW = new Date('2026-10-03T12:00:00Z');

describe('gatherSnapshot', () => {
  it('merges sorts, drops sponsored, fills details and passes', async () => {
    const seen: string[] = [];
    const s = await gatherSnapshot(fakeFetch(WEB, seen), { device: 'all', now: NOW, sessionId: 'sid' });
    expect(s.version).toBe(1);
    expect(s.date).toBe('2026-10-03');
    expect(s.sorts).toEqual(['top-trending', 'up-and-coming']);
    expect(s.games.map((g) => g.universeId)).toEqual([2, 1, 3]); // ccu desc, 9 dropped
    const egg = s.games[0];
    expect(egg.ccu).toBe(9100); // max across sorts
    expect(egg.sorts).toEqual(['top-trending', 'up-and-coming']);
    expect(egg.name).toBe('Steal An Egg'); // chart name kept
    expect(egg.description).toBe('desc 2');
    expect(egg.subgenre).toBe('Tycoon');
    expect(egg.passes).toEqual([{ name: 'VIP', price: 399 }]); // not-for-sale dropped
    expect(s.games[2].genre).toBe('Strategy'); // details fill empty chart genre
    expect(seen[0]).toContain('sessionId=sid&device=all&country=all');
    expect(s.notes).toEqual([]);
  });
  it('details failure: keeps chart data, genre Unknown when chart genre empty, notes it', async () => {
    const web = { ...WEB };
    delete web['https://games.roblox.com/v1/games?universeIds='];
    const s = await gatherSnapshot(fakeFetch(web), { device: 'all', now: NOW, sessionId: 'sid' });
    expect(s.games).toHaveLength(3);
    expect(s.games.find((g) => g.universeId === 3)!.genre).toBe('Unknown');
    expect(s.games[0].description).toBe('');
    expect(s.notes.join(' ')).toMatch(/details/);
  });
  it('passes failure: passes null and a note', async () => {
    const web = { ...WEB };
    delete web['https://apis.roblox.com/game-passes/v1/universes/'];
    const s = await gatherSnapshot(fakeFetch(web), { device: 'all', now: NOW, sessionId: 'sid' });
    expect(s.games.every((g) => g.passes === null)).toBe(true);
    expect(s.notes.join(' ')).toMatch(/passes/);
  });
  it('pages game passes via nextPageToken (capped), keeping earlier pages if a later one fails', async () => {
    const pass = (n: number) => ({ name: `P${n}`, isForSale: true, price: n });
    const seen: string[] = [];
    const web = {
      ...WEB,
      'https://apis.roblox.com/game-passes/v1/universes/': (u: string) => {
        if (u.includes('pageToken=t2')) return null; // page 3 fails
        if (u.includes('pageToken=t1')) return { gamePasses: [pass(2)], nextPageToken: 't2' };
        return { gamePasses: [pass(1)], nextPageToken: 't1' };
      },
    };
    const s = await gatherSnapshot(fakeFetch(web, seen), { device: 'all', now: NOW, sessionId: 'sid' });
    expect(s.games[0].passes).toEqual([{ name: 'P1', price: 1 }, { name: 'P2', price: 2 }]);
    expect(s.notes).toEqual([]);
    const endless = { ...WEB, 'https://apis.roblox.com/game-passes/v1/universes/': () => ({ gamePasses: [pass(1)], nextPageToken: 'more' }) };
    const seen2: string[] = [];
    await gatherSnapshot(fakeFetch(endless, seen2), { device: 'all', now: NOW, sessionId: 'sid' });
    expect(seen2.filter((u) => u.includes('/game-passes')).length).toBe(3 * 4); // 3 games × 4-page cap
  });
  it('charts failure is a hard error', async () => {
    await expect(gatherSnapshot(fakeFetch({}), { device: 'all', now: NOW })).rejects.toThrow(/charts unavailable/);
  });
  it('fetches passes for the top 40 by ccu only, sequentially batched details by 50', async () => {
    const many = Array.from({ length: 60 }, (_, i) => chartGame(100 + i, `Game ${i}`, 1000 - i));
    const seen: string[] = [];
    await gatherSnapshot(fakeFetch({ ...WEB, 'https://apis.roblox.com/explore-api/v1/get-sorts': { sorts: [{ sortId: 'top-playing-now', games: many }] } }, seen), { device: 'all', now: NOW });
    expect(seen.filter((u) => u.includes('universeIds=')).length).toBe(2);
    expect(seen.filter((u) => u.includes('/game-passes')).length).toBe(40);
  });
});

describe('snapshot storage', () => {
  it('saves by date and finds latest/previous', () => {
    const P = mkdtempSync(join(tmpdir(), 'idea-'));
    const mk = (date: string): Snapshot => ({ version: 1, at: `${date}T00:00:00Z`, date, device: 'all', sorts: [], games: [], notes: [] });
    expect(latestSnapshot(P)).toBeNull();
    expect(saveSnapshot(P, mk('2026-10-01'))).toBe(join('.blox', 'research', '2026-10-01.json'));
    saveSnapshot(P, mk('2026-10-03'));
    expect(listSnapshots(P)).toEqual(['2026-10-01', '2026-10-03']);
    expect(latestSnapshot(P)!.date).toBe('2026-10-03');
    expect(previousSnapshot(P, '2026-10-03')!.date).toBe('2026-10-01');
    expect(previousSnapshot(P, '2026-10-01')).toBeNull();
    expect(loadSnapshot(P, '2026-09-01')).toBeNull();
  });
});
