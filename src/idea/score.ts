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
