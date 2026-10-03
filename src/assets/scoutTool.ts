import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { resultText } from '../studio/session.js';
import { longString, runLuau } from '../studio/luau.js';
import { bloxDir, readJson, writeJson } from '../state/store.js';
import type { ToolCtx, ToolOutput } from '../tools/registry.js';
import { addAsset, loadManifest, saveManifest } from './manifest.js';
import { runSanitize } from './scan.js';
import {
  adaptVerdict, findingsOf, isFreeHit, mergeResults, QUARANTINE, scoutFile, scoutQueries, SCOUT_KINDS, statsOf,
  type Ranked, type ScoutKind, type SearchHit,
} from './scout.js';

export const SCOUT_DESCRIPTION =
  'Find free Creator Store templates/packs before building a map, UI or big prop. search {need, kind: map|ui|model|audio|image, max?=8} (free only, ranked, saved) | try {asset_id, id} (insert into ServerStorage.BloxScout quarantine — scripts there never run — inspect scripts/risks/parts/GUIs/size, record a candidate in .blox/assets.json, verdict adapt / adapt-with-care / build) | adopt {id, to, keep_scripts?, unpack?} (strip scripts, move into Workspace/StarterGui/ReplicatedStorage/ServerStorage/Lighting; unpack moves its ScreenGuis, else its children) | discard {id}. Nothing is bought or uploaded.';

export const scoutShape = {
  action: z.enum(['search', 'try', 'adopt', 'discard']),
  need: z.string().optional(),
  kind: z.enum(SCOUT_KINDS as [ScoutKind, ...ScoutKind[]]).optional(),
  max: z.number().int().positive().max(20).optional(),
  asset_id: z.union([z.string(), z.number()]).optional(),
  id: z.string().optional(),
  to: z.string().optional(),
  keep_scripts: z.boolean().optional(),
  unpack: z.boolean().optional(),
};

const ADOPT_ROOTS = ['Workspace', 'StarterGui', 'ReplicatedStorage', 'ServerStorage', 'Lighting'];

interface ScoutSave {
  need: string;
  kind: ScoutKind;
  at: string;
  queries: string[];
  errors: string[];
  results: Ranked[];
}
interface TryRecord {
  need: string;
  kind: ScoutKind;
  findings: string[];
}

const err = (text: string, summary: string): ToolOutput => ({ text, isError: true, summary });

// Lua resolver for a dot path; `error`s with "not found: <path>".
const RESOLVE = `local function resolve(p)
	local cur = game
	for name in string.gmatch(p, "[^%.]+") do
		if cur == game and name == "game" then continue end
		local nxt = cur:FindFirstChild(name)
		if not nxt and cur == game then
			local ok, svc = pcall(function() return game:GetService(name) end)
			nxt = ok and svc or nil
		end
		if not nxt then error("not found: " .. p, 0) end
		cur = nxt
	end
	return cur
end`;

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

function moveLuau(from: string, to: string, unpack: boolean): string {
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

function findSaved(P: string, assetId: string): { save: ScoutSave; hit: Ranked } | null {
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
    const queries = scoutQueries(a.need, kind);
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
    if (errors.length === queries.length) return err(`search failed:\n  ${errors.join('\n  ')}`, 'failed');
    const ranked = mergeResults(per, a.need, kind);
    ensureScoutDirs(P);
    const file = scoutFile(a.need, kind);
    writeJson(P, file, { need: a.need, kind, at: new Date().toISOString(), queries: queries.map((q) => q.query), errors, results: ranked } satisfies ScoutSave);
    const max = (a.max as number | undefined) ?? 8;
    const lines = ranked.slice(0, max).map((r, i) => `${i + 1}. ${r.assetId} ${r.name} — ${r.creatorName ?? '?'} (score ${r.score}) ${r.creatorStoreUrl ?? ''}`);
    return {
      text: [
        `${ranked.length} free result(s) for "${a.need}" (${kind}); saved .blox/${file}`,
        ...lines,
        ...(errors.length ? [`query errors: ${errors.join('; ')}`] : []),
        ranked.length ? 'Next: scout {action:"try", asset_id, id} to look inside one (quarantined in ServerStorage).' : 'Nothing free found: build it, or search with other words.',
      ].join('\n'),
      summary: `${ranked.length} results`,
    };
  }

  if (a.action === 'try') {
    if (a.asset_id === undefined || typeof a.id !== 'string') return err('try needs asset_id (from a search) and id (manifest id, e.g. "obbyMap")', 'missing args');
    const assetId = String(a.asset_id);
    const id = a.id;
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) return err(`id "${id}" must start with a letter and use letters, digits, _ or -`, 'bad id');
    const found = findSaved(P, assetId);
    if (!found) return err(`asset ${assetId} is not in a saved scout search — run scout {action:"search"} first (only free results can be tried)`, 'unknown asset');
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
      id, kind: manifestKind, source: 'creator-store', licence: 'roblox-creator-store',
      ...(found.hit.creatorName ? { attribution: found.hit.creatorName } : {}),
      ref: { assetId: Number(assetId), path },
      provenance: { tool: 'scout', prompt: found.save.need, ...(found.hit.creatorStoreUrl ? { url: found.hit.creatorStoreUrl } : {}), createdAt: new Date().toISOString() },
      budget: { parts: g.stats.parts },
    });
    if (!added.ok) return err(`could not record ${id}: ${added.errors.join('; ')}`, 'invalid');
    ensureScoutDirs(P);
    writeJson(P, tryFile(id), { need: found.save.need, kind, findings: g.findings } satisfies TryRecord);
    const s = g.stats;
    return {
      text: [
        `${found.hit.name} (${assetId}) → ${path} (quarantine: scripts do not run here)`,
        `${s.parts} parts (${s.meshParts} MeshParts), ${s.guis} GUI objects in ${s.screenGuis} GUI container(s), ${s.sounds} sound(s), ${s.scripts} script(s), size ${s.size.map((x) => Math.round(x)).join(' × ')} studs`,
        ...g.findings.map((f) => `  RISK ${f}`),
        `verdict: ${v.verdict} — ${v.reasons.join('; ')}`,
        `recorded "${id}" in .blox/assets.json (candidate, creator-store licence, by ${found.hit.creatorName ?? '?'})`,
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
      return err(`"${id}" is not a scout try waiting in ${QUARANTINE}`, 'not tried');
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
    const mv = await runLuau(ctx.session, moveLuau(from, to, a.unpack === true), 'edit', { chunkName: 'scoutMove' });
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
    return {
      text: [
        `adopted ${id} → ${where} (${moved.moved} instance(s) moved; ${keep ? 'scripts kept' : `${removed} script(s) stripped`}). Now adapt it: rename, recolour, wire it to your game's code.`,
        ...(moved.left > 0 ? [`${moved.left} instance(s) that were not GUI stayed in ${from}: look at them, then scout {action:"discard", id:"${id}"} when done`] : []),
      ].join('\n'),
      summary: 'adopted',
    };
  }
  return err(`unknown action ${String(a.action)}`, 'unknown');
}
