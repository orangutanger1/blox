import { longString } from '../studio/luau.js';
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

const MAX_SOURCE = 200_000;

// Edit-context: inspect an inserted model; remove its scripts unless keep.
export function sanitizeProgram(path: string, keep: boolean): string {
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
local scripts, parts, meshParts, textures = {}, 0, 0, {}
local function tex(id) if type(id) == "string" and id ~= "" then textures[id] = true end end
for _, d in { cur, table.unpack(cur:GetDescendants()) } do
	if d:IsA("LuaSourceContainer") then
		local ok, src = pcall(function() return d.Source end)
		table.insert(scripts, { path = d:GetFullName(), class = d.ClassName, source = ok and string.sub(src, 1, ${MAX_SOURCE}) or "" })
	elseif d:IsA("BasePart") then
		parts += 1
		if d:IsA("MeshPart") then meshParts += 1 tex(d.TextureID) end
	elseif d:IsA("Decal") or d:IsA("Texture") then
		tex(d.Texture)
	end
end
local removed = 0
if not ${keep ? 'true' : 'false'} then
	for _, d in cur:GetDescendants() do
		if d:IsA("LuaSourceContainer") then d:Destroy() removed += 1 end
	end
end
local t = 0
for _ in textures do t += 1 end
return HttpService:JSONEncode({ path = cur:GetFullName(), scripts = scripts, removed = removed, parts = parts, meshParts = meshParts, textures = t })`;
}

export interface SanitizeReport {
  path: string;
  scripts: { path: string; class: string; findings: string[] }[];
  removed: number;
  parts: number;
  meshParts: number;
  textures: number;
}

export function gradeSanitize(raw: unknown): SanitizeReport {
  if (typeof raw !== 'string') throw new Error('sanitize returned no data');
  const j = JSON.parse(raw) as Omit<SanitizeReport, 'scripts'> & { scripts?: { path: string; class: string; source: string }[] };
  const scripts = Array.isArray(j.scripts) ? j.scripts : [];
  return { path: j.path, removed: j.removed, parts: j.parts, meshParts: j.meshParts, textures: j.textures, scripts: scripts.map((s) => ({ path: s.path, class: s.class, findings: riskFindings(s.source) })) };
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
  return (Array.isArray(list) ? list : []).filter((x) => !known.has(x.id)).map((x) => ({ id: `rbxassetid://${x.id}`, where: x.count > 1 ? `${x.where} (+${x.count - 1} more)` : x.where }));
}
