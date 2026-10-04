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
