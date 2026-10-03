import { longString } from '../studio/luau.js';
import { riskFindings } from './scan.js';

// Template scout: find free Creator Store templates/packs, look inside the best
// ones in a quarantine (ServerStorage — scripts there never run), and decide
// adapt-vs-build with evidence. Pure parts live here; the tool is in registry.ts.

export type ScoutKind = 'map' | 'ui' | 'model' | 'audio' | 'image';
export const SCOUT_KINDS: ScoutKind[] = ['map', 'ui', 'model', 'audio', 'image'];
export const QUARANTINE = 'ServerStorage.BloxScout';

export interface SearchHit {
  assetId: string;
  name: string;
  description?: string;
  creatorName?: string;
  assetType?: string;
  isFree?: boolean;
  priceCents?: number;
  creatorStoreUrl?: string;
}
export interface Ranked extends SearchHit {
  hits: number;
  score: number;
}

export function scoutQueries(need: string, kind: ScoutKind): { query: string; assetType?: string }[] {
  const n = need.trim().replace(/\s+/g, ' ');
  switch (kind) {
    case 'map':
      return [`${n} map template`, `${n} map`, `${n} kit`].map((query) => ({ query }));
    case 'ui':
      return [`${n} ui`, `${n} gui pack`, `${n} ui template`].map((query) => ({ query }));
    case 'model':
      return [n, `${n} pack`].map((query) => ({ query }));
    case 'audio':
      return [{ query: n, assetType: 'Audio' }];
    case 'image':
      return [n, `${n} icon`].map((query) => ({ query, assetType: 'Image' }));
  }
}

const KIND_WORDS = /\b(template|kit|pack|map|ui|gui|hud)\b/i;
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);

export const isFreeHit = (h: SearchHit) => h.isFree === true && (h.priceCents ?? 0) === 0;

export function mergeResults(perQuery: SearchHit[][], need: string, _kind: ScoutKind): Ranked[] {
  const byId = new Map<string, Ranked & { order: number }>();
  let order = 0;
  for (const list of perQuery) {
    const seen = new Set<string>();
    for (const h of list) {
      if (!isFreeHit(h) || seen.has(h.assetId)) continue;
      seen.add(h.assetId);
      const prev = byId.get(h.assetId);
      if (prev) prev.hits++;
      else byId.set(h.assetId, { ...h, hits: 1, score: 0, order: order++ });
    }
  }
  const needWords = new Set(words(need));
  const out = [...byId.values()].map((r) => {
    const nameWords = words(r.name);
    const score = 2 * r.hits + nameWords.filter((w) => needWords.has(w)).length + (KIND_WORDS.test(r.name) ? 1 : 0);
    return { ...r, score };
  });
  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out.map(({ order: _o, ...r }) => r);
}

export interface InspectStats {
  parts: number;
  meshParts: number;
  guis: number;
  screenGuis: number;
  sounds: number;
  scripts: number;
  size: [number, number, number];
}

export function adaptVerdict(kind: ScoutKind, s: InspectStats, findings: string[]): { verdict: 'adapt' | 'adapt-with-care' | 'build'; reasons: string[] } {
  if (s.parts === 0 && s.guis === 0 && s.sounds === 0) return { verdict: 'build', reasons: ['empty: no parts, GUI or sounds'] };
  if (kind === 'ui' && s.guis === 0) return { verdict: 'build', reasons: ['no GUI objects: not a UI pack'] };
  const care: string[] = [];
  if (findings.length) care.push(`${findings.length} risky script finding(s): adopt strips scripts — check it still works without them`);
  else if (s.scripts > 0) care.push(`${s.scripts} script(s) will be stripped on adopt (keep_scripts to keep them after reading them)`);
  if (s.parts > 5000) care.push(`heavy: ${s.parts} parts`);
  if (kind === 'map' && Math.max(s.size[0], s.size[2]) < 40) care.push(`small for a map: ${s.size.map((v) => Math.round(v)).join(' × ')} studs`);
  return care.length ? { verdict: 'adapt-with-care', reasons: care } : { verdict: 'adapt', reasons: [`${s.parts} parts, ${s.guis} GUI objects, no scripts`] };
}

const MAX_SOURCE = 200_000;

// Edit-context, read-only: what is inside an inserted template.
export function inspectProgram(path: string): string {
  return `local HttpService = game:GetService("HttpService")
local PATH = ${longString(path)}
local cur = game
for name in string.gmatch(PATH, "[^%.]+") do
	if cur == game and name == "game" then continue end
	local nxt = cur:FindFirstChild(name)
	if not nxt and cur == game then
		local ok, svc = pcall(function() return game:GetService(name) end)
		nxt = ok and svc or nil
	end
	if not nxt then error("not found: " .. PATH, 0) end
	cur = nxt
end
local scripts, parts, meshParts, guis, screenGuis, sounds = {}, 0, 0, 0, 0, 0
for _, d in { cur, table.unpack(cur:GetDescendants()) } do
	if d:IsA("LuaSourceContainer") then
		local ok, src = pcall(function() return d.Source end)
		table.insert(scripts, { path = d:GetFullName(), class = d.ClassName, source = ok and string.sub(src, 1, ${MAX_SOURCE}) or "" })
	elseif d:IsA("BasePart") then
		parts += 1
		if d:IsA("MeshPart") then meshParts += 1 end
	elseif d:IsA("GuiObject") then
		guis += 1
	elseif d:IsA("LayerCollector") then
		screenGuis += 1
	elseif d:IsA("Sound") then
		sounds += 1
	end
end
local size = { 0, 0, 0 }
if cur:IsA("Model") and parts > 0 then
	local s = cur:GetExtentsSize()
	size = { s.X, s.Y, s.Z }
elseif cur:IsA("BasePart") then
	size = { cur.Size.X, cur.Size.Y, cur.Size.Z }
end
return HttpService:JSONEncode({ path = cur:GetFullName(), className = cur.ClassName, scripts = scripts, parts = parts, meshParts = meshParts, guis = guis, screenGuis = screenGuis, sounds = sounds, size = size })`;
}

export function gradeInspect(raw: unknown): { path: string; stats: InspectStats; findings: string[] } {
  if (typeof raw !== 'string') throw new Error('inspect returned no data');
  const j = JSON.parse(raw) as Omit<InspectStats, 'scripts'> & { path: string; scripts?: { path: string; source: string }[] };
  const scripts = Array.isArray(j.scripts) ? j.scripts : [];
  const size = Array.isArray(j.size) && j.size.length === 3 ? (j.size as [number, number, number]) : [0, 0, 0] as [number, number, number];
  return {
    path: j.path,
    stats: { parts: j.parts ?? 0, meshParts: j.meshParts ?? 0, guis: j.guis ?? 0, screenGuis: j.screenGuis ?? 0, sounds: j.sounds ?? 0, scripts: scripts.length, size },
    findings: scripts.flatMap((s) => riskFindings(s.source).map((f) => `${s.path}: ${f}`)),
  };
}

export function scoutFile(need: string, kind: ScoutKind): string {
  const slug = need.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'need';
  return `scout/${slug}-${kind}.json`;
}
