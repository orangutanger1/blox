import { randomUUID } from 'node:crypto';
import type { FetchLike } from '../assets/scoutWeb.js';
import type { SnapGame, SnapPass, Snapshot } from './snapshot.js';

// Chart snapshot from Roblox's public JSON APIs (the ones roblox.com/charts
// uses). Deterministic, sequential, a few dozen requests; the agent never gets
// a general web fetch.

const UA = { 'User-Agent': 'blox-idea (+https://github.com/orangutanger1/blox)', Accept: 'application/json' };
const PASS_PAGES = 4;
const PASS_TOP = 40;
const BATCH = 50;

interface ChartGame {
  universeId: number; name: string; playerCount: number; totalUpVotes?: number; totalDownVotes?: number; isSponsored?: boolean; genreL1?: string;
}
interface Detail {
  id: number; description?: string; creator?: { name?: string }; visits?: number; maxPlayers?: number; created?: string; genre_l1?: string; genre_l2?: string;
}

async function getJson(fetch: FetchLike, url: string): Promise<unknown | null> {
  try {
    const r = await fetch(url, { headers: UA });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export async function gatherSnapshot(fetch: FetchLike, opts: { device: string; now: Date; sessionId?: string }): Promise<Snapshot> {
  const notes: string[] = [];
  const sid = opts.sessionId ?? randomUUID();
  const raw = (await getJson(fetch, `https://apis.roblox.com/explore-api/v1/get-sorts?sessionId=${sid}&device=${encodeURIComponent(opts.device)}&country=all`)) as
    | { sorts?: { sortId?: string; games?: ChartGame[] }[] }
    | null;
  if (!raw?.sorts) throw new Error('charts unavailable: explore-api get-sorts did not answer');

  const byId = new Map<number, SnapGame>();
  const sorts: string[] = [];
  for (const s of raw.sorts) {
    if (!s.sortId || !Array.isArray(s.games) || s.games.length === 0) continue;
    sorts.push(s.sortId);
    for (const g of s.games) {
      if (g.isSponsored) continue;
      const cur = byId.get(g.universeId);
      if (cur) {
        cur.ccu = Math.max(cur.ccu, g.playerCount ?? 0);
        if (!cur.sorts.includes(s.sortId)) cur.sorts.push(s.sortId);
        continue;
      }
      byId.set(g.universeId, {
        universeId: g.universeId, name: g.name, description: '', ccu: g.playerCount ?? 0,
        up: g.totalUpVotes ?? 0, down: g.totalDownVotes ?? 0, visits: 0, maxPlayers: 0, created: '',
        genre: g.genreL1 || 'Unknown', subgenre: '', creator: '', sorts: [s.sortId], passes: null,
      });
    }
  }
  const games = [...byId.values()].sort((a, b) => b.ccu - a.ccu);

  let detailFails = 0;
  for (let i = 0; i < games.length; i += BATCH) {
    const chunk = games.slice(i, i + BATCH);
    const d = (await getJson(fetch, `https://games.roblox.com/v1/games?universeIds=${chunk.map((g) => g.universeId).join(',')}`)) as { data?: Detail[] } | null;
    if (!d?.data) { detailFails++; continue; }
    for (const x of d.data) {
      const g = byId.get(x.id);
      if (!g) continue;
      g.description = x.description ?? '';
      g.creator = x.creator?.name ?? '';
      g.visits = x.visits ?? 0;
      g.maxPlayers = x.maxPlayers ?? 0;
      g.created = x.created ?? '';
      if (x.genre_l1) g.genre = x.genre_l1;
      g.subgenre = x.genre_l2 ?? '';
    }
  }
  if (detailFails) notes.push(`game details unavailable for ${detailFails} batch(es); those games have chart data only`);

  let passFails = 0;
  for (const g of games.slice(0, PASS_TOP)) {
    // Paged 50 at a time; big games list more. A failed later page keeps what came before.
    const all: { name?: string; isForSale?: boolean; price?: number | null }[] = [];
    let token = '';
    let ok = false;
    for (let page = 0; page < PASS_PAGES; page++) {
      const p = (await getJson(fetch, `https://apis.roblox.com/game-passes/v1/universes/${g.universeId}/game-passes?passView=Full&pageSize=50${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`)) as
        | { gamePasses?: { name?: string; isForSale?: boolean; price?: number | null }[]; nextPageToken?: string | null }
        | null;
      if (!p?.gamePasses) break;
      ok = true;
      all.push(...p.gamePasses);
      if (!p.nextPageToken) break;
      token = p.nextPageToken;
    }
    if (!ok) { passFails++; continue; }
    g.passes = all
      .filter((x) => x.isForSale && typeof x.price === 'number')
      .map((x): SnapPass => ({ name: x.name ?? '', price: x.price as number }));
  }
  if (passFails) notes.push(`game passes unavailable for ${passFails} game(s)`);

  return { version: 1, at: opts.now.toISOString(), date: opts.now.toISOString().slice(0, 10), device: opts.device, sorts, games, notes };
}
