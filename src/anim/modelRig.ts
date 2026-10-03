import { createHash } from 'node:crypto';
import { longString, runLuau } from '../studio/luau.js';
import type { StudioSession } from '../studio/session.js';
import { rigFromModel, type ModelRigReading } from './model-rig.js';
import type { KeyframeSequenceDescription } from './pose-compiler.js';
import type { Rig } from './rig.js';
import { RIGS } from './rigs.js';
import { loadRigReading } from './store.js';

// Reading a model's own rig (Motor6Ds and AnimationConstraints between its
// parts) in Studio's edit thread, and turning it into a Rig the compiler,
// checks and contact sheet take like R15's. Port of Roqer's animatedModel,
// readModelRig and copyRefusal, without Bones (model animate, PR #68) or meshes.

/** A Studio reply's first value as an object: the envelope hands back a JSON string or a table. */
export function parseReply(values: unknown[], what: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const v = values[0];
  if (v === undefined || v === null || v === '') return { ok: false, error: `${what}: Studio returned no reply` };
  if (typeof v === 'object') return { ok: true, value: v as Record<string, unknown> };
  try {
    const parsed = JSON.parse(String(v)) as unknown;
    if (typeof parsed === 'object' && parsed !== null) return { ok: true, value: parsed as Record<string, unknown> };
  } catch { /* fall through */ }
  return { ok: false, error: `${what}: Studio returned non-JSON: ${String(v).slice(0, 200)}` };
}

export function modelPath(input: string): string {
  return input.replace(/^game\./, '');
}

const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);
const list = (v: readonly number[]) => v.map(fmt).join(',');

/**
 * A digest of everything the compiler, checks and previews take from a
 * reading; not its path, so a clone of the model reads as the same rig, and
 * not welded offsets, which moving a model jitters (Roqer's rigRevision).
 */
export function rigRevision(r: Omit<ModelRigReading, 'revision'>): string {
  const out = [`c:${r.controller}:${r.rootPart}:${fmt(r.hipHeight ?? 0)}`];
  for (const p of [...r.parts].sort((a, b) => (a.name < b.name ? -1 : 1))) out.push(`p:${p.name}:${list(p.size)}:${p.shape ?? 'Block'}:${p.hidden === true}`);
  for (const j of [...r.joints].sort((a, b) => (a.part1 < b.part1 ? -1 : 1))) out.push(`j:${j.name}:${j.part0}:${j.part1}:${list(j.c0)}:${list(j.c1)}`);
  for (const w of [...(r.welded ?? [])].sort((a, b) => (`${a.to}/${a.name}` < `${b.to}/${b.name}` ? -1 : 1))) out.push(`w:${w.name}:${w.to}:${list(w.size)}:${w.shape ?? 'Block'}`);
  out.push(`d:${r.declarations ?? ''}`);
  return `rr1:${createHash('sha256').update(out.join('\n')).digest('hex').slice(0, 16)}`;
}

// Shared Luau: resolve a model path and read its rig. Used by the read, build
// and wire programs. Returns { ok = false, code, error } or { ok = true, ... }.
export const RESOLVE_LUAU = `local function resolve(path)
	local node = game
	for seg in string.gmatch(path, "[^%.]+") do
		node = node:FindFirstChild(seg)
		if not node then return nil end
	end
	return node
end
local function animatedModel(path)
	local model = resolve(path)
	if not model then return nil, "not_found", path .. " does not exist" end
	if not model:IsA("Model") then return nil, "not_model", path .. " is a " .. model.ClassName .. ", not a Model" end
	local Players = game:GetService("Players")
	if Players:GetPlayerFromCharacter(model) or model:IsDescendantOf(Players) or model:IsDescendantOf(game:GetService("StarterPlayer")) then
		return nil, "player_character", path .. " is a player's character; wire its Animate slots with slot instead"
	end
	if not (model:IsDescendantOf(workspace) or model:IsDescendantOf(game:GetService("ServerStorage")) or model:IsDescendantOf(game:GetService("ReplicatedStorage"))) then
		return nil, "bad_location", path .. " must be under Workspace, ServerStorage or ReplicatedStorage"
	end
	local controller = model:FindFirstChildOfClass("Humanoid") or model:FindFirstChildOfClass("AnimationController")
	if not controller then return nil, "no_controller", path .. " has no Humanoid or AnimationController to animate" end
	return model, controller
end
`;

export const READ_RIG_LUAU = `local function r6(v) return math.round(v * 1e6) / 1e6 end
local function comps(c) local o = {} for _, v in { c:GetComponents() } do table.insert(o, r6(v)) end return o end
local function size(p) return { r6(p.Size.X), r6(p.Size.Y), r6(p.Size.Z) } end
local function shape(p)
	if p:IsA("WedgePart") then return "Wedge" end
	if p:IsA("Part") then
		if p.Shape == Enum.PartType.Ball then return "Ball" end
		if p.Shape == Enum.PartType.Cylinder then return "Cylinder" end
		if p.Shape == Enum.PartType.Wedge then return "Wedge" end
	end
	return "Block"
end
local function holdsRig(i)
	local function needed(c)
		return c:IsA("BasePart") or c:IsA("JointInstance") or c:IsA("WeldConstraint") or c:IsA("Constraint") or c:IsA("Attachment") or c:IsA("Humanoid") or c:IsA("AnimationController") or c:IsA("Animator")
	end
	if needed(i) then return true end
	for _, d in i:GetDescendants() do if needed(d) then return true end end
	return false
end
local function copyRefusal(model)
	local path = model:GetFullName()
	if not model.Archivable then return path .. " cannot be archived, so it cannot be copied to play on" end
	for _, d in model:GetDescendants() do
		if not d.Archivable and holdsRig(d) then return d:GetFullName() .. " cannot be archived, so a copy of " .. path .. " would leave it out; make it archivable" end
		local held = {}
		if d:IsA("JointInstance") or d:IsA("WeldConstraint") or d:IsA("NoCollisionConstraint") then held = { d.Part0, d.Part1 }
		elseif d:IsA("Constraint") then held = { d.Attachment0 and d.Attachment0.Parent, d.Attachment1 and d.Attachment1.Parent } end
		for _, p in held do
			if p and not p:IsDescendantOf(model) then return d:GetFullName() .. " holds " .. p:GetFullName() .. ", outside " .. path .. ", which a copy would still hold" end
		end
	end
	return nil
end
local function weldedPair(i)
	local a, b
	if i:IsA("Weld") or i:IsA("ManualWeld") or i:IsA("Snap") or i:IsA("Glue") or i:IsA("WeldConstraint") then a, b = i.Part0, i.Part1
	elseif i:IsA("RigidConstraint") then a, b = i.Attachment0 and i.Attachment0.Parent, i.Attachment1 and i.Attachment1.Parent end
	if a and b and a:IsA("BasePart") and b:IsA("BasePart") then return a, b end
	return nil
end
local function weldedParts(model, rigParts)
	local neighbours = {}
	local function link(a, b) neighbours[a] = neighbours[a] or {} table.insert(neighbours[a], b) end
	for _, d in model:GetDescendants() do
		local a, b = weldedPair(d)
		if a and a:IsDescendantOf(model) and b:IsDescendantOf(model) then link(a, b) link(b, a) end
	end
	local host, queue = {}, {}
	for p in rigParts do table.insert(queue, p) end
	local i = 1
	while i <= #queue do
		local p = queue[i]
		i += 1
		local reached = rigParts[p] and p or host[p]
		for _, n in neighbours[p] or {} do
			if not rigParts[n] and not host[n] then host[n] = reached table.insert(queue, n) end
		end
	end
	local visible = {}
	for p in host do if p.Transparency < 0.99 then table.insert(visible, p) end end
	local function vol(p) return p.Size.X * p.Size.Y * p.Size.Z end
	table.sort(visible, function(a, b) if vol(a) == vol(b) then return a:GetFullName() < b:GetFullName() end return vol(a) > vol(b) end)
	local out = {}
	for k = 1, math.min(#visible, ${256}) do
		local p = visible[k]
		local to = host[p]
		table.insert(out, { name = p.Name, to = to.Name, offset = comps(to.CFrame:ToObjectSpace(p.CFrame)), size = size(p), shape = shape(p) })
	end
	return out, #visible - #out
end
local function readModelRig(path, bare)
	local model, controller, err = animatedModel(path)
	if not model then return { ok = false, code = controller, error = err } end
	local joints = {}
	for _, d in model:GetDescendants() do
		if d:IsA("Motor6D") then
			local a, b = d.Part0, d.Part1
			if a and b and a:IsDescendantOf(model) and b:IsDescendantOf(model) then table.insert(joints, { name = d.Name, part0 = a, part1 = b, c0 = d.C0, c1 = d.C1 }) end
		elseif d:IsA("AnimationConstraint") then
			local a0, a1 = d.Attachment0, d.Attachment1
			local a, b = a0 and a0.Parent, a1 and a1.Parent
			if a and b and a:IsA("BasePart") and b:IsA("BasePart") and a:IsDescendantOf(model) and b:IsDescendantOf(model) then
				table.insert(joints, { name = d.Name, part0 = a, part1 = b, c0 = a0.CFrame, c1 = a1.CFrame })
			end
		end
	end
	if #joints == 0 then return { ok = false, code = "not_rigged", error = path .. " has no Motor6D or AnimationConstraint joints between its parts. Rig building is not supported yet; rig it in Studio (Rig Builder / RigEdit) or Blender" } end
	if #joints > 64 then return { ok = false, code = "rig_too_large", error = path .. " has " .. #joints .. " joints; blox animates a rig of at most 64" } end
	local humanoid = controller:IsA("Humanoid") and controller or nil
	local root
	if humanoid then
		root = humanoid.RootPart
		if not root then return { ok = false, code = "rig_root", error = path .. "'s Humanoid has no root part; give it a HumanoidRootPart" } end
	else
		local moved, roots = {}, {}
		for _, j in joints do moved[j.part1] = true end
		for _, j in joints do if not moved[j.part0] and not table.find(roots, j.part0) then table.insert(roots, j.part0) end end
		if model.PrimaryPart and table.find(roots, model.PrimaryPart) then root = model.PrimaryPart
		elseif #roots == 1 then root = roots[1]
		else return { ok = false, code = "rig_root", error = path .. "'s joints hang from " .. #roots .. " parts that nothing moves; set its PrimaryPart to the one the rig hangs from" } end
	end
	local nodes, partList = {}, {}
	local function add(p) if not nodes[p] then nodes[p] = true table.insert(partList, p) end end
	add(root)
	for _, j in joints do add(j.part0) add(j.part1) end
	if #partList > 128 then return { ok = false, code = "rig_too_large", error = path .. "'s joints join " .. #partList .. " parts; blox animates a rig of at most 128" } end
	local seen = {}
	for _, p in partList do
		if seen[p.Name] then return { ok = false, code = "duplicate_names", error = path .. " has two rig parts named " .. p.Name .. "; poses find parts by name, so rename one" } end
		seen[p.Name] = true
	end
	local declared = model:GetAttribute("BloxRig")
	if declared ~= nil and typeof(declared) ~= "string" then return { ok = false, code = "invalid_declarations", error = path .. "'s BloxRig attribute is a " .. typeof(declared) .. "; it must be JSON text" } end
	local refusal = copyRefusal(model)
	if refusal then return { ok = false, code = "not_copyable", error = refusal } end
	local parts = {}
	for _, p in partList do
		local entry = { name = p.Name, size = size(p), shape = shape(p) }
		if p.Transparency >= 0.99 then entry.hidden = true end
		table.insert(parts, entry)
	end
	table.sort(parts, function(a, b) return a.name < b.name end)
	local outJoints = {}
	for _, j in joints do table.insert(outJoints, { name = j.name, part0 = j.part0.Name, part1 = j.part1.Name, c0 = comps(j.c0), c1 = comps(j.c1) }) end
	local welded, leftOut = weldedParts(model, nodes)
	local reading = { path = model:GetFullName(), rootPart = root.Name, controller = controller.ClassName, parts = parts, joints = outJoints }
	if humanoid then reading.hipHeight = r6(humanoid.HipHeight) end
	if declared ~= nil and not bare then reading.declarations = declared end
	if #welded > 0 then reading.welded = welded end
	if leftOut > 0 then reading.weldedLeftOut = leftOut end
	return { ok = true, reading = reading, rigType = humanoid and humanoid.RigType.Name or nil, walkSpeed = humanoid and humanoid.WalkSpeed or nil }
end
`;

export function readRigProgram(path: string, bare: boolean): string {
  return `local PAYLOAD = ${longString(JSON.stringify({ path: modelPath(path), bare }))}
local HS = game:GetService("HttpService")
local P = HS:JSONDecode(PAYLOAD)
${RESOLVE_LUAU}${READ_RIG_LUAU}return HS:JSONEncode(readModelRig(P.path, P.bare))`;
}

export type RigRead =
  | { ok: true; reading: ModelRigReading; rig: Rig; notes: string[]; rigType?: 'R15' | 'R6'; walkSpeed?: number }
  | { ok: false; error: string; code?: string };

export async function readRig(session: StudioSession, path: string, opts: { bare?: boolean } = {}): Promise<RigRead> {
  const r = await runLuau(session, readRigProgram(path, opts.bare === true), 'edit', { chunkName: 'animateReadRig', timeoutMs: 60_000 });
  if (!r.ok) return { ok: false, error: `reading ${path} failed in Studio: ${r.error?.message}` };
  const p = parseReply(r.values, 'rig read');
  if (!p.ok) return p;
  const v = p.value as { ok?: boolean; code?: string; error?: string; reading?: Omit<ModelRigReading, 'revision'>; rigType?: 'R15' | 'R6'; walkSpeed?: number };
  if (!v.ok || !v.reading) return { ok: false, error: v.error ?? 'the rig read failed', code: v.code };
  const reading: ModelRigReading = { ...v.reading, revision: rigRevision(v.reading) };
  const built = rigFromModel(reading);
  if (!built.ok) return { ok: false, code: 'invalid_rig', error: `${reading.path} cannot be animated:\n${built.errors.map((e) => `  ${e}`).join('\n')}` };
  return { ok: true, reading, rig: built.rig, notes: built.notes, ...(v.rigType ? { rigType: v.rigType } : {}), ...(typeof v.walkSpeed === 'number' ? { walkSpeed: v.walkSpeed } : {}) };
}

/** The rig a compiled sequence was checked on: a stock rig, or the model reading check saved. */
export function rigForSequence(projectPath: string, seq: KeyframeSequenceDescription): Rig {
  const stock = RIGS.get(seq.rig);
  if (stock) return stock;
  const reading = loadRigReading(projectPath, seq.name);
  if (!reading || reading.path !== seq.rig) throw new Error(`${seq.name} has no saved rig reading for ${seq.rig}: check it again`);
  const built = rigFromModel(reading);
  if (!built.ok) throw new Error(`${seq.name}'s saved rig no longer reads: ${built.errors.join('; ')}; check it again`);
  return built.rig;
}
