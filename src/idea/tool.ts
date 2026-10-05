import { z } from 'zod';
import type { FetchLike } from '../assets/scoutWeb.js';
import { readJson, writeJson } from '../state/store.js';
import type { ToolCtx, ToolOutput } from '../tools/registry.js';
import { briefText, buildBrief } from './brief.js';
import { gatherSnapshot } from './fetch.js';
import { validateIdeas } from './idea.js';
import { rankIdeas, type RankedIdea } from './score.js';
import { latestSnapshot, loadSnapshot, previousSnapshot, saveSnapshot, snapshotKey, snapshotKeyOf, type Snapshot } from './snapshot.js';
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

interface IdeasFile { snapshot: string; snapshotAt?: string; at: string; ideas: RankedIdea[] }

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

// `ideas` as the array itself, {ideas:[...]}, or either as JSON text (the CLI
// passes text; some models send the array as a string).
export function parseIdeasArg(raw: unknown): { ok: true; ideas: unknown } | { ok: false; error: string } {
  let v = raw;
  if (typeof v === 'string') {
    if (!v.trim()) return { ok: false, error: 'no ideas given — pass ideas:[3-6 ideas]' };
    try {
      v = JSON.parse(v);
    } catch (e) {
      return { ok: false, error: `ideas is not valid JSON: ${(e as Error).message}` };
    }
  }
  if (v === undefined || v === null) return { ok: false, error: 'no ideas given — pass ideas:[3-6 ideas]' };
  if (!Array.isArray(v) && typeof v === 'object' && 'ideas' in v) v = (v as { ideas: unknown }).ideas;
  return { ok: true, ideas: v };
}

export async function ideaTool(a: Record<string, unknown>, ctx: ToolCtx & { now?: Date }): Promise<ToolOutput> {
  const P = ctx.projectPath;
  const now = ctx.now ?? new Date();
  if (a.action === 'research') {
    const device = DEVICES[(a.device as string | undefined) ?? 'all'];
    const today = now.toISOString().slice(0, 10);
    const key = snapshotKey(today, device);
    const existing = loadSnapshot(P, key);
    if (existing && a.fresh !== true) {
      return { text: researchText(existing, previousSnapshot(P, today, device), true, `.blox/research/${key}.json`), summary: `cached ${existing.games.length} games` };
    }
    let snap: Snapshot;
    try {
      snap = await gatherSnapshot(fetchOf(ctx), { device, now });
    } catch (e) {
      return err((e as Error).message, 'charts unavailable');
    }
    const rel = saveSnapshot(P, snap);
    return { text: researchText(snap, previousSnapshot(P, snap.date, snap.device), false, rel), summary: `${snap.games.length} games` };
  }
  if (a.action === 'propose') {
    const snap = latestSnapshot(P);
    if (!snap) return err('no snapshot yet — run idea {action:"research"} first', 'no snapshot');
    const parsed = parseIdeasArg(a.ideas);
    if (!parsed.ok) return err(parsed.error, 'refused');
    const v = validateIdeas(parsed.ideas, snap);
    if (!v.ok) return err(`ideas refused:\n${v.errors.map((e) => `  ${e}`).join('\n')}`, 'refused');
    const f: IdeasFile = { snapshot: snapshotKeyOf(snap), snapshotAt: snap.at, at: now.toISOString(), ideas: rankIdeas(v.ideas, snap) };
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
    // A same-day re-research replaces the file; cited games may be gone from it.
    if (f.snapshotAt && snap.at !== f.snapshotAt)
      return err(`snapshot ${f.snapshot} was re-fetched (${snap.at}, device ${snap.device}) after these ideas were proposed — propose again so the evidence matches`, 'stale snapshot');
    const b = buildBrief(pick, snap, now);
    writeJson(P, 'brief.json', b);
    return { text: `wrote .blox/brief.json\n${briefText(b)}`, summary: `brief ${pick.id}` };
  }
  return err(`unknown action ${String(a.action)}`, 'bad action');
}
