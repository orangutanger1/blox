import { longString, runLuau } from '../studio/luau.js';
import type { StudioSession } from '../studio/session.js';
import type { AssetManifest } from './manifest.js';

// Risky patterns in scripts that ship inside free models. Graded in TS so the
// rules live in one place; the Luau side only collects sources.
export const RISKS: { label: string; re: RegExp }[] = [
  { label: 'require(<asset id>) loads remote code', re: /\brequire\s*\(\s*\d{5,}\s*\)/ },
  { label: 'getfenv/setfenv environment tampering', re: /\b[gs]etfenv\s*\(/ },
  { label: 'loadstring', re: /\bloadstring\s*\(/ },
  { label: 'HttpService (network access)', re: /HttpService/ },
  { label: 'TeleportService', re: /TeleportService/ },
  { label: 'InsertService (loads assets at runtime)', re: /InsertService/ },
  { label: 'MarketplaceService prompt', re: /MarketplaceService[\s\S]{0,80}Prompt/ },
  { label: 'kicks players', re: /:Kick\s*\(/ },
  { label: 'string.char / escape obfuscation', re: /string\.char\s*\(|(\\\d{2,3}){8,}/ },
  { label: 'very long line (packed/obfuscated code)', re: /^.{1000,}$/m },
];

export function riskFindings(source: string): string[] {
  return RISKS.filter((r) => r.re.test(source)).map((r) => r.label);
}

// execute_luau replies are capped (live: 50KB fine, 100KB cut off), so script
// sources come back in chunks of about SOURCE_BUDGET characters; JSON escaping
// can double that. A single longer script is scanned up to the budget.
export const SOURCE_BUDGET = 20_000;

// Edit-context: inspect a model (stats + script sources from index SKIP on) and,
// on the call that reads the last source, remove its scripts unless KEEP.
export function sanitizeProgram(path: string, keep: boolean, skip = 0, budget = SOURCE_BUDGET): string {
  return `local HttpService = game:GetService("HttpService")
local PATH = ${longString(path)}
local SKIP = ${Math.max(0, Math.floor(skip))}
local BUDGET = ${Math.max(1, Math.floor(budget))}
local KEEP = ${keep ? 'true' : 'false'}
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
local scripts, parts, meshParts, textures, guis, screenGuis, sounds = {}, 0, 0, {}, 0, 0, 0
local idx, used, nextSkip = 0, 0, nil
local function tex(id) if type(id) == "string" and id ~= "" then textures[id] = true end end
for _, d in { cur, table.unpack(cur:GetDescendants()) } do
	if d:IsA("LuaSourceContainer") then
		idx += 1
		if idx > SKIP and nextSkip == nil then
			local ok, src = pcall(function() return d.Source end)
			src = ok and src or ""
			-- What it costs once JSON-escaped: a control character becomes up
			-- to 6 characters (\\u0001), a quote or backslash 2.
			local _, ctl = string.gsub(src, "%c", "")
			local _, esc = string.gsub(src, '["\\\\]', "")
			local cost = #src + 5 * ctl + esc
			if used > 0 and used + cost > BUDGET then
				nextSkip = idx - 1
			else
				local cut = cost > BUDGET
				if cut then
					src = string.sub(src, 1, math.max(1, math.floor(#src * BUDGET / cost)))
					cost = BUDGET
				end
				used += cost
				table.insert(scripts, { path = d:GetFullName(), class = d.ClassName, source = src, cut = cut })
			end
		end
	elseif d:IsA("BasePart") then
		parts += 1
		if d:IsA("MeshPart") then meshParts += 1 tex(d.TextureID) end
	elseif d:IsA("Decal") or d:IsA("Texture") then
		tex(d.Texture)
	elseif d:IsA("GuiObject") then
		guis += 1
	elseif d:IsA("LayerCollector") then
		screenGuis += 1
	elseif d:IsA("Sound") then
		sounds += 1
	end
end
local removed = 0
if nextSkip == nil and not KEEP then
	for _, d in cur:GetDescendants() do
		if d:IsA("LuaSourceContainer") then d:Destroy() removed += 1 end
	end
end
local size = { 0, 0, 0 }
if cur:IsA("Model") and parts > 0 then
	local e = cur:GetExtentsSize()
	size = { e.X, e.Y, e.Z }
elseif cur:IsA("BasePart") then
	size = { cur.Size.X, cur.Size.Y, cur.Size.Z }
end
local t = 0
for _ in textures do t += 1 end
return HttpService:JSONEncode({ path = cur:GetFullName(), className = cur.ClassName, scripts = scripts, removed = removed, parts = parts, meshParts = meshParts, textures = t, guis = guis, screenGuis = screenGuis, sounds = sounds, size = size, next = nextSkip })`;
}

export interface SanitizeReport {
  path: string;
  scripts: { path: string; class: string; findings: string[] }[];
  removed: number;
  parts: number;
  meshParts: number;
  textures: number;
  guis: number;
  screenGuis: number;
  sounds: number;
  size: [number, number, number];
}

interface SanitizeChunk extends Omit<SanitizeReport, 'scripts'> {
  scripts: { path: string; class: string; source: string; cut?: boolean }[];
  next: number | null;
}

function parseChunk(raw: unknown): SanitizeChunk {
  if (typeof raw !== 'string') throw new Error('sanitize returned no data');
  const j = JSON.parse(raw) as Partial<SanitizeChunk>;
  const size = Array.isArray(j.size) && j.size.length === 3 ? (j.size as [number, number, number]) : ([0, 0, 0] as [number, number, number]);
  return {
    path: String(j.path), removed: j.removed ?? 0, parts: j.parts ?? 0, meshParts: j.meshParts ?? 0, textures: j.textures ?? 0,
    guis: j.guis ?? 0, screenGuis: j.screenGuis ?? 0, sounds: j.sounds ?? 0, size,
    scripts: Array.isArray(j.scripts) ? j.scripts : [], next: typeof j.next === 'number' ? j.next : null,
  };
}

export function gradeSanitize(raw: unknown): SanitizeReport {
  const { next: _n, ...c } = parseChunk(raw);
  return { ...c, scripts: c.scripts.map((s) => ({ path: s.path, class: s.class, findings: chunkFindings(s) })) };
}

const MAX_CHUNKS = 200;

// A script longer than one chunk is scanned only up to the budget: its tail is
// unknown, which must stop it being kept as if it were clean.
function chunkFindings(s: { source: string; cut?: boolean }): string[] {
  return [...riskFindings(s.source), ...(s.cut ? [`longer than ${SOURCE_BUDGET} characters: only the start was scanned`] : [])];
}

// Inspect (and, unless keep, strip) a model whatever the size of its scripts.
export async function runSanitize(session: StudioSession, path: string, keep: boolean): Promise<SanitizeReport> {
  const scripts: SanitizeReport['scripts'] = [];
  let skip = 0;
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const r = await runLuau(session, sanitizeProgram(path, keep, skip), 'edit', { chunkName: 'sanitize' });
    if (!r.ok) throw new Error(r.error?.message ?? 'sanitize failed');
    const c = parseChunk(r.values[0]);
    scripts.push(...c.scripts.map((s) => ({ path: s.path, class: s.class, findings: chunkFindings(s) })));
    if (c.next === null) {
      const { next: _n, scripts: _s, ...rest } = c;
      return { ...rest, scripts };
    }
    if (c.next <= skip) throw new Error(`sanitize made no progress at script ${skip}`);
    skip = c.next;
  }
  throw new Error(`sanitize: more than ${MAX_CHUNKS} chunks of scripts`);
}

// Edit-context: every asset id the place references, with one example location.
export const SCAN_LUAU = `local HttpService = game:GetService("HttpService")
local PROPS = {
	MeshPart = { "MeshId", "TextureID" }, SpecialMesh = { "MeshId", "TextureId" },
	Decal = { "Texture" }, Texture = { "Texture" }, ImageLabel = { "Image" }, ImageButton = { "Image" },
	Sound = { "SoundId" }, Animation = { "AnimationId" }, Sky = { "SkyboxBk", "SkyboxDn", "SkyboxFt", "SkyboxLf", "SkyboxRt", "SkyboxUp" },
	Shirt = { "ShirtTemplate" }, Pants = { "PantsTemplate" }, ParticleEmitter = { "Texture" }, Beam = { "Texture" }, Trail = { "Texture" },
}
local found, order = {}, {}
local function note(v, where)
	if type(v) ~= "string" then return end
	local id = string.match(v, "rbxassetid://(%d+)") or string.match(v, "[?&]id=(%d+)")
	if not id then return end
	if not found[id] then found[id] = { id = tonumber(id), where = where, count = 0 } table.insert(order, id) end
	found[id].count += 1
end
for _, svcName in { "Workspace", "ReplicatedStorage", "ReplicatedFirst", "ServerStorage", "StarterGui", "StarterPack", "StarterPlayer", "Lighting", "SoundService" } do
	local ok, svc = pcall(function() return game:GetService(svcName) end)
	if ok and svc then
		for _, d in svc:GetDescendants() do
			local props = PROPS[d.ClassName]
			if props and not string.find(d:GetFullName(), "__BloxRenderRig", 1, true) then
				for _, p in props do
					local okp, v = pcall(function() return d[p] end)
					if okp then note(v, d:GetFullName() .. "." .. p) end
				end
			end
		end
	end
end
local list = {}
for _, id in order do table.insert(list, found[id]) end
return HttpService:JSONEncode(list)`;

export function untrackedFromScan(raw: unknown, m: AssetManifest): { id: string; where: string }[] {
  if (typeof raw !== 'string') throw new Error('scan returned no data');
  const list = JSON.parse(raw) as { id: number; where: string; count: number }[] | Record<string, never>;
  const known = new Set<number>();
  for (const a of m.assets) {
    if (a.ref.assetId) known.add(a.ref.assetId);
    if (a.uploaded) known.add(a.uploaded.assetId);
  }
  // A tracked model's own meshes/textures are covered by its entry.
  const inside = m.assets.map((a) => a.ref.path).filter((p): p is string => !!p).map((p) => p + '.');
  return (Array.isArray(list) ? list : []).filter((x) => !known.has(x.id) && !inside.some((p) => x.where.startsWith(p))).map((x) => ({ id: `rbxassetid://${x.id}`, where: x.count > 1 ? `${x.where} (+${x.count - 1} more)` : x.where }));
}
