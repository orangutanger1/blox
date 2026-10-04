import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { listZip, unzipTo } from './unzip.js';
import { basename, extname, join, relative, resolve as resolvePath } from 'node:path';
import { z } from 'zod';
import { resultText } from '../studio/session.js';
import { longString, runLuau } from '../studio/luau.js';
import { assetTag, refreshRefs, RESOLVE } from './locate.js';
import { savePack } from './packs.js';
import { bloxDir, readJson, writeJson } from '../state/store.js';
import type { ToolCtx, ToolOutput } from '../tools/registry.js';
import { addAsset, loadManifest, saveManifest, type AssetEntry } from './manifest.js';
import { runSanitize } from './scan.js';
import { formatPreview, MAX_PANELS, runPreview } from './preview.js';
import {
  adaptVerdict, findingsOf, isFreeHit, mergeResults, QUARANTINE, scoutFile, scoutQueries, SCOUT_KINDS, statsOf,
  type Ranked, type ScoutKind, type SearchHit,
} from './scout.js';
import { assetDetails, assetTypeName, devforumSearch, kindAllows, type FetchLike, type OffsiteLead } from './scoutWeb.js';

export const SCOUT_DESCRIPTION =
  'Find free packs before building a map, UI or big prop. search {need, kind: map|ui|model|audio|image, max?=8, sources?=["store","devforum"]} (Creator Store + DevForum community-resource threads, free only, ranked, saved; also lists off-site packs on itch.io/GitHub/Kenney etc. to import) | import {url or file, id, kind, licence: cc0|cc-by|owned|unknown, source_url, attribution?, pick?} (download/copy a free pack file — .rbxm/.fbx/.glb/.png, or a .zip then pick one file inside — into assets/vendor/<id>, record a candidate; a human approves and uploads it, then try its uploaded asset id) | try {asset_id, id, kind?} (any free Creator Store id — from search, a forum post or the web — or one of your uploaded imports; (insert into ServerStorage.BloxScout quarantine — scripts there never run — inspect scripts/risks/parts/GUIs/size, record a candidate in .blox/assets.json, verdict adapt / adapt-with-care / build) | adopt {id, to, keep_scripts?, unpack?} (strip scripts, move into Workspace/StarterGui/ReplicatedStorage/ServerStorage/Lighting; unpack moves its ScreenGuis, else its children) | preview {id or path, panels?, show_all?, max?=12} (for UI packs: one playtest that shows each panel — a GuiObject directly under a ScreenGui, Folder or the pack root — alone, centred, made visible, sized if it had no size, and returns a screenshot of each; use it after try, before judging or adopting, and when building menus from a pack) | discard {id}. Nothing is bought or uploaded.';

export const scoutShape = {
  action: z.enum(['search', 'try', 'adopt', 'discard', 'import', 'preview']),
  path: z.string().optional(),
  panels: z.array(z.string()).optional(),
  show_all: z.boolean().optional(),
  need: z.string().optional(),
  kind: z.enum(SCOUT_KINDS as [ScoutKind, ...ScoutKind[]]).optional(),
  max: z.number().int().positive().max(20).optional(),
  asset_id: z.union([z.string(), z.number()]).optional(),
  id: z.string().optional(),
  to: z.string().optional(),
  keep_scripts: z.boolean().optional(),
  unpack: z.boolean().optional(),
  sources: z.array(z.enum(['store', 'devforum'])).optional(),
  url: z.string().optional(),
  file: z.string().optional(),
  licence: z.enum(['cc0', 'cc-by', 'owned', 'unknown']).optional(),
  source_url: z.string().optional(),
  attribution: z.string().optional(),
  pick: z.string().optional(),
};

const ADOPT_ROOTS = ['Workspace', 'StarterGui', 'ReplicatedStorage', 'ServerStorage', 'Lighting'];

interface ScoutSave {
  need: string;
  kind: ScoutKind;
  at: string;
  queries: string[];
  errors: string[];
  results: (Ranked & { sourceUrl?: string; licenceNote?: string })[];
  offsite?: OffsiteLead[];
}
interface TryRecord {
  need: string;
  kind: ScoutKind;
  findings: string[];
}

const err = (text: string, summary: string): ToolOutput => ({ text, isError: true, summary });


function quarantineLuau(name: string): string {
  return `local f = game:GetService("ServerStorage"):FindFirstChild("BloxScout")
if not f then
	f = Instance.new("Folder")
	f.Name = "BloxScout"
	f.Parent = game:GetService("ServerStorage")
end
local old = f:FindFirstChild(${longString(name)})
if old then old:Destroy() end
return "ok"`;
}

function moveLuau(from: string, to: string, unpack: boolean, tag: string): string {
  return `-- BLOX_SCOUT_MOVE
local HttpService = game:GetService("HttpService")
${RESOLVE}
local src, dst = resolve(${longString(from)}), resolve(${longString(to)})
local items = { src }
if ${unpack ? 'true' : 'false'} then
	-- GUI packs often nest their ScreenGui inside wrapper Models: move the
	-- top-most GUI containers when there are any, else the direct children.
	items = {}
	for _, d in src:GetDescendants() do
		if d:IsA("LayerCollector") and not d:FindFirstAncestorWhichIsA("LayerCollector") then table.insert(items, d) end
	end
	if #items == 0 then items = src:GetChildren() end
end
for _, c in items do
	if dst:FindFirstChild(c.Name) then error(dst:GetFullName() .. " already has " .. c.Name, 0) end
end
local paths = {}
for _, c in items do
	c.Parent = dst
	c:AddTag(${longString(tag)})
	table.insert(paths, c:GetFullName())
end
-- Unpacking leaves what it did not move (non-GUI parts of a GUI pack) in the
-- quarantine rather than destroying it unseen.
local left = 0
if ${unpack ? 'true' : 'false'} then
	left = #src:GetDescendants()
	if left == 0 then src:Destroy() end
end
return HttpService:JSONEncode({ paths = paths, moved = #items, left = left })`;
}

function discardLuau(path: string): string {
  // Walk the path below the quarantine folder; anything else is refused.
  const rel = path.startsWith(`${QUARANTINE}.`) ? path.slice(QUARANTINE.length + 1) : '';
  return `-- BLOX_SCOUT_DISCARD
local x = game:GetService("ServerStorage"):FindFirstChild("BloxScout")
local rel = ${longString(rel)}
if rel == "" then return "gone" end
for name in string.gmatch(rel, "[^%.]+") do
	x = x and x:FindFirstChild(name)
end
if x then x:Destroy() return "destroyed" end
return "gone"`;
}

const tryFile = (id: string) => `scout/tried/${id}.json`;
function ensureScoutDirs(P: string) {
  mkdirSync(join(bloxDir(P), 'scout', 'tried'), { recursive: true });
}

type Found = { save: Pick<ScoutSave, 'need' | 'kind'>; hit: SearchHit; imported?: { source: 'external'; licence: AssetEntry['licence']; attribution?: string } };

const fetchOf = (ctx: ToolCtx): FetchLike => ctx.fetch ?? (globalThis.fetch as unknown as FetchLike);

// An id found outside a saved search (a forum post, a web page, the user): try
// it when it is one of this project's uploaded imports, or when the economy API
// says it is free and of a type this kind can use.
async function directHit(P: string, assetId: string, a: Record<string, unknown>, fetch: FetchLike): Promise<Found | { error: string; summary: string }> {
  const kind = (typeof a.kind === 'string' ? a.kind : undefined) as ScoutKind | undefined;
  const need = typeof a.need === 'string' && a.need.trim() ? a.need : `asset ${assetId}`;
  const imp = loadManifest(P).assets.find((x) => x.uploaded?.assetId === Number(assetId) && x.source === 'external');
  if (imp) {
    const k: ScoutKind = kind ?? (imp.kind === 'image' ? 'image' : imp.kind === 'audio' ? 'audio' : 'model');
    return {
      save: { need: imp.provenance.prompt ?? need, kind: k },
      hit: { assetId, name: imp.id, assetType: imp.kind === 'image' ? 'Image' : imp.kind === 'audio' ? 'Audio' : 'Model', isFree: true, priceCents: 0, ...(imp.provenance.url ? { creatorStoreUrl: imp.provenance.url } : {}) },
      imported: { source: 'external', licence: imp.licence, ...(imp.attribution ? { attribution: imp.attribution } : {}) },
    };
  }
  let d;
  try {
    d = await assetDetails(assetId, fetch);
  } catch (e) {
    return { error: `could not look up asset ${assetId}: ${(e as Error).message}`, summary: 'lookup failed' };
  }
  if (!d) return { error: `asset ${assetId} was not found on Roblox`, summary: 'unknown asset' };
  if (!d.free) return { error: `asset ${assetId} (${d.name}) is not free — scout never buys`, summary: 'not free' };
  const k: ScoutKind = kind ?? (d.assetTypeId === 3 ? 'audio' : d.assetTypeId === 1 || d.assetTypeId === 13 ? 'image' : 'model');
  if (!kindAllows(k, d.assetTypeId)) return { error: `asset ${assetId} (${d.name}) is a ${assetTypeName(d.assetTypeId)} (type ${d.assetTypeId}), not usable as ${k} — plugins and other types are not packs`, summary: 'wrong type' };
  return {
    save: { need, kind: k },
    hit: { assetId, name: d.name, creatorName: d.creatorName, assetType: assetTypeName(d.assetTypeId), isFree: true, priceCents: 0, creatorStoreUrl: `https://create.roblox.com/store/asset/${assetId}` },
  };
}

const IMPORT_EXT: Record<string, AssetEntry['kind']> = {
  '.rbxm': 'model', '.fbx': 'mesh', '.glb': 'mesh', '.gltf': 'mesh', '.obj': 'mesh',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.tga': 'image', '.bmp': 'image',
  '.mp3': 'audio', '.ogg': 'audio', '.wav': 'audio', '.flac': 'audio',
};
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
// Hosts whose files sit behind a browser-only download button.
const BROWSER_ONLY = ['itch.io', 'gumroad.com', 'mega.nz', 'patreon.com'];
const SCOUT_CACHE = join(tmpdir(), 'blox-scout-cache');
const LICENCE_FILE = /^(licen[cs]e|copying|credits?|attribution)\b[^/]*\.(txt|md)$|^(licen[cs]e|copying)$/i;


// Bring a free pack file from the web (or disk) into the project: assets/vendor/<id>.
// A zip is unpacked and listed; pick names the file to record. Nothing is
// uploaded here — the entry is a candidate a human approves and uploads.
async function importPack(a: Record<string, unknown>, P: string, fetch: FetchLike): Promise<ToolOutput> {
  const id = a.id;
  if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) return err('import needs id (letters, digits, _ or -, starting with a letter)', 'bad id');
  if (typeof a.url !== 'string' && typeof a.file !== 'string') return err('import needs url (a direct file link) or file (a path in the project)', 'no source');
  if (typeof a.licence !== 'string') return err('import needs licence: cc0 | cc-by | owned | unknown — read it on the pack page first; unknown cannot be approved for release', 'no licence');
  if (typeof a.source_url !== 'string' && typeof a.url !== 'string') return err('import needs source_url (the page that states the licence)', 'no source_url');
  if (loadManifest(P).assets.some((x) => x.id === id)) return err(`asset id "${id}" is already in .blox/assets.json — pick another id`, 'id taken');
  const dir = join(P, 'assets', 'vendor', id);
  const manual = (why: string) => [
    why,
    `Download it by hand: open ${a.url ?? a.source_url} in a browser, download the file, save it in the project (e.g. assets/vendor/${id}/), then`,
    `  scout {action:"import", file:"assets/vendor/${id}/<file>", id:"${id}", licence:"${a.licence}", source_url:"${a.source_url ?? a.url}"}`,
    `  (CLI: blox scout import <file> --id ${id} --licence ${a.licence} --source-url ${a.source_url ?? a.url})`,
  ].join('\n');
  let got: string;
  let buf: Buffer;
  if (typeof a.url === 'string') {
    if (!/^https:\/\//.test(a.url)) return err('import url must be https://', 'bad url');
    const host = new URL(a.url).hostname;
    if (BROWSER_ONLY.some((h) => host === h || host.endsWith(`.${h}`))) {
      return err(manual(`${host} only serves downloads through its download button in a browser, so blox cannot fetch it.`), 'needs browser');
    }
    // Downloads are cached outside the project: listing a zip, then importing
    // files from it one pick at a time, leaves nothing unrecorded behind.
    const cached = join(SCOUT_CACHE, createHash('sha1').update(a.url).digest('hex') + extname(new URL(a.url).pathname).toLowerCase());
    if (existsSync(cached)) buf = readFileSync(cached);
    else {
      let r: Awaited<ReturnType<FetchLike>> & { arrayBuffer?: () => Promise<ArrayBuffer>; headers?: { get(n: string): string | null } };
      try {
        r = await fetch(a.url, { headers: { 'User-Agent': 'blox-scout' } });
      } catch (e) {
        return err(`download failed: ${(e as Error).message}`, 'download failed');
      }
      if (!r.ok || !r.arrayBuffer) return err(manual(`download failed: HTTP ${r.status}. A page behind a login or a download button needs a person to download it.`), 'download failed');
      buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_IMPORT_BYTES) return err(`download is ${Math.round(buf.length / 1e6)} MB (cap ${MAX_IMPORT_BYTES / 1e6} MB)`, 'too big');
      const head = buf.subarray(0, 64).toString('utf8').toLowerCase();
      if (head.includes('<!doctype html') || head.includes('<html')) return err(manual('that url returned a web page, not a file. Find the direct file link, or:'), 'not a file');
      mkdirSync(SCOUT_CACHE, { recursive: true });
      writeFileSync(cached, buf);
    }
    got = basename(new URL(a.url).pathname) || `${id}.bin`;
  } else {
    const src = resolvePath(P, a.file as string);
    if (!existsSync(src)) return err(`no file ${a.file}`, 'no file');
    got = src;
    buf = readFileSync(src);
  }
  const isZip = extname(got).toLowerCase() === '.zip';
  let usable: string[];
  if (isZip) {
    try {
      usable = listZip(buf).filter((f) => IMPORT_EXT[extname(f).toLowerCase()]);
    } catch (e) {
      return err(`could not read ${basename(got)}: ${(e as Error).message}`, 'unzip failed');
    }
  } else usable = IMPORT_EXT[extname(got).toLowerCase()] ? [got] : [];
  const pick = typeof a.pick === 'string' ? usable.find((f) => f === a.pick || f.endsWith(`/${a.pick}`)) : usable.length === 1 ? usable[0] : undefined;
  if (!pick) {
    const src = typeof a.url === 'string' ? `url:"${a.url}"` : `file:"${a.file}"`;
    return {
      text: [
        `${usable.length} usable file(s) in ${basename(got)}${usable.length ? '' : ' — none with a known extension (.rbxm .fbx .glb .gltf .obj .png .jpg .mp3 .ogg …)'}${typeof a.pick === 'string' ? ` (none matches pick "${a.pick}")` : ''}:`,
        ...usable.slice(0, 60).map((f) => `  ${f}`),
        ...(usable.length > 60 ? [`  … ${usable.length - 60} more`] : []),
        usable.length ? `Next: scout {action:"import", ${src}, pick:"<one of these>", id:"<new id>", licence, source_url} for each file you want (nothing is unpacked until you pick).` : '',
      ].filter(Boolean).join('\n'),
      isError: typeof a.pick === 'string',
      summary: `${usable.length} files`,
    };
  }
  let file: string;
  if (isZip) {
    // The picked file, plus the pack's licence file so the terms travel with it.
    const keep = (n: string) => n === pick || LICENCE_FILE.test(basename(n));
    try {
      unzipTo(buf, dir, { only: keep, flat: true });
    } catch (e) {
      return err(`could not unzip ${basename(got)}: ${(e as Error).message}`, 'unzip failed');
    }
    file = relative(P, join(dir, basename(pick)));
  } else if (typeof a.url === 'string') {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, got), buf);
    file = relative(P, join(dir, got));
  } else file = relative(P, got);
  const kind = IMPORT_EXT[extname(pick).toLowerCase()];
  const added = addAsset(P, {
    id, kind, source: 'external', licence: a.licence,
    ...(typeof a.attribution === 'string' ? { attribution: a.attribution } : {}),
    ref: { file: file.split('\\').join('/') },
    provenance: { tool: 'scout', prompt: `import ${a.url ?? a.file}`, ...(typeof a.source_url === 'string' ? { url: a.source_url } : typeof a.url === 'string' ? { url: a.url } : {}), createdAt: new Date().toISOString() },
  });
  if (!added.ok) return err(`could not record ${id}: ${added.errors.join('; ')}`, 'invalid');
  const next = kind === 'mesh'
    ? `A mesh: run asset {action:"normalize", file:"${file}"} (scale/axis/colours) before upload, or open it in the model tool.`
    : kind === 'image'
      ? 'An image: after upload use its asset id in ImageLabel.Image / Decal.Texture.'
      : `A model: after upload, scout {action:"try", asset_id:<uploaded id>, id:"${id}Try"} quarantines and sanitizes it like any pack.`;
  return {
    text: [
      `imported ${file} as "${id}" (${kind}, licence ${a.licence}${typeof a.attribution === 'string' ? `, by ${a.attribution}` : ''}) — candidate in .blox/assets.json`,
      `A human must approve it (\`blox asset approve ${id}\`) before asset {action:"upload", id:"${id}", confirm:true}.`,
      next,
    ].join('\n'),
    summary: 'imported',
  };
}

function findSaved(P: string, assetId: string): Found | null {
  const dir = join(bloxDir(P), 'scout');
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  for (const f of files) {
    const save = readJson<ScoutSave>(P, `scout/${f}`);
    const hit = save?.results?.find((r) => r.assetId === assetId);
    if (save && hit) return { save, hit };
  }
  return null;
}

export async function scoutTool(a: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutput> {
  const P = ctx.projectPath;

  if (a.action === 'search') {
    if (typeof a.need !== 'string' || !a.need.trim()) return err('search needs need (e.g. "obby") and kind (map|ui|model|audio|image)', 'no need');
    if (typeof a.kind !== 'string') return err('search needs kind: map | ui | model | audio | image', 'no kind');
    const kind = a.kind as ScoutKind;
    const sources = (a.sources as string[] | undefined) ?? ['store', 'devforum'];
    const queries = sources.includes('store') ? scoutQueries(a.need, kind) : [];
    const per: SearchHit[][] = [];
    const errors: string[] = [];
    for (const q of queries) {
      const r = await ctx.session.call('search_asset', { query: q.query, scope: 'creator_store', priceFilter: 'free', maxResults: 10, ...(q.assetType ? { assetType: q.assetType } : {}) }, 60_000);
      const text = resultText(r);
      try {
        if (r.isError) throw new Error(text.slice(0, 200));
        const j = JSON.parse(text) as { results?: SearchHit[] };
        per.push((j.results ?? []).map((h) => ({ ...h, assetId: String(h.assetId) })));
      } catch (e) {
        errors.push(`${q.query}: ${(e as Error).message}`);
      }
    }
    let offsite: OffsiteLead[] = [];
    let forumOk = false;
    if (sources.includes('devforum')) {
      try {
        const w = await devforumSearch(a.need, kind, fetchOf(ctx));
        per.push(w.hits);
        offsite = w.offsite;
        errors.push(...w.errors);
        forumOk = true;
      } catch (e) {
        errors.push(`devforum: ${(e as Error).message}`);
      }
    }
    if (!forumOk && per.length === 0) return err(`search failed:\n  ${errors.join('\n  ')}`, 'failed');
    const ranked = mergeResults(per, a.need, kind);
    ensureScoutDirs(P);
    const file = scoutFile(a.need, kind);
    writeJson(P, file, { need: a.need, kind, at: new Date().toISOString(), queries: queries.map((q) => q.query), errors, results: ranked, offsite } satisfies ScoutSave);
    const max = (a.max as number | undefined) ?? 8;
    const lines = (ranked as ScoutSave['results']).slice(0, max).map((r, i) =>
      `${i + 1}. ${r.assetId} ${r.name} — ${r.creatorName ?? '?'} (score ${r.score}) ${r.sourceUrl ? `[devforum ${r.sourceUrl}]${r.licenceNote ? ` terms: "${r.licenceNote}"` : ''}` : r.creatorStoreUrl ?? ''}`);
    const off = offsite.slice(0, 5).map((o) => `  - ${o.title} ${o.links.join(' ')} [${o.sourceUrl}]${o.licenceNote ? ` terms: "${o.licenceNote}"` : ''}`);
    return {
      text: [
        `${ranked.length} free result(s) for "${a.need}" (${kind}) from ${sources.join(' + ')}; saved .blox/${file}`,
        ...lines,
        ...(off.length ? ['off-site packs (not Creator Store assets; check the licence on the page, then scout {action:"import", url, ...} a direct file link):', ...off] : []),
        ...(errors.length ? [`query errors: ${errors.join('; ')}`] : []),
        ranked.length ? 'Next: scout {action:"try", asset_id, id} to look inside one (quarantined in ServerStorage).' : 'Nothing free found: build it, or search with other words.',
      ].join('\n'),
      summary: `${ranked.length} results`,
    };
  }

  if (a.action === 'import') return importPack(a, P, fetchOf(ctx));

  if (a.action === 'preview') {
    if (typeof a.id === 'string' && typeof a.path !== 'string' && loadManifest(P).assets.some((x) => x.id === a.id)) await refreshRefs(ctx.session, P, [a.id]);
    const e = typeof a.id === 'string' ? loadManifest(P).assets.find((x) => x.id === a.id) : undefined;
    const path = typeof a.path === 'string' ? a.path.replace(/^game\./, '') : e?.ref.path;
    if (!path) return err(typeof a.id === 'string' && !e ? `no asset "${a.id}" in .blox/assets.json — pass path` : 'preview needs id (a tried/adopted asset) or path', 'no path');
    const id = typeof a.id === 'string' ? a.id : path.split('.').pop()!;
    const r = await runPreview(ctx.session, P, {
      id, path,
      ...(Array.isArray(a.panels) ? { panels: a.panels as string[] } : {}),
      showAll: a.show_all === true,
      max: typeof a.max === 'number' ? Math.min(a.max, MAX_PANELS) : MAX_PANELS,
    });
    const shots = r.shots.filter((s) => s.screenshot);
    return {
      text: formatPreview(id, path, r),
      images: shots.map((s) => ({ data: s.screenshot!.data, mimeType: s.screenshot!.mimeType })),
      artifacts: shots.map((s) => s.screenshot!.path),
      isError: r.shots.length > 0 && shots.length === 0,
      summary: `${shots.length}/${r.shots.length} panels`,
    };
  }

  if (a.action === 'try') {
    if (a.asset_id === undefined || typeof a.id !== 'string') return err('try needs asset_id (from a search) and id (manifest id, e.g. "obbyMap")', 'missing args');
    const assetId = String(a.asset_id);
    const id = a.id;
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) return err(`id "${id}" must start with a letter and use letters, digits, _ or -`, 'bad id');
    let found = findSaved(P, assetId);
    if (!found) {
      const direct = await directHit(P, assetId, a, fetchOf(ctx));
      if ('error' in direct) return err(direct.error, direct.summary);
      found = direct;
    }
    if (!isFreeHit(found.hit)) return err(`asset ${assetId} is not free — scout never buys`, 'not free');
    if (loadManifest(P).assets.some((x) => x.id === id)) return err(`asset id "${id}" is already in .blox/assets.json — pick another id`, 'id taken');
    const q = await runLuau(ctx.session, quarantineLuau(id), 'edit', { chunkName: 'scoutQuarantine' });
    if (!q.ok) return err(`could not prepare ${QUARANTINE}: ${q.error?.message}`, 'failed');
    const ins = await ctx.session.call('insert_asset', { assetId, assetType: found.hit.assetType ?? 'Model', assetName: id, parentPath: QUARANTINE }, 120_000);
    const insText = resultText(ins);
    let path: string;
    try {
      if (ins.isError) throw new Error(insText.slice(0, 300));
      const j = JSON.parse(insText) as { status?: string; insertedInstances?: { fullPath: string }[] };
      const first = j.insertedInstances?.[0]?.fullPath;
      if (!first) throw new Error(`nothing inserted (${j.status ?? 'no status'})`);
      path = first.replace(/^game\./, '');
    } catch (e) {
      return err(`insert of ${assetId} failed: ${(e as Error).message}\nTry the next search result.`, 'insert failed');
    }
    let rep;
    try {
      rep = await runSanitize(ctx.session, path, true);
    } catch (e) {
      return err(`inspect failed: ${(e as Error).message} (the copy is in ${path}; discard it with scout {action:"discard", id:"${id}"})`, 'failed');
    }
    const g = { stats: statsOf(rep), findings: findingsOf(rep) };
    const kind = found.save.kind;
    const v = adaptVerdict(kind, g.stats, g.findings);
    const manifestKind = kind === 'audio' ? 'audio' : kind === 'image' ? 'image' : 'model';
    const added = addAsset(P, {
      id, kind: manifestKind, source: found.imported?.source ?? 'creator-store', licence: found.imported?.licence ?? 'roblox-creator-store',
      ...(found.imported?.attribution ?? found.hit.creatorName ? { attribution: found.imported?.attribution ?? found.hit.creatorName } : {}),
      ref: { assetId: Number(assetId), path, tag: assetTag(id) },
      provenance: { tool: 'scout', prompt: found.save.need, ...((found.hit as { sourceUrl?: string }).sourceUrl ?? found.hit.creatorStoreUrl ? { url: (found.hit as { sourceUrl?: string }).sourceUrl ?? found.hit.creatorStoreUrl } : {}), createdAt: new Date().toISOString() },
      budget: { parts: g.stats.parts },
    });
    if (!added.ok) return err(`could not record ${id}: ${added.errors.join('; ')}`, 'invalid');
    // Tag the copy so the entry follows it through renames and moves.
    const tagged = await runLuau(ctx.session, `${RESOLVE}\nresolve(${longString(path)}):AddTag(${longString(assetTag(id))})\nreturn "ok"`, 'edit', { chunkName: 'scoutTag' });
    if (!tagged.ok) return err(`could not tag ${path}: ${tagged.error?.message}`, 'failed');
    ensureScoutDirs(P);
    writeJson(P, tryFile(id), { need: found.save.need, kind, findings: g.findings } satisfies TryRecord);
    const s = g.stats;
    return {
      text: [
        `${found.hit.name} (${assetId}) → ${path} (quarantine: scripts do not run here)`,
        `${s.parts} parts (${s.meshParts} MeshParts), ${s.guis} GUI objects in ${s.screenGuis} GUI container(s), ${s.sounds} sound(s), ${s.scripts} script(s), size ${s.size.map((x) => Math.round(x)).join(' × ')} studs`,
        ...g.findings.map((f) => `  RISK ${f}`),
        `verdict: ${v.verdict} — ${v.reasons.join('; ')}`,
        `recorded "${id}" in .blox/assets.json (candidate, ${found.imported?.licence ?? 'creator-store'} licence, by ${found.imported?.attribution ?? found.hit.creatorName ?? '?'})`,
        v.verdict === 'build'
          ? `Next: scout {action:"discard", id:"${id}"} and build it, or try another result.`
          : `Next: scout {action:"adopt", id:"${id}", to:"${kind === 'ui' ? 'StarterGui' : 'Workspace'}"${kind === 'ui' ? ', unpack:true' : ''}} to use it, or discard.`,
      ].join('\n'),
      summary: v.verdict,
    };
  }

  if (a.action === 'adopt' || a.action === 'discard') {
    if (typeof a.id !== 'string') return err(`${a.action} needs id`, 'no id');
    const id = a.id;
    // The agent may have renamed or moved the copy since the try.
    if (loadManifest(P).assets.some((x) => x.id === id)) await refreshRefs(ctx.session, P, [id]);
    const m = loadManifest(P);
    const e = m.assets.find((x) => x.id === id);
    const rec = readJson<TryRecord>(P, tryFile(id));
    if (a.action === 'discard' && !e && /^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) {
      // try inserted the copy but failed before recording it.
      const r = await runLuau(ctx.session, discardLuau(`${QUARANTINE}.${id}`), 'edit', { chunkName: 'scoutDiscard' });
      if (!r.ok) return err(`discard failed: ${r.error?.message}`, 'failed');
      return { text: `no manifest entry "${id}"; quarantine copy ${r.values[0] === 'destroyed' ? 'removed' : 'was already gone'}`, summary: 'discarded' };
    }
    if (!e || e.provenance.tool !== 'scout' || !rec || !e.ref.path?.startsWith(`${QUARANTINE}.`)) {
      return err(`"${id}" is not a scout try waiting in ${QUARANTINE}${e?.ref.path ? ` (it is at ${e.ref.path})` : ''}`, 'not tried');
    }
    const from = e.ref.path;
    if (a.action === 'discard') {
      const r = await runLuau(ctx.session, discardLuau(from), 'edit', { chunkName: 'scoutDiscard' });
      if (!r.ok) return err(`discard failed: ${r.error?.message}`, 'failed');
      e.status = 'rejected';
      delete e.ref.path;
      saveManifest(P, m);
      return { text: `discarded ${id}: quarantine copy removed, manifest entry marked rejected`, summary: 'discarded' };
    }
    if (typeof a.to !== 'string') return err(`adopt needs to (one of ${ADOPT_ROOTS.join(', ')}, or a path under one)`, 'no to');
    const to = a.to.replace(/^game\./, '').split('.').map((x) => x.trim()).filter(Boolean).join('.');
    if (!ADOPT_ROOTS.includes(to.split('.')[0]) || to.startsWith(QUARANTINE)) return err(`adopt to must be under ${ADOPT_ROOTS.join(', ')} (not the quarantine)`, 'bad to');
    const keep = a.keep_scripts === true;
    if (keep && rec.findings.length) return err(`keep_scripts refused: ${rec.findings.length} risk finding(s):\n  ${rec.findings.join('\n  ')}\nAdopt without keep_scripts (scripts are stripped) or discard.`, 'risky');
    let g;
    try {
      g = await runSanitize(ctx.session, from, keep);
    } catch (e) {
      return err(`sanitize failed: ${(e as Error).message}`, 'failed');
    }
    // Record the sanitize before moving: a failed move leaves the copy
    // stripped, and a retry would otherwise record 0 scripts removed.
    const m1 = loadManifest(P);
    const e1 = m1.assets.find((x) => x.id === id)!;
    const removedBefore = e1.sanitized && e1.ref.path === from ? e1.sanitized.scriptsRemoved : 0;
    const removed = removedBefore + g.removed;
    e1.sanitized = { at: new Date().toISOString(), scriptsRemoved: removed, findings: [...new Set([...(e1.ref.path === from ? e1.sanitized?.findings ?? [] : []), ...findingsOf(g)])] };
    e1.budget = { ...(e1.budget ?? {}), parts: g.parts };
    saveManifest(P, m1);
    const mv = await runLuau(ctx.session, moveLuau(from, to, a.unpack === true, e1.ref.tag ?? assetTag(id)), 'edit', { chunkName: 'scoutMove' });
    if (!mv.ok) return err(`move failed: ${mv.error?.message} (scripts ${keep ? 'kept' : `stripped: ${removed}`}; the copy is still in ${QUARANTINE})`, 'failed');
    let moved: { paths: string[]; moved: number; left: number };
    try {
      moved = JSON.parse(String(mv.values[0])) as typeof moved;
    } catch {
      return err(`move reply was not JSON: ${String(mv.values[0]).slice(0, 200)}`, 'failed');
    }
    const m2 = loadManifest(P);
    const e2 = m2.assets.find((x) => x.id === id)!;
    if (moved.left > 0) e2.ref.path = from;
    else e2.ref.path = moved.paths.length === 1 ? moved.paths[0].replace(/^game\./, '') : to;
    saveManifest(P, m2);
    const where = moved.paths.map((x) => x.replace(/^game\./, '')).join(', ');
    // A first copy on disk, so a lost place file does not lose the pack.
    let saved: string;
    try {
      saved = moved.left > 0 ? '' : `saved to ${(await savePack(ctx.session, P, id)).file}; asset {action:"save", id:"${id}"} again after adapting it`;
    } catch (e) {
      saved = `not saved to disk (${(e as Error).message}); asset {action:"save", id:"${id}"} later`;
    }
    return {
      text: [
        `adopted ${id} → ${where} (${moved.moved} instance(s) moved; ${keep ? 'scripts kept' : `${removed} script(s) stripped`}). Now adapt it: rename, recolour, wire it to your game's code.`,
        ...(moved.left > 0 ? [`${moved.left} instance(s) that were not GUI stayed in ${from}: look at them, then scout {action:"discard", id:"${id}"} when done`] : [saved]),
      ].join('\n'),
      summary: 'adopted',
    };
  }
  return err(`unknown action ${String(a.action)}`, 'unknown');
}
