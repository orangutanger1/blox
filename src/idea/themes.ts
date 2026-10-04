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
