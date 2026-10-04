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
