# Idea Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An `idea` tool (agent + CLI) that snapshots the Roblox charts, computes genre/theme stats, scores agent-proposed ideas that must cite snapshot games, and writes `.blox/brief.json` for the picked idea.

**Architecture:** `src/idea/` holds one fetcher (injected `FetchLike`, public Roblox JSON APIs only) and pure modules (stats, themes, fit, score, idea validation, brief). `src/idea/tool.ts` is the tool handler, registered in `src/tools/registry.ts` like `scout`, mapped in `src/cliTools.ts`.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), zod, vitest. Run tests with `npx vitest run <file>`; typecheck with `npx tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-10-03-idea-research-design.md`

## Global Constraints

- Endpoints, exactly: `https://apis.roblox.com/explore-api/v1/get-sorts?sessionId=<uuid>&device=<device>&country=all`, `https://games.roblox.com/v1/games?universeIds=<csv ≤50>`, `https://apis.roblox.com/game-passes/v1/universes/<id>/game-passes?passView=Full&pageSize=50`. No other hosts, no HTML scraping, no YouTube, no third-party trackers.
- Requests sequential (no `Promise.all` over HTTP). Passes for the top 40 games by CCU only.
- User-Agent header `blox-idea (+https://github.com/orangutanger1/blox)`, `Accept: application/json`.
- Sponsored chart entries (`isSponsored: true`) are dropped.
- Snapshot path `.blox/research/<YYYY-MM-DD>.json`; reused for the same date + device unless `fresh`.
- Ideas: 3–6 per propose; each cites ≥2 universeIds present in the latest snapshot; `format` is the design.json meta.format enum `incremental | steal-tycoon | round | survival | collection | battlegrounds | other`.
- `brief` never writes `.blox/design.json`.
- No embeddings, no new dependencies.
- Agent guide budget: raise `tests/agentGuide.test.ts` limit from 5800 to 6000 (guide is at 5799 today).

## Review Focus

1. Chart game with empty `genreL1` and details call failing → game must still appear with genre `Unknown`, not crash or vanish. (Task 1 test "details failure".)
2. Agent cites ids as strings (`"10035204815"`) instead of numbers → accepted (coerced), not refused as unknown. (Task 3 test "string ids".)
3. `propose` before any `research` → clear error telling to run research first. (Task 5 test.)
4. `brief` with an unknown idea id → error listing known ids. (Task 5 test.)
5. Game names that are only emoji/tags (e.g. `"[🔥] 🥚🥚"`) → normalize to empty string and contribute no theme terms, no crash. (Task 2 test.)

---

### Task 1: Snapshot fetch + storage

**Files:**
- Create: `src/idea/snapshot.ts`
- Create: `src/idea/fetch.ts`
- Create: `tests/helpers/ideaWeb.ts` (fake fetch + chart fixtures, shared with Task 5 — never import one test file from another, vitest would register its tests twice)
- Test: `tests/idea.fetch.test.ts`

**Interfaces:**
- Consumes: `FetchLike` from `src/assets/scoutWeb.ts` (`(url, init?) => Promise<{ok, status, json()}>`).
- Produces:
  - `interface SnapPass { name: string; price: number }`
  - `interface SnapGame { universeId: number; name: string; description: string; ccu: number; up: number; down: number; visits: number; maxPlayers: number; created: string; genre: string; subgenre: string; creator: string; sorts: string[]; passes: SnapPass[] | null }`
  - `interface Snapshot { version: 1; at: string; date: string; device: string; sorts: string[]; games: SnapGame[]; notes: string[] }`
  - `gatherSnapshot(fetch: FetchLike, opts: { device: string; now: Date; sessionId?: string }): Promise<Snapshot>` (throws `Error('charts unavailable: …')` when get-sorts fails)
  - `saveSnapshot(projectPath: string, s: Snapshot): string` (returns project-relative path)
  - `listSnapshots(projectPath: string): string[]` (dates ascending)
  - `loadSnapshot(projectPath: string, date: string): Snapshot | null`
  - `latestSnapshot(projectPath: string): Snapshot | null`
  - `previousSnapshot(projectPath: string, date: string): Snapshot | null` (newest with date < given)

- [ ] **Step 1: Write the failing test**

```ts
// tests/helpers/ideaWeb.ts
export type Web = Record<string, unknown | ((url: string) => unknown)>;
export function fakeFetch(web: Web, seen: string[] = []) {
  return async (url: string) => {
    seen.push(url);
    const key = Object.keys(web).find((k) => url.startsWith(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    const v = typeof web[key] === 'function' ? (web[key] as (u: string) => unknown)(url) : web[key];
    return { ok: true, status: 200, json: async () => v };
  };
}

const chartGame = (universeId: number, name: string, playerCount: number, extra: Record<string, unknown> = {}) => ({
  universeId, rootPlaceId: universeId + 1, name, playerCount, totalUpVotes: 900, totalDownVotes: 100, isSponsored: false, genreL1: 'Simulation', ...extra,
});
export const SORTS = {
  sorts: [
    { sortId: 'filters_v5', sortDisplayName: '' },
    { sortId: 'top-trending', games: [chartGame(1, '[⚡] Ride A Pet', 5000), chartGame(2, 'Steal An Egg', 9000), chartGame(9, 'Ad Game', 1, { isSponsored: true })] },
    { sortId: 'up-and-coming', games: [chartGame(2, 'Steal An Egg', 9100), chartGame(3, 'Tower Thing', 300, { genreL1: '' })] },
  ],
};
const detail = (id: number, extra: Record<string, unknown> = {}) => ({
  id, name: `G${id}`, description: `desc ${id}`, creator: { name: 'Maker', type: 'Group' }, playing: 1, visits: id * 1000, maxPlayers: 8,
  created: '2026-08-01T00:00:00Z', updated: '2026-10-01T00:00:00Z', genre_l1: 'Simulation', genre_l2: 'Tycoon', ...extra,
});
export const WEB: Web = {
  'https://apis.roblox.com/explore-api/v1/get-sorts': SORTS,
  'https://games.roblox.com/v1/games?universeIds=': (u: string) => ({
    data: new URL(u).searchParams.get('universeIds')!.split(',').map(Number).map((id) => detail(id, id === 3 ? { genre_l1: 'Strategy', genre_l2: 'Tower Defense' } : {})),
  }),
  'https://apis.roblox.com/game-passes/v1/universes/': {
    gamePasses: [
      { id: 1, name: 'VIP', isForSale: true, price: 399 },
      { id: 2, name: 'Old', isForSale: false, price: null },
    ],
  },
};
```

```ts
// tests/idea.fetch.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/idea.fetch.test.ts`
Expected: FAIL — cannot resolve `../src/idea/fetch.js`.

- [ ] **Step 3: Implement `src/idea/snapshot.ts`**

```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// .blox/research/<date>.json — one chart snapshot per day (and device). Facts
// only: what the public Roblox APIs said; stats and themes are derived on read.

export interface SnapPass { name: string; price: number }
export interface SnapGame {
  universeId: number;
  name: string;
  description: string;
  ccu: number;
  up: number;
  down: number;
  visits: number;
  maxPlayers: number;
  created: string;
  genre: string;
  subgenre: string;
  creator: string;
  sorts: string[];
  passes: SnapPass[] | null; // null = not fetched (outside top 40 or the call failed)
}
export interface Snapshot {
  version: 1;
  at: string;
  date: string;
  device: string;
  sorts: string[];
  games: SnapGame[];
  notes: string[];
}

const dir = (P: string) => join(P, '.blox', 'research');

export function saveSnapshot(projectPath: string, s: Snapshot): string {
  mkdirSync(dir(projectPath), { recursive: true });
  const f = join(dir(projectPath), `${s.date}.json`);
  writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 2));
  renameSync(`${f}.tmp`, f);
  return join('.blox', 'research', `${s.date}.json`);
}

export function listSnapshots(projectPath: string): string[] {
  if (!existsSync(dir(projectPath))) return [];
  return readdirSync(dir(projectPath))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort();
}

export function loadSnapshot(projectPath: string, date: string): Snapshot | null {
  const f = join(dir(projectPath), `${date}.json`);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as Snapshot;
  } catch {
    return null;
  }
}

export function latestSnapshot(projectPath: string): Snapshot | null {
  const d = listSnapshots(projectPath).at(-1);
  return d ? loadSnapshot(projectPath, d) : null;
}

export function previousSnapshot(projectPath: string, date: string): Snapshot | null {
  const d = listSnapshots(projectPath).filter((x) => x < date).at(-1);
  return d ? loadSnapshot(projectPath, d) : null;
}
```

- [ ] **Step 4: Implement `src/idea/fetch.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { FetchLike } from '../assets/scoutWeb.js';
import type { SnapGame, SnapPass, Snapshot } from './snapshot.js';

// Chart snapshot from Roblox's public JSON APIs (the ones roblox.com/charts
// uses). Deterministic, sequential, a few dozen requests; the agent never gets
// a general web fetch.

const UA = { 'User-Agent': 'blox-idea (+https://github.com/orangutanger1/blox)', Accept: 'application/json' };
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
    const p = (await getJson(fetch, `https://apis.roblox.com/game-passes/v1/universes/${g.universeId}/game-passes?passView=Full&pageSize=50`)) as
      | { gamePasses?: { name?: string; isForSale?: boolean; price?: number | null }[] }
      | null;
    if (!p?.gamePasses) { passFails++; continue; }
    g.passes = p.gamePasses
      .filter((x) => x.isForSale && typeof x.price === 'number')
      .map((x): SnapPass => ({ name: x.name ?? '', price: x.price as number }));
  }
  if (passFails) notes.push(`game passes unavailable for ${passFails} game(s)`);

  return { version: 1, at: opts.now.toISOString(), date: opts.now.toISOString().slice(0, 10), device: opts.device, sorts, games, notes };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/idea.fetch.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/idea/snapshot.ts src/idea/fetch.ts tests/helpers/ideaWeb.ts tests/idea.fetch.test.ts
git commit -m "idea: chart snapshot fetch + storage"
```

---

### Task 2: Genre stats + theme counts

**Files:**
- Create: `src/idea/stats.ts`
- Create: `src/idea/themes.ts`
- Test: `tests/idea.stats.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `SnapGame` from Task 1.
- Produces:
  - `interface PriceBand { p25: number; p50: number; p75: number }`
  - `interface GenreStat { key: string; games: number; ccu: number; medianCcu: number; topShare: number; fresh: number; likeRatio: number; medianPasses: number | null; price: PriceBand | null }`
  - `quantile(xs: number[], q: number): number` (linear interpolation; sorted copy)
  - `priceBand(prices: number[]): PriceBand | null` (null when empty)
  - `genreStats(s: Snapshot): GenreStat[]` — keys `genre` and `genre/subgenre` (when subgenre non-empty), sorted by ccu desc
  - `statFor(stats: GenreStat[], genre: string, subgenre?: string): GenreStat | undefined` — case-insensitive; prefers `genre/subgenre`, falls back to `genre`
  - `FRESH_DAYS = 180`
  - `interface Theme { term: string; weight: number; games: number }`
  - `interface ThemeDelta { term: string; delta: number; isNew: boolean }`
  - `normalizeName(name: string): string`
  - `themeCounts(s: Snapshot, top?: number): Theme[]` (default 25)
  - `themeDeltas(cur: Theme[], prev: Theme[]): ThemeDelta[]` — rising first (delta desc), only |delta| ≥ 0.5 or new

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/idea.stats.test.ts`
Expected: FAIL — cannot resolve `../src/idea/stats.js`.

- [ ] **Step 3: Implement `src/idea/stats.ts`**

```ts
import type { SnapGame, Snapshot } from './snapshot.js';

// Per-genre market facts from one snapshot: demand (CCU), saturation (how
// much the top game owns), freshness (share of games under FRESH_DAYS old —
// an open market lets new games in), and how comparable games price passes.

export const FRESH_DAYS = 180;

export interface PriceBand { p25: number; p50: number; p75: number }
export interface GenreStat {
  key: string;
  games: number;
  ccu: number;
  medianCcu: number;
  topShare: number;
  fresh: number;
  likeRatio: number;
  medianPasses: number | null;
  price: PriceBand | null;
}

export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function priceBand(prices: number[]): PriceBand | null {
  if (prices.length === 0) return null;
  return { p25: Math.round(quantile(prices, 0.25)), p50: Math.round(quantile(prices, 0.5)), p75: Math.round(quantile(prices, 0.75)) };
}

function stat(key: string, gs: SnapGame[], at: number): GenreStat {
  const ccu = gs.reduce((n, g) => n + g.ccu, 0);
  const top = Math.max(...gs.map((g) => g.ccu));
  const fresh = gs.filter((g) => g.created && (at - Date.parse(g.created)) / 86_400_000 <= FRESH_DAYS).length;
  const ratios = gs.filter((g) => g.up + g.down > 0).map((g) => g.up / (g.up + g.down));
  const withPasses = gs.filter((g) => g.passes !== null);
  return {
    key,
    games: gs.length,
    ccu,
    medianCcu: quantile(gs.map((g) => g.ccu), 0.5),
    topShare: ccu > 0 ? top / ccu : 0,
    fresh: fresh / gs.length,
    likeRatio: ratios.length ? quantile(ratios, 0.5) : 0,
    medianPasses: withPasses.length ? quantile(withPasses.map((g) => g.passes!.length), 0.5) : null,
    price: priceBand(withPasses.flatMap((g) => g.passes!.map((p) => p.price))),
  };
}

export function genreStats(s: Snapshot): GenreStat[] {
  const groups = new Map<string, SnapGame[]>();
  const add = (k: string, g: SnapGame) => groups.set(k, [...(groups.get(k) ?? []), g]);
  for (const g of s.games) {
    add(g.genre, g);
    if (g.subgenre) add(`${g.genre}/${g.subgenre}`, g);
  }
  const at = Date.parse(s.at);
  return [...groups.entries()].map(([k, gs]) => stat(k, gs, at)).sort((a, b) => b.ccu - a.ccu || a.key.localeCompare(b.key));
}

export function statFor(stats: GenreStat[], genre: string, subgenre?: string): GenreStat | undefined {
  const find = (k: string) => stats.find((x) => x.key.toLowerCase() === k.toLowerCase());
  return (subgenre ? find(`${genre}/${subgenre}`) : undefined) ?? find(genre);
}
```

- [ ] **Step 4: Implement `src/idea/themes.ts`**

```ts
import type { Snapshot } from './snapshot.js';

// Theme words on the charts: chart names are noisy ("[⚡] Ride A Pet",
// "Steal An Egg 🥚 [UPD]"), so strip tags/emoji/update words, then count words
// (name + description start) and name word pairs once per game, weighted by
// log10(1+ccu). Deltas vs the previous snapshot show what is rising. The model
// reads the names itself; this is the repeatable, testable part.

const UPDATE_WORDS = /\b(upd|update|updated|new|event|release|beta|alpha|free|admin|limited)\b/gi;
// Genre words (obby, simulator, tycoon) are NOT stopwords: they are signal.
const STOP = new Set(
  'a an the and or of to in on at for with by from is are be your you my me we it its this that these them they our up out get go all every more most best new now just can will play game games roblox'.split(' '),
);

export interface Theme { term: string; weight: number; games: number }
export interface ThemeDelta { term: string; delta: number; isNew: boolean }

export function normalizeName(name: string): string {
  return name
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
    .replace(/[\p{Extended_Pictographic}\p{So}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(UPDATE_WORDS, ' ')
    .replace(/\b(x\d+|\d+%)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s|:!\-–—]+|[\s|:!\-–—]+$/g, '')
    .trim();
}

const words = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9']+/).map((w) => w.replace(/'s$|'/g, '')).filter((w) => w.length > 1 && !/^\d+$/.test(w) && !STOP.has(w));

const singular = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

export function themeCounts(s: Snapshot, top = 25): Theme[] {
  const acc = new Map<string, Theme>();
  for (const g of s.games) {
    const nameWords = words(normalizeName(g.name)).map(singular);
    const terms = new Set<string>([...nameWords, ...words(g.description.slice(0, 300)).map(singular)]);
    for (let i = 0; i + 1 < nameWords.length; i++) terms.add(`${nameWords[i]} ${nameWords[i + 1]}`);
    const w = Math.log10(1 + g.ccu);
    for (const t of terms) {
      const cur = acc.get(t) ?? { term: t, weight: 0, games: 0 };
      cur.weight += w;
      cur.games += 1;
      acc.set(t, cur);
    }
  }
  return [...acc.values()]
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    .slice(0, top)
    .map((t) => ({ ...t, weight: Math.round(t.weight * 100) / 100 }));
}

export function themeDeltas(cur: Theme[], prev: Theme[]): ThemeDelta[] {
  const before = new Map(prev.map((t) => [t.term, t.weight]));
  const out: ThemeDelta[] = [];
  for (const t of cur) {
    const p = before.get(t.term);
    const delta = Math.round((t.weight - (p ?? 0)) * 100) / 100;
    if (p === undefined) out.push({ term: t.term, delta, isNew: true });
    else if (Math.abs(delta) >= 0.5) out.push({ term: t.term, delta, isNew: false });
  }
  return out.sort((a, b) => b.delta - a.delta);
}
```

Note on the test's weight check: `pet` appears in game 1 (name "Ride A Pet", description "pets" → singular "pet") and game 2 ("Pet Simulator"/"pet") — counted once per game, so weight = log10(1000) + log10(100) = 5.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/idea.stats.test.ts`
Expected: PASS (7 tests). If the `pet` weight is off, check that `singular('pets')` is `pet` and that the term set dedupes per game.

- [ ] **Step 6: Commit**

```bash
git add src/idea/stats.ts src/idea/themes.ts tests/idea.stats.test.ts
git commit -m "idea: genre stats + theme counts"
```

---

### Task 3: Idea schema, citation check, fit + score

**Files:**
- Create: `src/idea/idea.ts`
- Create: `src/idea/score.ts`
- Test: `tests/idea.score.test.ts`

**Interfaces:**
- Consumes: `Snapshot` (Task 1), `GenreStat`, `genreStats`, `statFor` (Task 2).
- Produces:
  - `FORMATS` = the design meta.format enum tuple (import from nothing — define here: `['incremental','steal-tycoon','round','survival','collection','battlegrounds','other'] as const`)
  - `IdeaSchema` (zod strict) and `type Idea = z.infer<typeof IdeaSchema>` with fields `{id, title, format, genre_l1, genre_l2?, theme, hook, loop: string[≥3], monetization: {kind, name, priceRobux?}[≥1], cites: number[≥2] (strings coerced), risks?: string[]}`
  - `validateIdeas(raw: unknown, snap: Snapshot): { ok: true; ideas: Idea[] } | { ok: false; errors: string[] }` — accepts an array or `{ideas: [...]}`
  - `FORMAT_FIT: Record<Format, number>`
  - `WEIGHTS = { demand: 0.35, fresh: 0.2, open: 0.15, liked: 0.1, fit: 0.2 }`
  - `interface ScoreParts { demand: number; fresh: number; open: number; liked: number; fit: number }`
  - `interface RankedIdea extends Idea { score: number; parts: ScoreParts; genreKey: string }`
  - `scoreIdea(idea: Idea, stats: GenreStat[]): { score: number; parts: ScoreParts; genreKey: string }`
  - `rankIdeas(ideas: Idea[], snap: Snapshot): RankedIdea[]` (score desc, ties by input order)

- [ ] **Step 1: Write the failing test**

```ts
// tests/idea.score.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/idea.score.test.ts`
Expected: FAIL — cannot resolve `../src/idea/idea.js`.

- [ ] **Step 3: Implement `src/idea/idea.ts`**

```ts
import { z } from 'zod';
import type { Snapshot } from './snapshot.js';

// An idea the agent proposes from a snapshot. Evidence must be real: every
// cited universeId is in the snapshot and the genre matches a cited game.

export const FORMATS = ['incremental', 'steal-tycoon', 'round', 'survival', 'collection', 'battlegrounds', 'other'] as const;
export type Format = (typeof FORMATS)[number];

const Id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'ids start with a letter; letters, digits, _ and - only');

export const IdeaSchema = z
  .object({
    id: Id,
    title: z.string().min(1),
    format: z.enum(FORMATS),
    genre_l1: z.string().min(1),
    genre_l2: z.string().optional(),
    theme: z.string().min(1),
    hook: z.string().min(1),
    loop: z.array(z.string().min(1)).min(3),
    monetization: z
      .array(z.object({ kind: z.enum(['pass', 'product', 'subscription']), name: z.string().min(1), priceRobux: z.number().int().positive().optional() }).strict())
      .min(1),
    cites: z.array(z.coerce.number().int().positive()).min(2),
    risks: z.array(z.string()).optional(),
  })
  .strict();
export type Idea = z.infer<typeof IdeaSchema>;

export function validateIdeas(raw: unknown, snap: Snapshot): { ok: true; ideas: Idea[] } | { ok: false; errors: string[] } {
  const list = Array.isArray(raw) ? raw : (raw as { ideas?: unknown } | null)?.ideas;
  const parsed = z.array(IdeaSchema).min(3, 'propose 3 to 6 ideas').max(6, 'propose 3 to 6 ideas').safeParse(list);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(ideas)'}: ${i.message}`) };
  const errors: string[] = [];
  const byId = new Map(snap.games.map((g) => [g.universeId, g]));
  const seen = new Set<string>();
  for (const idea of parsed.data) {
    if (seen.has(idea.id)) errors.push(`${idea.id}: duplicate id`);
    seen.add(idea.id);
    const unknown = idea.cites.filter((c) => !byId.has(c));
    if (unknown.length) errors.push(`${idea.id}: cites not in the ${snap.date} snapshot: ${unknown.join(', ')}`);
    const genres = idea.cites.map((c) => byId.get(c)?.genre.toLowerCase()).filter(Boolean);
    if (genres.length && !genres.includes(idea.genre_l1.toLowerCase()))
      errors.push(`${idea.id}: genre_l1 "${idea.genre_l1}" matches none of its cited games (${[...new Set(genres)].join(', ')})`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, ideas: parsed.data };
}
```

- [ ] **Step 4: Implement `src/idea/score.ts`**

```ts
import type { Format, Idea } from './idea.js';
import type { Snapshot } from './snapshot.js';
import { genreStats, statFor, type GenreStat } from './stats.js';

// Deterministic score per idea from its genre's stats. Parts are kept so the
// human sees why an idea ranks where it does. Weights live here only.

// How well blox builds a format: kit = 1, design-format support = 0.6, else 0.3.
export const FORMAT_FIT: Record<Format, number> = {
  incremental: 1, 'steal-tycoon': 1, round: 0.6, survival: 0.6, collection: 0.6, battlegrounds: 0.6, other: 0.3,
};
export const WEIGHTS = { demand: 0.35, fresh: 0.2, open: 0.15, liked: 0.1, fit: 0.2 };
const MONOPOLY = 0.6; // top game share above this = hard to break in

export interface ScoreParts { demand: number; fresh: number; open: number; liked: number; fit: number }
export interface RankedIdea extends Idea { score: number; parts: ScoreParts; genreKey: string }

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const r2 = (x: number) => Math.round(x * 100) / 100;

export function scoreIdea(idea: Idea, stats: GenreStat[]): { score: number; parts: ScoreParts; genreKey: string } {
  const st = statFor(stats, idea.genre_l1, idea.genre_l2);
  const maxCcu = Math.max(1, ...stats.filter((s) => !s.key.includes('/')).map((s) => s.ccu));
  const parts: ScoreParts = st
    ? {
        demand: r2(Math.log10(1 + st.ccu) / Math.log10(1 + maxCcu)),
        fresh: r2(st.fresh),
        open: r2(st.topShare <= MONOPOLY ? 1 : clamp((1 - st.topShare) / (1 - MONOPOLY))),
        liked: r2(clamp((st.likeRatio - 0.7) / 0.3)),
        fit: FORMAT_FIT[idea.format],
      }
    : { demand: 0, fresh: 0, open: 0, liked: 0, fit: FORMAT_FIT[idea.format] };
  const score = Math.round(100 * (Object.keys(WEIGHTS) as (keyof ScoreParts)[]).reduce((n, k) => n + WEIGHTS[k] * parts[k], 0));
  return { score, parts, genreKey: st?.key ?? idea.genre_l1 };
}

export function rankIdeas(ideas: Idea[], snap: Snapshot): RankedIdea[] {
  const stats = genreStats(snap);
  return ideas
    .map((idea, i) => ({ i, r: { ...idea, ...scoreIdea(idea, stats) } }))
    .sort((a, b) => b.r.score - a.r.score || a.i - b.i)
    .map((x) => x.r);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/idea.score.test.ts`
Expected: PASS (8 tests). Check `sim.parts.open`: Simulation/Tycoon top share = 50000/90000 ≈ 0.56 → 1. Tower Defense top share = 900000/901000 → open ≈ 0.003.

- [ ] **Step 6: Commit**

```bash
git add src/idea/idea.ts src/idea/score.ts tests/idea.score.test.ts
git commit -m "idea: idea schema, citation check, score"
```

---

### Task 4: Brief

**Files:**
- Create: `src/idea/brief.ts`
- Test: `tests/idea.brief.test.ts`

**Interfaces:**
- Consumes: `RankedIdea` (Task 3), `Snapshot` (Task 1), `genreStats`, `statFor`, `priceBand`, `PriceBand` (Task 2).
- Produces:
  - `interface Evidence { universeId: number; name: string; ccu: number; visits: number; created: string; genre: string; subgenre: string; passes: { name: string; price: number }[] | null }`
  - `interface Brief { version: 1; at: string; snapshot: string; idea: RankedIdea; evidence: Evidence[]; priceAnchors: PriceBand | null; priceSource: 'cited games' | 'genre' | 'none'; device: string; openQuestions: string[]; designHints: { title: string; format: string; loop: string[]; monetization: string[] } }`
  - `buildBrief(idea: RankedIdea, snap: Snapshot, now: Date): Brief`
  - `briefText(b: Brief): string` (short human summary, used by the tool)

- [ ] **Step 1: Write the failing test**

```ts
// tests/idea.brief.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/idea.brief.test.ts`
Expected: FAIL — cannot resolve `../src/idea/brief.js`.

- [ ] **Step 3: Implement `src/idea/brief.ts`**

```ts
import type { RankedIdea } from './score.js';
import type { Snapshot } from './snapshot.js';
import { genreStats, priceBand, statFor, type PriceBand } from './stats.js';
import { normalizeName } from './themes.js';

// .blox/brief.json — the picked idea plus the evidence behind it. The build
// step reads it before writing design.json (design {action:"set"}); brief never
// writes design.json itself (that needs an economy and resolvable refs).

export interface Evidence {
  universeId: number; name: string; ccu: number; visits: number; created: string; genre: string; subgenre: string;
  passes: { name: string; price: number }[] | null;
}
export interface Brief {
  version: 1;
  at: string;
  snapshot: string;
  idea: RankedIdea;
  evidence: Evidence[];
  priceAnchors: PriceBand | null;
  priceSource: 'cited games' | 'genre' | 'none';
  device: string;
  openQuestions: string[];
  designHints: { title: string; format: string; loop: string[]; monetization: string[] };
}

const BASE_QUESTIONS = [
  'What does a player do in the first 60 seconds?',
  'Which cited game is the closest competitor, and what do we do differently?',
  'Phone first: does the core action work with one thumb?',
];

export function buildBrief(idea: RankedIdea, snap: Snapshot, now: Date): Brief {
  const byId = new Map(snap.games.map((g) => [g.universeId, g]));
  const evidence: Evidence[] = [...new Set(idea.cites)]
    .map((id) => byId.get(id))
    .filter((g): g is NonNullable<typeof g> => !!g)
    .map((g) => ({ universeId: g.universeId, name: normalizeName(g.name) || g.name, ccu: g.ccu, visits: g.visits, created: g.created, genre: g.genre, subgenre: g.subgenre, passes: g.passes }));
  const cited = priceBand(evidence.flatMap((e) => e.passes?.map((p) => p.price) ?? []));
  const genre = statFor(genreStats(snap), idea.genre_l1, idea.genre_l2)?.price ?? null;
  return {
    version: 1,
    at: now.toISOString(),
    snapshot: snap.date,
    idea,
    evidence,
    priceAnchors: cited ?? genre,
    priceSource: cited ? 'cited games' : genre ? 'genre' : 'none',
    device: snap.device,
    openQuestions: [...BASE_QUESTIONS, ...(idea.risks ?? [])],
    designHints: {
      title: idea.title,
      format: idea.format,
      loop: idea.loop,
      monetization: idea.monetization.map((m) => `${m.kind}: ${m.name}${m.priceRobux ? ` (${m.priceRobux} R$)` : ''}`),
    },
  };
}

export function briefText(b: Brief): string {
  const i = b.idea;
  const lines = [
    `${i.title} — ${i.format}, ${b.idea.genreKey}, score ${i.score}`,
    `hook: ${i.hook}`,
    `loop: ${i.loop.join(' → ')}`,
    `evidence (${b.snapshot}): ${b.evidence.map((e) => `${e.name} ${e.ccu.toLocaleString('en-US')} CCU`).join('; ')}`,
    b.priceAnchors ? `pass prices (${b.priceSource}): p25 ${b.priceAnchors.p25} / p50 ${b.priceAnchors.p50} / p75 ${b.priceAnchors.p75} R$` : 'pass prices: no data',
    `open questions: ${b.openQuestions.join(' | ')}`,
    `Next: write .blox/design.json from designHints with design {action:"set"} (add an economy), then design {action:"simulate"}.`,
  ];
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/idea.brief.test.ts`
Expected: PASS (4 tests). Genre fallback check: Simulation/Tycoon prices across games with passes = [400, 200, 1000] → p25 300, p50 400, p75 700.

- [ ] **Step 5: Commit**

```bash
git add src/idea/brief.ts tests/idea.brief.test.ts
git commit -m "idea: brief with evidence and price anchors"
```

---

### Task 5: `idea` tool, CLI, guide

**Files:**
- Create: `src/idea/tool.ts`
- Modify: `src/tools/registry.ts` (import next to the scout import at line ~51; add tool entry right after the `scout` entry at line ~900)
- Modify: `src/args.ts:2` (add `'idea'` to `TOOL_COMMANDS`)
- Modify: `src/cliTools.ts` (add `case 'idea'` before `case 'scout'` at line ~236; add HELP line after the `blox scout …` line ~370)
- Modify: `src/agentGuide.ts` (one line in "## Start from a kit, template or pack")
- Modify: `tests/agentGuide.test.ts:44` (5800 → 6000)
- Test: `tests/idea.tool.test.ts`

**Interfaces:**
- Consumes: everything above; `ToolCtx`, `ToolOutput` from `src/tools/registry.ts`; `readJson`, `writeJson` from `src/state/store.ts`; `FetchLike` from `src/assets/scoutWeb.ts`.
- Produces:
  - `IDEA_DESCRIPTION: string`, `ideaShape` (zod raw shape), `ideaTool(a: Record<string, unknown>, ctx: ToolCtx & { now?: Date }): Promise<ToolOutput>`
  - `.blox/ideas.json` = `{ snapshot: string; at: string; ideas: RankedIdea[] }`
  - `.blox/brief.json` = `Brief`
  - `DEVICES: Record<string, string>` = `{ all: 'all', phone: 'high_end_phone', computer: 'computer', tablet: 'high_end_tablet', console: 'console' }`
  - CLI: `idea research [--fresh] [--device phone]`, `idea propose '<json>'`, `idea list`, `idea brief <id>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/idea.tool.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { StudioSession } from '../src/studio/session.js';
import { BloxConfigSchema } from '../src/config.js';
import { readJson } from '../src/state/store.js';
import { cliArgs, parseFlags, TOOL_COMMANDS } from '../src/cliTools.js';
import { fakeFetch, WEB, type Web } from './helpers/ideaWeb.js';
import { saveSnapshot, listSnapshots } from '../src/idea/snapshot.js';

function ctxFor(P: string, web: Web = WEB, seen: string[] = []): ToolCtx {
  return {
    // idea never touches Studio; a session that fails to connect is enough.
    session: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => { throw new Error('no studio in idea tests'); }, sleep: async () => {}, attachTimeoutMs: 0 }),
    projectPath: P,
    config: BloxConfigSchema.parse({ projectPath: P }),
    agent: 'test',
    fetch: fakeFetch(web, seen),
  };
}
const tool = () => findTool('idea')!;
const idea = (id: string, cites: number[], extra: Record<string, unknown> = {}) => ({
  id, title: `T ${id}`, format: 'steal-tycoon', genre_l1: 'Simulation', genre_l2: 'Tycoon', theme: 'eggs', hook: 'h', loop: ['a', 'b', 'c'],
  monetization: [{ kind: 'pass', name: 'VIP', priceRobux: 399 }], cites, ...extra,
});

describe('idea tool', () => {
  it('research writes a snapshot, prints stats + game list, reuses today', async () => {
    const P = mkdtempSync(join(tmpdir(), 'idea-tool-'));
    const seen: string[] = [];
    const out = await invokeTool(tool(), { action: 'research' }, ctxFor(P, WEB, seen));
    expect(out.isError).toBeFalsy();
    expect(listSnapshots(P)).toHaveLength(1);
    expect(out.text).toMatch(/Simulation/);
    expect(out.text).toMatch(/Steal An Egg/);
    expect(out.text).toMatch(/idea \{action:"propose"/);
    const n = seen.length;
    const again = await invokeTool(tool(), { action: 'research' }, ctxFor(P, WEB, seen));
    expect(seen.length).toBe(n); // cached
    expect(again.text).toMatch(/cached/);
    await invokeTool(tool(), { action: 'research', fresh: true }, ctxFor(P, WEB, seen));
    expect(seen.length).toBeGreaterThan(n);
  });
  it('research with a different device is not served from cache', async () => {
    const P = mkdtempSync(join(tmpdir(), 'idea-tool-'));
    const seen: string[] = [];
    await invokeTool(tool(), { action: 'research' }, ctxFor(P, WEB, seen));
    await invokeTool(tool(), { action: 'research', device: 'phone' }, ctxFor(P, WEB, seen));
    expect(seen.some((u) => u.includes('device=high_end_phone'))).toBe(true);
  });
  it('research: charts down is an error', async () => {
    const P = mkdtempSync(join(tmpdir(), 'idea-tool-'));
    const out = await invokeTool(tool(), { action: 'research' }, ctxFor(P, {}));
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/charts unavailable/);
  });
  it('propose before research says to research first', async () => {
    const P = mkdtempSync(join(tmpdir(), 'idea-tool-'));
    const out = await invokeTool(tool(), { action: 'propose', ideas: [] }, ctxFor(P));
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/idea \{action:"research"\}/);
  });
  it('propose → list → brief round trip; bad cites refused; unknown brief id listed', async () => {
    const P = mkdtempSync(join(tmpdir(), 'idea-tool-'));
    await invokeTool(tool(), { action: 'research' }, ctxFor(P));
    const bad = await invokeTool(tool(), { action: 'propose', ideas: [idea('a', [1, 99]), idea('b', [1, 2]), idea('c', [2, 1])] }, ctxFor(P));
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/99/);
    const ok = await invokeTool(tool(), { action: 'propose', ideas: [idea('a', [1, 2]), idea('b', [1, 2], { format: 'other' }), idea('c', [2, 1])] }, ctxFor(P));
    expect(ok.isError).toBeFalsy();
    const saved = readJson<{ ideas: { id: string; score: number }[] }>(P, 'ideas.json')!;
    expect(saved.ideas.map((i) => i.id)).toEqual(['a', 'c', 'b']);
    const list = await invokeTool(tool(), { action: 'list' }, ctxFor(P));
    expect(list.text).toMatch(/1\. a/);
    expect(list.text).toMatch(/demand/);
    const unknown = await invokeTool(tool(), { action: 'brief', id: 'zzz' }, ctxFor(P));
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/a, c, b/);
    const brief = await invokeTool(tool(), { action: 'brief', id: 'c' }, ctxFor(P));
    expect(brief.isError).toBeFalsy();
    expect(readJson<{ idea: { id: string } }>(P, 'brief.json')!.idea.id).toBe('c');
    expect(readJson(P, 'design.json')).toBeNull(); // never written
  });
  it('list with no ideas explains the order', async () => {
    const P = mkdtempSync(join(tmpdir(), 'idea-tool-'));
    const out = await invokeTool(tool(), { action: 'list' }, ctxFor(P));
    expect(out.text).toMatch(/no ideas yet/);
  });
  it('research shows rising themes when a previous snapshot exists', async () => {
    const P = mkdtempSync(join(tmpdir(), 'idea-tool-'));
    saveSnapshot(P, { version: 1, at: '2026-09-01T00:00:00Z', date: '2026-09-01', device: 'all', sorts: [], notes: [], games: [] });
    const out = await invokeTool(tool(), { action: 'research' }, ctxFor(P));
    expect(out.text).toMatch(/vs 2026-09-01/);
  });
});

describe('idea CLI', () => {
  it('maps subcommands', () => {
    expect(TOOL_COMMANDS.has('idea')).toBe(true);
    expect(cliArgs('idea', parseFlags(['research', '--fresh', '--device', 'phone']))).toEqual({ tool: 'idea', args: { action: 'research', fresh: true, device: 'phone' } });
    expect(cliArgs('idea', parseFlags(['propose', '[{"id":"a"}]']))).toEqual({ tool: 'idea', args: { action: 'propose', ideas: [{ id: 'a' }] } });
    expect(cliArgs('idea', parseFlags(['propose', '{"ideas":[{"id":"a"}]}']))).toEqual({ tool: 'idea', args: { action: 'propose', ideas: [{ id: 'a' }] } });
    expect(cliArgs('idea', parseFlags(['brief', 'a']))).toEqual({ tool: 'idea', args: { action: 'brief', id: 'a' } });
    expect(cliArgs('idea', parseFlags([]))).toEqual({ tool: 'idea', args: { action: 'list' } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/idea.tool.test.ts`
Expected: FAIL — `findTool('idea')` is undefined (TypeError on `!`).

- [ ] **Step 3: Implement `src/idea/tool.ts`**

```ts
import { z } from 'zod';
import type { FetchLike } from '../assets/scoutWeb.js';
import { readJson, writeJson } from '../state/store.js';
import type { ToolCtx, ToolOutput } from '../tools/registry.js';
import { briefText, buildBrief } from './brief.js';
import { gatherSnapshot } from './fetch.js';
import { validateIdeas } from './idea.js';
import { rankIdeas, type RankedIdea } from './score.js';
import { latestSnapshot, loadSnapshot, previousSnapshot, saveSnapshot, type Snapshot } from './snapshot.js';
import { genreStats } from './stats.js';
import { normalizeName, themeCounts, themeDeltas } from './themes.js';

export const IDEA_DESCRIPTION =
  'Pick what game to build from live Roblox chart data. research {fresh?, device?=all|phone|computer|tablet|console} (snapshot of the charts + game details + pass prices into .blox/research/<date>.json, cached per day; prints genre stats, theme words rising/falling, and the game list with universeIds) | propose {ideas:[3-6 × {id, title, format, genre_l1, genre_l2?, theme, hook, loop[≥3], monetization[{kind, name, priceRobux?}], cites:[≥2 universeIds from the snapshot], risks?}]} (validated, scored, ranked into .blox/ideas.json) | list (ranked ideas with score parts and evidence — show the human and let them pick) | brief {id} (writes .blox/brief.json for the picked idea; then write design.json from it with design {action:"set"}).';

export const DEVICES: Record<string, string> = { all: 'all', phone: 'high_end_phone', computer: 'computer', tablet: 'high_end_tablet', console: 'console' };

export const ideaShape = {
  action: z.enum(['research', 'propose', 'list', 'brief']),
  fresh: z.boolean().optional(),
  device: z.enum(['all', 'phone', 'computer', 'tablet', 'console']).optional(),
  ideas: z.unknown().optional(),
  id: z.string().optional(),
};

interface IdeasFile { snapshot: string; at: string; ideas: RankedIdea[] }

const fetchOf = (ctx: ToolCtx): FetchLike => ctx.fetch ?? (globalThis.fetch as unknown as FetchLike);
const err = (text: string, summary: string): ToolOutput => ({ text, isError: true, summary });
const fmt = (n: number) => n.toLocaleString('en-US');
const pct = (x: number) => `${Math.round(x * 100)}%`;

function researchText(snap: Snapshot, prev: Snapshot | null, cached: boolean, rel: string): string {
  const stats = genreStats(snap);
  const themes = themeCounts(snap);
  const lines = [
    `${cached ? 'cached' : 'new'} snapshot ${rel} — ${snap.games.length} games from ${snap.sorts.join(', ')} (device ${snap.device})`,
    ...snap.notes.map((n) => `note: ${n}`),
    '',
    'genre | games | CCU | median | top share | fresh<180d | liked | passes | price p25/p50/p75',
    ...stats.slice(0, 14).map((s) =>
      `${s.key} | ${s.games} | ${fmt(s.ccu)} | ${fmt(Math.round(s.medianCcu))} | ${pct(s.topShare)} | ${pct(s.fresh)} | ${pct(s.likeRatio)} | ${s.medianPasses ?? '-'} | ${s.price ? `${s.price.p25}/${s.price.p50}/${s.price.p75}` : '-'}`),
    '',
    `themes: ${themes.slice(0, 20).map((t) => `${t.term} ${t.weight}`).join(', ')}`,
  ];
  if (prev) {
    const d = themeDeltas(themes, themeCounts(prev));
    lines.push(`themes vs ${prev.date}: ${d.slice(0, 12).map((x) => `${x.term} ${x.isNew ? 'new' : x.delta > 0 ? `+${x.delta}` : x.delta}`).join(', ') || 'no change'}`);
  }
  lines.push('', 'universeId | name | genre/sub | CCU | created | passes');
  for (const g of snap.games.slice(0, 60)) {
    lines.push(`${g.universeId} | ${normalizeName(g.name) || g.name} | ${g.genre}${g.subgenre ? `/${g.subgenre}` : ''} | ${fmt(g.ccu)} | ${g.created.slice(0, 7) || '?'} | ${g.passes ? g.passes.length : '-'}`);
  }
  lines.push(
    '',
    'Next: idea {action:"propose", ideas:[3-6]} — each cites ≥2 universeIds above, format one of incremental|steal-tycoon|round|survival|collection|battlegrounds|other (blox has kits for incremental and steal-tycoon). Then show idea {action:"list"} to the human and let them pick.',
  );
  return lines.join('\n');
}

function listText(f: IdeasFile): string {
  return [
    `ideas from snapshot ${f.snapshot} (score 0-100; parts 0-1: demand, fresh, open, liked, fit)`,
    ...f.ideas.map((i, n) =>
      `${n + 1}. ${i.id} — ${i.title} [${i.format}, ${i.genreKey}] score ${i.score} (demand ${i.parts.demand}, fresh ${i.parts.fresh}, open ${i.parts.open}, liked ${i.parts.liked}, fit ${i.parts.fit})\n   hook: ${i.hook}\n   cites: ${i.cites.join(', ')}`),
    'Pick one: idea {action:"brief", id}.',
  ].join('\n');
}

export async function ideaTool(a: Record<string, unknown>, ctx: ToolCtx & { now?: Date }): Promise<ToolOutput> {
  const P = ctx.projectPath;
  const now = ctx.now ?? new Date();
  if (a.action === 'research') {
    const device = DEVICES[(a.device as string | undefined) ?? 'all'];
    const today = now.toISOString().slice(0, 10);
    const existing = loadSnapshot(P, today);
    if (existing && existing.device === device && a.fresh !== true) {
      return { text: researchText(existing, previousSnapshot(P, today), true, `.blox/research/${today}.json`), summary: `cached ${existing.games.length} games` };
    }
    let snap: Snapshot;
    try {
      snap = await gatherSnapshot(fetchOf(ctx), { device, now });
    } catch (e) {
      return err((e as Error).message, 'charts unavailable');
    }
    const rel = saveSnapshot(P, snap);
    return { text: researchText(snap, previousSnapshot(P, snap.date), false, rel), summary: `${snap.games.length} games` };
  }
  if (a.action === 'propose') {
    const snap = latestSnapshot(P);
    if (!snap) return err('no snapshot yet — run idea {action:"research"} first', 'no snapshot');
    const v = validateIdeas(a.ideas, snap);
    if (!v.ok) return err(`ideas refused:\n${v.errors.map((e) => `  ${e}`).join('\n')}`, 'refused');
    const f: IdeasFile = { snapshot: snap.date, at: now.toISOString(), ideas: rankIdeas(v.ideas, snap) };
    writeJson(P, 'ideas.json', f);
    return { text: `saved .blox/ideas.json\n${listText(f)}`, summary: `${f.ideas.length} ideas` };
  }
  const f = readJson<IdeasFile>(P, 'ideas.json');
  if (a.action === 'list') {
    if (!f) return { text: 'no ideas yet — idea {action:"research"}, then idea {action:"propose"}', summary: 'none' };
    return { text: listText(f), summary: `${f.ideas.length} ideas` };
  }
  if (a.action === 'brief') {
    if (!f) return err('no ideas yet — idea {action:"research"}, then idea {action:"propose"}', 'no ideas');
    const pick = f.ideas.find((i) => i.id === a.id);
    if (!pick) return err(`unknown idea "${String(a.id)}" — known: ${f.ideas.map((i) => i.id).join(', ')}`, 'unknown id');
    const snap = loadSnapshot(P, f.snapshot);
    if (!snap) return err(`snapshot ${f.snapshot} is missing — run idea {action:"research"} and propose again`, 'no snapshot');
    const b = buildBrief(pick, snap, now);
    writeJson(P, 'brief.json', b);
    return { text: `wrote .blox/brief.json\n${briefText(b)}`, summary: `brief ${pick.id}` };
  }
  return err(`unknown action ${String(a.action)}`, 'bad action');
}
```

- [ ] **Step 4: Register the tool in `src/tools/registry.ts`**

Add next to the scout import (line ~51):

```ts
import { ideaTool, ideaShape, IDEA_DESCRIPTION } from '../idea/tool.js';
```

Add right after the `scout` entry (`{ name: 'scout', … handler: scoutTool, },`):

```ts
  {
    name: 'idea',
    description: IDEA_DESCRIPTION,
    shape: ideaShape,
    handler: ideaTool,
  },
```

- [ ] **Step 5: CLI mapping**

`src/args.ts:2` — add `'idea'` to the `TOOL_COMMANDS` set (after `'scout'`).

`src/cliTools.ts` — add before `case 'scout': {`:

```ts
    case 'idea': {
      const sub = f.rest[0] ?? 'list';
      if (sub === 'research') return { tool: 'idea', args: { action: 'research', ...(o.fresh === true ? { fresh: true } : {}), ...(typeof o.device === 'string' ? { device: o.device } : {}) } };
      if (sub === 'propose') {
        const raw = JSON.parse(f.rest.slice(1).join(' ')) as unknown;
        return { tool: 'idea', args: { action: 'propose', ideas: Array.isArray(raw) ? raw : (raw as { ideas?: unknown }).ideas } };
      }
      if (sub === 'brief') return { tool: 'idea', args: { action: 'brief', id: f.rest[1] } };
      return { tool: 'idea', args: { action: 'list' } };
    }
```

(`o` is the existing `f.opts` alias used by the other cases — confirm the name at the top of `cliArgs`.)

HELP — add after the `blox scout …` line:

```
           blox idea research [--fresh] [--device all|phone|computer|tablet|console] | propose '<json ideas>' | list | brief <id>
```

- [ ] **Step 6: Agent guide + budget**

`src/agentGuide.ts`, at the start of the "## Start from a kit, template or pack" section body (before `kit {action:"list"}`), insert one line:

```
No game picked yet? idea research → propose (cite snapshot games) → human picks from idea list → idea brief; read .blox/brief.json before design.
```

`tests/agentGuide.test.ts:44` — change `5800` to `6000`.

- [ ] **Step 7: Run tests**

Run: `npx vitest run tests/idea.tool.test.ts tests/agentGuide.test.ts tests/cliTools.test.ts tests/agent.openaiRunner.test.ts`
Expected: PASS. If `agent.openaiRunner.test.ts` or another test snapshots the tool list / tool count, update that expectation to include `idea`.

- [ ] **Step 8: Full suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all tests pass (known flake: `tests/release.tool.test.ts` liveops test may hit the 5s timeout under load — rerun it alone to confirm).

- [ ] **Step 9: Commit**

```bash
git add src/idea/tool.ts src/tools/registry.ts src/args.ts src/cliTools.ts src/agentGuide.ts tests/idea.tool.test.ts tests/agentGuide.test.ts
git commit -m "idea: research/propose/list/brief tool + CLI + guide line"
```

---

### Task 6: Live smoke (no code unless it finds bugs)

**Files:** none (fixes, if any, go in a follow-up commit with a regression test).

- [ ] **Step 1: Real research in the scratch place**

Run (from `~/blox-playground`): `npx --prefix ~/blox tsx ~/blox/src/cli.ts idea research`
Expected: `new snapshot .blox/research/<today>.json — ~300 games from top-trending, up-and-coming, …`, a genre table with real numbers, theme words, game list. Notes empty or only passes failures. Re-run: says `cached`.

- [ ] **Step 2: Phone device**

Run: `npx --prefix ~/blox tsx ~/blox/src/cli.ts idea research --device phone --fresh`
Expected: snapshot with `device high_end_phone`.

- [ ] **Step 3: Propose (one model turn — write the ideas yourself from the printed data)**

Read the research output, write 4 ideas citing real universeIds, run `idea propose '<json>'`. Expected: ranked list. Then try one idea with a fake id (e.g. 1) → refused with the id named.

- [ ] **Step 4: Brief**

Run: `idea brief <top id>`. Expected: `.blox/brief.json` exists with evidence names/CCU matching the snapshot; `.blox/design.json` unchanged.

- [ ] **Step 5: Record**

Note request count (expected ≤ 47), wall time, and anything surprising in the PR description.
