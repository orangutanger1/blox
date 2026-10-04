import type { ScoutKind, SearchHit } from './scout.js';

// Scout beyond the Creator Store search box: community packs are announced on
// the DevForum (Community Resources) and link a Creator Store asset. Search the
// forum's public JSON API, pull the asset ids each thread links, and keep only
// the ones the Roblox economy API says are free (public domain). Deterministic
// HTTP from blox — the agent itself never gets a general web fetch.

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const FORUM = 'https://devforum.roblox.com';
const UA = { 'User-Agent': 'blox-scout (+https://github.com/orangutanger1/blox)', Accept: 'application/json' };
const MAX_TOPICS = 8;
const MAX_IDS_PER_TOPIC = 4;

// Roblox AssetTypeIds a scout kind may adopt: Image 1, Audio 3, Decal 13,
// Model 10, MeshPart 40. Plugins (38) and anything else are not insertable packs.
const KIND_TYPES: Record<ScoutKind, number[]> = {
  map: [10], ui: [10], model: [10, 40], audio: [3], image: [1, 13],
};
const TYPE_NAMES: Record<number, string> = { 1: 'Image', 3: 'Audio', 10: 'Model', 13: 'Decal', 40: 'MeshPart' };

const KIND_QUERY: Record<ScoutKind, string> = {
  map: 'map', ui: 'ui', model: 'pack', audio: 'sound', image: 'icons',
};

export interface AssetDetails {
  assetId: string;
  name: string;
  description: string;
  creatorName: string;
  assetTypeId: number;
  free: boolean;
}

export async function assetDetails(assetId: string, fetch: FetchLike): Promise<AssetDetails | null> {
  const r = await fetch(`https://economy.roblox.com/v2/assets/${assetId}/details`, { headers: UA });
  if (!r.ok) return null;
  const d = (await r.json()) as {
    Name?: string; Description?: string; AssetTypeId?: number; IsPublicDomain?: boolean;
    IsForSale?: boolean; PriceInRobux?: number | null; Creator?: { Name?: string };
  };
  if (typeof d.AssetTypeId !== 'number') return null;
  return {
    assetId,
    name: d.Name ?? '',
    description: d.Description ?? '',
    creatorName: d.Creator?.Name ?? '',
    assetTypeId: d.AssetTypeId,
    // Free Creator Store models are "public domain" in the economy API; a paid
    // or off-sale asset is not, whatever its price field says.
    free: d.IsPublicDomain === true && !(d.PriceInRobux && d.PriceInRobux > 0),
  };
}

export const kindAllows = (kind: ScoutKind, assetTypeId: number) => KIND_TYPES[kind].includes(assetTypeId);
export const assetTypeName = (assetTypeId: number) => TYPE_NAMES[assetTypeId] ?? 'Model';

// Asset ids a post links: store/library/catalog links (not rbxassetid://, which
// in forum posts is mostly screenshots and icons).
export function linkedAssetIds(cooked: string): string[] {
  const ids: string[] = [];
  for (const m of cooked.matchAll(/(?:create\.roblox\.com\/(?:[a-z-]+\/)?store\/asset|roblox\.com\/library|roblox\.com\/catalog)\/(\d{5,})/g)) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

// The sentence of the post that states terms ("free to use", "credit", "do not
// sell"), so the agent and the manifest carry the author's own words.
export function licenceNote(cooked: string): string | undefined {
  const text = cooked.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ');
  const m = /\b(free to use|free for|credit|licen[cs]e|do not (re)?sell|don'?t (re)?sell|commercial|open[- ]source|cc0|public domain)\b/i.exec(text);
  if (!m) return undefined;
  // Posts list contents without full stops: take the words around the match.
  const start = Math.max(0, text.lastIndexOf('.', m.index) + 1, m.index - 80);
  const dot = text.indexOf('.', m.index);
  const end = Math.min(text.length, dot === -1 ? m.index + 140 : dot + 1, m.index + 140);
  return text.slice(start, end).trim();
}

// Download hosts packs are shared on when they are not a Creator Store asset.
export function offsiteLinks(cooked: string): string[] {
  const out: string[] = [];
  for (const m of cooked.matchAll(/href="(https?:\/\/(?:[a-z0-9-]+\.)?(?:itch\.io|github\.com|gitlab\.com|kenney\.nl|quaternius\.com|poly\.pizza|opengameart\.org|ambientcg\.com|polyhaven\.com|gumroad\.com|sketchfab\.com)\/[^"#]*)"/gi)) {
    const u = m[1].replace(/&amp;/g, '&');
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

export interface OffsiteLead {
  title: string;
  sourceUrl: string;
  links: string[];
  licenceNote?: string;
}

export interface WebHit extends SearchHit {
  sourceUrl: string;
}

export async function devforumSearch(need: string, kind: ScoutKind, fetch: FetchLike): Promise<{ hits: WebHit[]; offsite: OffsiteLead[]; errors: string[] }> {
  const errors: string[] = [];
  // The need's own words first; when that finds little, the kind's generic
  // pack search ("ui pack", "map pack"), which is how most packs are titled.
  const topics: { id: number; slug: string; title: string }[] = [];
  for (const words of [`${need} ${KIND_QUERY[kind]}`, `${KIND_QUERY[kind]} pack`]) {
    const sr = await fetch(`${FORUM}/search.json?q=${encodeURIComponent(`${words} #community-resources`)}`, { headers: UA });
    if (!sr.ok) {
      errors.push(`devforum search "${words}": HTTP ${sr.status}`);
      continue;
    }
    for (const t of ((await sr.json()) as { topics?: typeof topics }).topics ?? []) if (!topics.some((x) => x.id === t.id)) topics.push(t);
  }
  const hits: WebHit[] = [];
  const offsite: OffsiteLead[] = [];
  const seen = new Set<string>();
  for (const t of topics.slice(0, MAX_TOPICS)) {
    const url = `${FORUM}/t/${t.slug}/${t.id}`;
    try {
      const tr = await fetch(`${FORUM}/t/${t.id}.json`, { headers: UA });
      if (!tr.ok) throw new Error(`HTTP ${tr.status}`);
      const cooked = ((await tr.json()) as { post_stream?: { posts?: { cooked?: string }[] } }).post_stream?.posts?.[0]?.cooked ?? '';
      const note = licenceNote(cooked);
      let found = 0;
      for (const id of linkedAssetIds(cooked).slice(0, MAX_IDS_PER_TOPIC)) {
        if (seen.has(id)) continue;
        seen.add(id);
        const d = await assetDetails(id, fetch);
        if (!d || !d.free || !kindAllows(kind, d.assetTypeId)) continue;
        hits.push({
          assetId: id, name: d.name || t.title, description: d.description, creatorName: d.creatorName,
          assetType: assetTypeName(d.assetTypeId), isFree: true, priceCents: 0,
          creatorStoreUrl: `https://create.roblox.com/store/asset/${id}`, sourceUrl: url, ...(note ? { licenceNote: note } : {}),
        });
        found++;
      }
      const links = offsiteLinks(cooked);
      if (!found && links.length) offsite.push({ title: t.title, sourceUrl: url, links: links.slice(0, 3), ...(note ? { licenceNote: note } : {}) });
    } catch (e) {
      errors.push(`devforum ${url}: ${(e as Error).message}`);
    }
  }
  return { hits, offsite, errors };
}
