import { longString, runLuau } from '../studio/luau.js';
import type { StudioSession } from '../studio/session.js';
import type { ModelRigReading } from './model-rig.js';
import { modelPath, parseReply, READ_RIG_LUAU, RESOLVE_LUAU, rigRevision } from './modelRig.js';
import type { PiecesReading, RigBuildPlan } from './rig-build.js';

// Rig building in Studio's edit thread: read a model's pieces for the planner
// (rig-build.ts), then make the planned rig in one call while the model is as
// it was read, then stamp it. Port of Roqer's plugin handlers
// animationReadPieces / animationBuildRig, without importer replacement, import
// space or skinned rigs (refused by name), and with a clone backup where the
// MCP thread gives no undo step.

// Shared: the model a rig builds on, a fingerprint of everything the build
// reads, and the pieces reading itself. Needs RESOLVE_LUAU and READ_RIG_LUAU.
const PIECES_LUAU = `local function piecesModel(path)
	local model = resolve(path)
	if not model then return nil, "not_found", path .. " does not exist" end
	if not model:IsA("Model") then return nil, "not_model", path .. " is a " .. model.ClassName .. ", not a Model" end
	local Players = game:GetService("Players")
	if Players:GetPlayerFromCharacter(model) or model:IsDescendantOf(Players) or model:IsDescendantOf(game:GetService("StarterPlayer")) then
		return nil, "player_character", path .. " is a player's character, which Roblox rigs; rig builds an NPC's or a creature's"
	end
	if not (model:IsDescendantOf(workspace) or model:IsDescendantOf(game:GetService("ServerStorage")) or model:IsDescendantOf(game:GetService("ReplicatedStorage"))) then
		return nil, "bad_location", path .. " must be under Workspace, ServerStorage or ReplicatedStorage"
	end
	return model
end
local function fnv(s, h)
	for i = 1, #s do
		h = bit32.bxor(h, string.byte(s, i))
		h = (bit32.lshift(h, 24) + h * 403) % 4294967296
	end
	return h
end
local function piecesFingerprint(model)
	local out = { "m:" .. tostring(model:GetAttribute("BloxRig")) .. ":" .. tostring(model:GetAttribute("BloxRigBuilt")) .. ":" .. table.concat(comps(model:GetPivot()), ",") }
	for _, d in model:GetDescendants() do
		if d:IsA("BasePart") then
			table.insert(out, "p:" .. d:GetFullName() .. ":" .. table.concat(comps(d.CFrame), ",") .. ":" .. table.concat(size(d), ",") .. ":" .. shape(d) .. ":" .. tostring(d.Transparency >= 0.95) .. ":" .. tostring(d:GetAttribute("BloxMadeRoot")))
		elseif d:IsA("Motor6D") then
			table.insert(out, "j:" .. d:GetFullName() .. ":" .. tostring(d.Part0 and d.Part0:GetFullName()) .. ":" .. tostring(d.Part1 and d.Part1:GetFullName()) .. ":" .. table.concat(comps(d.C0), ",") .. ":" .. table.concat(comps(d.C1), ","))
		elseif d:IsA("JointInstance") or d:IsA("WeldConstraint") or d:IsA("Constraint") or d:IsA("Humanoid") or d:IsA("AnimationController") or d:IsA("Bone") then
			table.insert(out, "o:" .. d.ClassName .. ":" .. d:GetFullName())
		end
	end
	local s = table.concat(out, "\\n")
	return string.format("%08x%08x", fnv(s, 2166136261), fnv(s, 84696351))
end
local function readPieces(path)
	local model, code, err = piecesModel(path)
	if not model then return { ok = false, code = code, error = err } end
	local parts, index = {}, {}
	for _, d in model:GetDescendants() do
		if d:IsA("BasePart") then
			table.insert(parts, d)
			index[d] = #parts - 1
		end
	end
	if #parts == 0 then return { ok = false, code = "model_empty", error = path .. " has no parts to rig" } end
	if #parts > ${512} then return { ok = false, code = "model_too_large", error = path .. " has " .. #parts .. " parts; rig builds on a model of at most ${512}" } end
	local bones = 0
	for _, d in model:GetDescendants() do if d:IsA("Bone") then bones += 1 end end
	if bones > 0 then return { ok = false, code = "skinned", error = path .. " is a skinned mesh (" .. bones .. " Bones): its bones are its joints. blox rig builds Part rigs only; animate a skinned model with model animate (Blender actions)" } end
	local outParts = {}
	for _, p in parts do
		local e = { name = p.Name, cframe = comps(p.CFrame), size = size(p), shape = shape(p) }
		if p.Transparency >= 0.95 then e.hidden = true end
		if p:GetAttribute("BloxMadeRoot") == true then e.madeRoot = true end
		table.insert(outParts, e)
	end
	local joints, welds, motors = {}, {}, {}
	for _, d in model:GetDescendants() do
		if d:IsA("Motor6D") then
			if d.Part0 and d.Part1 and index[d.Part0] ~= nil and index[d.Part1] ~= nil then
				table.insert(joints, { name = d.Name, part0 = index[d.Part0], part1 = index[d.Part1] })
				table.insert(motors, d)
			end
		elseif d:IsA("AnimationConstraint") then
			local a, b = d.Attachment0 and d.Attachment0.Parent, d.Attachment1 and d.Attachment1.Parent
			if a and b and index[a] ~= nil and index[b] ~= nil then table.insert(joints, { name = d.Name, part0 = index[a], part1 = index[b] }) end
		else
			local a, b = weldedPair(d)
			if a and index[a] ~= nil and index[b] ~= nil then
				local w = { part0 = index[a], part1 = index[b] }
				if d:GetAttribute("BloxMadeWeld") == true then w.made = true end
				table.insert(welds, w)
			end
		end
	end
	local controllers = {}
	for _, c in model:GetChildren() do
		if c:IsA("Humanoid") or c:IsA("AnimationController") then table.insert(controllers, c.ClassName) end
	end
	if #motors > 0 and #motors == #joints and model:GetAttribute("BloxRigBuilt") == nil and table.find(controllers, "AnimationController") then
		local root, centred = motors[1].Part0, true
		for _, m in motors do
			if m.Part0 ~= root or m.C1.Position.Magnitude > 0.01 then centred = false end
		end
		if centred then return { ok = false, code = "importer_rig", error = path .. " has an importer's rig (" .. #motors .. " Motor6Ds from " .. root.Name .. ", each turning a piece about its own centre). blox does not replace importer rigs; re-import without a rig, or rig it in Studio" } end
	end
	local reading = { path = model:GetFullName(), pivot = comps(model:GetPivot()), parts = outParts, joints = joints, welds = welds, controllers = controllers }
	local declared = model:GetAttribute("BloxRig")
	if typeof(declared) == "string" then reading.declarations = declared end
	if #joints > 0 then
		local rr = readModelRig(path, false)
		if rr.ok then reading.rigReading = rr.reading end
		local built = model:GetAttribute("BloxRigBuilt")
		if typeof(built) == "string" then reading.builtRevision = built end
	end
	return { ok = true, reading = reading, fingerprint = piecesFingerprint(model) }
end
`;

const BUILD_LUAU = `local function partNamed(parts, name)
	local found = {}
	for _, p in parts do if p.Name == name then table.insert(found, p) end end
	if #found ~= 1 then error("the model has " .. #found .. " parts named " .. tostring(name), 0) end
	return found[1]
end
local function cf(c, what)
	if type(c) ~= "table" or #c ~= 12 then error(what .. " must be a CFrame's 12 components", 0) end
	return CFrame.new(table.unpack(c))
end
local function buildRig(P)
	local model, code, err = piecesModel(P.path)
	if not model then return { ok = false, code = code, error = err .. ". Nothing was changed." } end
	if piecesFingerprint(model) ~= P.expect then
		return { ok = false, code = "model_changed", error = P.path .. " has changed since its pieces were read. Nothing was changed; call rig again." }
	end
	local plan = P.plan
	local CHS = game:GetService("ChangeHistoryService")
	local rec
	pcall(function() rec = CHS:TryBeginRecording("blox rig " .. model.Name) end)
	local backup
	if not rec then
		if not model.Archivable then
			return { ok = false, code = "no_undo", error = "Studio gave no undo step and " .. P.path .. " cannot be archived to back up first. Nothing was changed." }
		end
		local SS = game:GetService("ServerStorage")
		local folder = SS:FindFirstChild("__BloxRigBackup")
		if not folder then
			folder = Instance.new("Folder")
			folder.Name = "__BloxRigBackup"
			folder.Parent = SS
		end
		local old = folder:FindFirstChild(model.Name)
		if old then old:Destroy() end
		backup = model:Clone()
		backup.Parent = folder
	end
	local removed = {}
	local applied, applyErr = pcall(function()
		if plan.rebuild == true then
			local n = 0
			for _, d in model:GetDescendants() do
				if d:IsA("Motor6D") or d:IsA("AnimationConstraint") then
					d:Destroy()
					n += 1
				elseif (d:IsA("WeldConstraint") or d:IsA("Weld")) and d:GetAttribute("BloxMadeWeld") == true then
					d:Destroy()
				end
			end
			table.insert(removed, "the " .. n .. " joints rig built before")
		end
		local parts = {}
		for _, d in model:GetDescendants() do if d:IsA("BasePart") then table.insert(parts, d) end end
		local root
		if type(plan.root.make) == "table" then
			local made
			for _, p in parts do
				if p.Name == "HumanoidRootPart" and p:GetAttribute("BloxMadeRoot") == true then made = p end
			end
			if not made then
				made = Instance.new("Part")
				table.insert(parts, made)
			end
			made.Name = "HumanoidRootPart"
			local s = plan.root.make.size
			made.Size = Vector3.new(s[1], s[2], s[3])
			made.CFrame = cf(plan.root.make.cframe, "the root's CFrame")
			made.Transparency = 1
			made:SetAttribute("BloxMadeRoot", true)
			made.Parent = model
			root = made
		else
			root = partNamed(parts, plan.root.name)
		end
		for _, p in parts do
			p.Anchored = p == root and plan.rootAnchored == true
			p.CanCollide = p == root
			p.Massless = p ~= root
		end
		model.PrimaryPart = root
		for _, j in plan.joints do
			local m = Instance.new("Motor6D")
			m.Name = j.name
			m.C0 = cf(j.c0, j.name .. "'s C0")
			m.C1 = cf(j.c1, j.name .. "'s C1")
			m.Part0 = partNamed(parts, j.part0)
			m.Part1 = partNamed(parts, j.part1)
			m.Parent = m.Part1
		end
		for _, w in plan.welds do
			local p0, p1 = partNamed(parts, w.part0), partNamed(parts, w.part1)
			local weld = Instance.new("WeldConstraint")
			weld.Name = "BloxWeld_" .. p0.Name
			weld.Part0 = p0
			weld.Part1 = p1
			weld:SetAttribute("BloxMadeWeld", true)
			weld.Parent = p1
		end
		local className = plan.controller.className == "Humanoid" and "Humanoid" or "AnimationController"
		local controller = model:FindFirstChildOfClass(className)
		if not controller then
			controller = Instance.new(className)
			controller.Parent = model
		end
		if controller:IsA("Humanoid") then
			controller.RigType = Enum.HumanoidRigType.R15
			controller.HipHeight = plan.controller.hipHeight
			controller.RequiresNeck = false
			controller.BreakJointsOnDeath = false
			for _ = 1, 10 do
				if controller.RootPart then break end
				if not pcall(task.wait) then break end
			end
		end
		if not controller:FindFirstChildOfClass("Animator") then Instance.new("Animator").Parent = controller end
		model:SetAttribute("BloxRig", plan.declarations)
		model:SetAttribute("BloxRigBuilt", nil)
	end)
	if not applied then
		local how = ""
		if rec then
			pcall(function() CHS:FinishRecording(rec, Enum.FinishRecordingOperation.Cancel) end)
			how = " The undo step was cancelled; nothing was changed."
		elseif backup then
			local restored = backup:Clone()
			restored.Parent = model.Parent
			model:Destroy()
			how = " " .. P.path .. " was put back from its backup."
		end
		return { ok = false, code = "build_failed", error = "building the rig failed: " .. tostring(applyErr) .. "." .. how }
	end
	if rec then pcall(function() CHS:FinishRecording(rec, Enum.FinishRecordingOperation.Commit) end) end
	local after = readModelRig(P.path, false)
	local backupPath = backup and backup:GetFullName() or nil
	if not after.ok then
		return { ok = false, code = "read_back_failed", error = P.path .. " was rigged but does not read back: " .. tostring(after.error), built = true, backup = backupPath }
	end
	return { ok = true, reading = after.reading, fingerprint = after.fingerprint, recorded = rec ~= nil, backup = backupPath, removed = removed }
end
`;

const STAMP_LUAU = `local function stamp(P)
	local model = resolve(P.path)
	if not model then return { ok = false, error = P.path .. " does not exist" } end
	local now = readModelRig(P.path, false)
	if not now.ok then return now end
	if now.fingerprint ~= P.expect then return { ok = false, code = "changed", error = P.path .. " changed after it was rigged" } end
	local CHS = game:GetService("ChangeHistoryService")
	local rec
	pcall(function() rec = CHS:TryBeginRecording("blox rig stamp") end)
	model:SetAttribute("BloxRigBuilt", P.revision)
	if rec then pcall(function() CHS:FinishRecording(rec, Enum.FinishRecordingOperation.Commit) end) end
	return { ok = true }
end
`;

function head(marker: string, payload: unknown): string {
  return `-- ${marker}
local PAYLOAD = ${longString(JSON.stringify(payload))}
local HS = game:GetService("HttpService")
local P = HS:JSONDecode(PAYLOAD)
`;
}

export function readPiecesProgram(path: string): string {
  return `${head('BloxReadPieces', { path: modelPath(path) })}${RESOLVE_LUAU}${READ_RIG_LUAU}${PIECES_LUAU}return HS:JSONEncode(readPieces(P.path))`;
}

export function buildRigProgram(path: string, plan: RigBuildPlan, expect: string): string {
  return `${head('BloxRigBuild', { path: modelPath(path), expect, plan })}${RESOLVE_LUAU}${READ_RIG_LUAU}${PIECES_LUAU}${BUILD_LUAU}return HS:JSONEncode(buildRig(P))`;
}

export function stampRigProgram(path: string, revision: string, expect: string): string {
  return `${head('BloxRigStamp', { path: modelPath(path), revision, expect })}${RESOLVE_LUAU}${READ_RIG_LUAU}${STAMP_LUAU}return HS:JSONEncode(stamp(P))`;
}

type RawPieces = Omit<PiecesReading, 'revision' | 'rig'> & { rigReading?: Omit<ModelRigReading, 'revision'>; builtRevision?: string };

export async function readPieces(session: StudioSession, path: string): Promise<{ ok: true; reading: PiecesReading; fingerprint: string } | { ok: false; error: string; code?: string }> {
  const r = await runLuau(session, readPiecesProgram(path), 'edit', { chunkName: 'animateReadPieces', timeoutMs: 60_000 });
  if (!r.ok) return { ok: false, error: `reading ${path}'s pieces failed in Studio: ${r.error?.message}` };
  const p = parseReply(r.values, 'pieces read');
  if (!p.ok) return p;
  const v = p.value as { ok?: boolean; code?: string; error?: string; reading?: RawPieces; fingerprint?: string };
  if (!v.ok || !v.reading || typeof v.fingerprint !== 'string') return { ok: false, error: v.error ?? 'the pieces read failed', ...(v.code ? { code: v.code } : {}) };
  const { rigReading, builtRevision, ...rest } = v.reading;
  const reading: PiecesReading = {
    ...rest,
    revision: `rp1:${v.fingerprint}`,
    ...(rest.joints.length > 0 ? { rig: { revision: rigReading ? rigRevision(rigReading) : 'unreadable', ...(builtRevision ? { builtRevision } : {}) } } : {}),
  };
  return { ok: true, reading, fingerprint: v.fingerprint };
}

export type RigBuildReply =
  | { ok: true; reading: ModelRigReading; fingerprint: string; recorded: boolean; backup?: string; removed: string[] }
  | { ok: false; error: string; code?: string; built?: boolean; backup?: string };

export async function buildRig(session: StudioSession, path: string, plan: RigBuildPlan, expect: string): Promise<RigBuildReply> {
  const r = await runLuau(session, buildRigProgram(path, plan, expect), 'edit', { chunkName: 'animateBuildRig', timeoutMs: 120_000 });
  if (!r.ok) return { ok: false, error: `building ${path}'s rig failed in Studio: ${r.error?.message}` };
  const p = parseReply(r.values, 'rig build');
  if (!p.ok) return p;
  const v = p.value as { ok?: boolean; code?: string; error?: string; reading?: Omit<ModelRigReading, 'revision'>; fingerprint?: string; recorded?: boolean; backup?: string; removed?: string[]; built?: boolean };
  if (!v.ok || !v.reading) return { ok: false, error: v.error ?? 'the rig build failed', ...(v.code ? { code: v.code } : {}), ...(v.built ? { built: true } : {}), ...(v.backup ? { backup: v.backup } : {}) };
  return {
    ok: true,
    reading: { ...v.reading, revision: rigRevision(v.reading) },
    fingerprint: v.fingerprint ?? '',
    recorded: v.recorded === true,
    ...(v.backup ? { backup: v.backup } : {}),
    removed: v.removed ?? [],
  };
}

export async function stampRig(session: StudioSession, path: string, revision: string, expect: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await runLuau(session, stampRigProgram(path, revision, expect), 'edit', { chunkName: 'animateStampRig', timeoutMs: 60_000 });
  if (!r.ok) return { ok: false, error: `stamping failed in Studio: ${r.error?.message}` };
  const p = parseReply(r.values, 'rig stamp');
  if (!p.ok) return p;
  return p.value.ok === true ? { ok: true } : { ok: false, error: String(p.value.error ?? 'stamp refused') };
}
