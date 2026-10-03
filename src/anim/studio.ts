import { longString } from '../studio/luau.js';
import { jsonToLuau, SOURCE_SUM_LUAU } from '../sync/push.js';
import type { KeyframeSequenceDescription } from './pose-compiler.js';
import { RESOLVE_LUAU } from './modelRig.js';

// Fixed Luau for the animate tool. Agent data arrives only as JSON in PAYLOAD.
export const BUILD_FOLDER = 'BloxAnimations';

export interface BuildReply {
  ok: boolean;
  error?: string;
  code?: 'not_ours' | 'edited';
  length?: number;
  samples?: { time: number; transforms: Record<string, number[]> }[];
  written?: boolean;
}

// Shared: KeyframeSequence from the compiled description (port of Roqer's
// buildSequence/buildPose/buildMarkers), joint map, revision of a sequence.
// Edit-mode programs decode a JSON payload; the verify probe (which may run
// through the eval bridge, whose lint refuses HttpService) gets a Luau literal.
const EDIT_HEAD = `${SOURCE_SUM_LUAU}local HS = game:GetService("HttpService")
local P = HS:JSONDecode(PAYLOAD)
`;
const SEQUENCE_LUAU = `local function cf(c) return CFrame.new(c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10], c[11], c[12]) end
local function pose(d, parent)
	local p = Instance.new("Pose")
	p.Name = d.part
	p.Weight = d.weight
	p.CFrame = cf(d.cframe)
	p.EasingStyle = Enum.PoseEasingStyle[d.easingStyle]
	p.EasingDirection = Enum.PoseEasingDirection[d.easingDirection]
	for _, c in d.children do pose(c, p) end
	p.Parent = parent
end
local function buildSequence(s)
	local ks = Instance.new("KeyframeSequence")
	ks.Name = s.name
	ks.Loop = s.loop
	ks.Priority = Enum.AnimationPriority[s.priority]
	for _, k in s.keyframes do
		local kf = Instance.new("Keyframe")
		kf.Time = k.time
		if k.name then kf.Name = k.name end
		pose(k.root, kf)
		for _, m in k.markers or {} do
			local mk = Instance.new("KeyframeMarker")
			mk.Name = m.name
			mk.Value = m.value
			mk.Parent = kf
		end
		kf.Parent = ks
	end
	return ks
end
local function r6(v) return math.round(v * 1e6) / 1e6 end
local function describe(inst, out)
	table.insert(out, inst.ClassName .. ":" .. inst.Name)
	if inst:IsA("Keyframe") then table.insert(out, tostring(r6(inst.Time))) end
	if inst:IsA("Pose") then
		table.insert(out, tostring(inst.Weight) .. inst.EasingStyle.Name .. inst.EasingDirection.Name)
		for _, v in { inst.CFrame:GetComponents() } do table.insert(out, tostring(r6(v))) end
	end
	if inst:IsA("KeyframeMarker") then table.insert(out, inst.Value) end
	local kids = inst:GetChildren()
	table.sort(kids, function(a, b)
		if a:IsA("Keyframe") and b:IsA("Keyframe") then return a.Time < b.Time end
		return a.Name < b.Name
	end)
	for _, c in kids do describe(c, out) end
end
local function revision(ks)
	local out = {}
	describe(ks, out)
	return __bloxSum(table.concat(out, "|"))
end
`;

// Play the compiled sequence on a stock dummy in a non-archivable temp folder
// and sample each joint's Transform at the given times (Animator:StepAnimations).
const PLAY_LUAU = `local Players = game:GetService("Players")
local function components(c) local o = {} for _, v in { c:GetComponents() } do table.insert(o, r6(v)) end return o end
local function joints(rig)
	local j = {}
	for _, d in rig:GetDescendants() do
		if d:IsA("AnimationConstraint") and d.Attachment1 and d.Attachment1.Parent then j[d.Attachment1.Parent.Name] = d
		elseif d:IsA("Motor6D") and d.Part1 then j[d.Part1.Name] = d end
	end
	return j
end
local folder, track, ks
local ok, res = pcall(function()
	for _, c in workspace:GetChildren() do if c.Name == "__BloxAnimPreview" then c:Destroy() end end
	ks = buildSequence(P.sequence)
	local id = game:GetService("AnimationClipProvider"):RegisterAnimationClip(ks)
	folder = Instance.new("Folder")
	folder.Name = "__BloxAnimPreview"
	folder.Archivable = false
	folder.Parent = workspace
	local rig, root
	if P.model then
		local source = resolve(P.model.path)
		if not source then error(P.model.path .. " does not exist") end
		rig = source:Clone()
		if not rig then error(P.model.path .. " could not be copied") end
		for _, tag in rig:GetTags() do rig:RemoveTag(tag) end
		-- The root is a jointed rig part; a welded part may share its name.
		for _, d in rig:GetDescendants() do
			local a, b
			if d:IsA("Motor6D") then a, b = d.Part0, d.Part1
			elseif d:IsA("AnimationConstraint") then a, b = d.Attachment0 and d.Attachment0.Parent, d.Attachment1 and d.Attachment1.Parent end
			for _, p in { a, b } do
				if p and p:IsA("BasePart") and p.Name == P.model.rootPart and p:IsDescendantOf(rig) then root = p end
			end
			if root then break end
		end
		if not root then error("the copy has no " .. P.model.rootPart) end
	else
		rig = Players:CreateHumanoidModelFromDescription(Instance.new("HumanoidDescription"), P.sequence.rig == "R6" and Enum.HumanoidRigType.R6 or Enum.HumanoidRigType.R15)
		root = rig.HumanoidRootPart
	end
	rig.Archivable = false
	rig:PivotTo(CFrame.new(0, 100000, 0))
	root.Anchored = true
	rig.Parent = folder
	local controller = rig:FindFirstChildOfClass("Humanoid") or rig:FindFirstChildOfClass("AnimationController")
	local animator = controller:FindFirstChildOfClass("Animator") or Instance.new("Animator", controller)
	local anim = Instance.new("Animation")
	anim.AnimationId = tostring(id)
	track = animator:LoadAnimation(anim)
	track:Play(0)
	local deadline = os.clock() + 10
	while track.Length == 0 and os.clock() < deadline do task.wait(0.05) end
	if track.Length == 0 then error("the animation never loaded on the " .. (P.model and "copy" or "dummy")) end
	local js = joints(rig)
	local samples = {}
	animator:StepAnimations(0)
	local now = 0
	for _, t in P.times do
		if t > now then animator:StepAnimations(t - now) end
		now = t
		local tr = {}
		for part, j in js do tr[part] = components(j.Transform) end
		table.insert(samples, { time = track.TimePosition, transforms = tr })
	end
	return { ok = true, length = track.Length, samples = samples }
end)
if track then pcall(function() track:Stop(0) end) end
if folder then folder:Destroy() end
if ks then ks:Destroy() end
if not ok then return HS:JSONEncode({ ok = false, error = tostring(res) }) end
return HS:JSONEncode(res)`;

// Write ServerStorage.BloxAnimations.<name> in one undo step, refusing to
// replace a sequence blox did not build or one edited since (unless FORCE).
const COMMIT_LUAU = `local SS = game:GetService("ServerStorage")
local CHS = game:GetService("ChangeHistoryService")
local folder = SS:FindFirstChild("${BUILD_FOLDER}")
local old = folder and folder:FindFirstChild(P.sequence.name)
if old and not FORCE then
	local rev = old:GetAttribute("BloxAnimRev")
	if typeof(rev) ~= "string" then return HS:JSONEncode({ ok = false, code = "not_ours", error = old:GetFullName() .. " was not built by blox" }) end
	if revision(old) ~= rev then return HS:JSONEncode({ ok = false, code = "edited", error = old:GetFullName() .. " was edited in Studio since its build" }) end
end
local rec
pcall(function() rec = CHS:TryBeginRecording("blox animate build") end)
if not folder then
	folder = Instance.new("Folder")
	folder.Name = "${BUILD_FOLDER}"
	folder.Parent = SS
end
if old then old:Destroy() end
local ks = buildSequence(P.sequence)
ks:SetAttribute("BloxAnimRev", revision(ks))
ks.Parent = folder
if rec then pcall(function() CHS:FinishRecording(rec, Enum.FinishRecordingOperation.Commit) end) end
return HS:JSONEncode({ ok = true, written = true })`;

export function buildProgram(seq: KeyframeSequenceDescription, sampleTimes: number[], model: { path: string; rootPart: string } | null = null): string {
  return `local WRITE = false\nlocal PAYLOAD = ${longString(JSON.stringify({ sequence: seq, times: sampleTimes, model }))}\n${EDIT_HEAD}${RESOLVE_LUAU}${SEQUENCE_LUAU}${PLAY_LUAU}`;
}

export function commitProgram(seq: KeyframeSequenceDescription, force: boolean): string {
  return `local WRITE = true\nlocal FORCE = ${force}\nlocal PAYLOAD = ${longString(JSON.stringify({ sequence: seq }))}\n${EDIT_HEAD}${SEQUENCE_LUAU}${COMMIT_LUAU}`;
}

export interface VerifyReply {
  ok: boolean;
  error?: string;
  rigType?: string;
  length?: number;
  samples?: { time: number; transforms: Record<string, number[]> }[];
  wiredIds?: string[];
}

// Playtest client: read the character's Animate slot, then play the animation
// (an asset id, or a temporary clip from the compiled sequence) above whatever
// else runs and sample its joints on the Animator's clock.
const VERIFY_LUAU = `local Players = game:GetService("Players")
local function components(c) local o = {} for _, v in { c:GetComponents() } do table.insert(o, r6(v)) end return o end
local player = Players.LocalPlayer
if not player then return { ok = false, error = "not a playtest client" } end
local character = player.Character or player.CharacterAdded:Wait()
local hum = character:WaitForChild("Humanoid", 10)
local animator = hum and hum:WaitForChild("Animator", 10)
if not animator then return { ok = false, error = "the character has no Humanoid with an Animator" } end
local wired
if P.slot then
	wired = {}
	-- The loader re-applies once the avatar appearance (which replaces the slot
	-- Animations) has loaded; wait for that, then a moment for the loader.
	local appearanceBy = os.clock() + 15
	while not player:HasAppearanceLoaded() and os.clock() < appearanceBy do task.wait(0.1) end
	task.wait(0.5)
	local folder = character:FindFirstChild("Animate") and character.Animate:FindFirstChild(P.slot)
	for _, c in folder and folder:GetChildren() or {} do if c:IsA("Animation") then table.insert(wired, c.AnimationId) end end
end
local js = {}
for _, d in character:GetDescendants() do
	if d:IsA("AnimationConstraint") and d.Attachment1 and d.Attachment1.Parent then js[d.Attachment1.Parent.Name] = d
	elseif d:IsA("Motor6D") and d.Part1 then js[d.Part1.Name] = d end
end
local ks, anim, track
local ok, res = pcall(function()
	local id = P.animationId
	if not id then
		ks = buildSequence(P.sequence)
		id = tostring(game:GetService("AnimationClipProvider"):RegisterAnimationClip(ks))
	end
	anim = Instance.new("Animation")
	anim.AnimationId = id
	track = animator:LoadAnimation(anim)
	track.Priority = Enum.AnimationPriority.Action4
	track:Play(0)
	local deadline = os.clock() + 10
	while track.Length == 0 and os.clock() < deadline do task.wait(0.05) end
	if track.Length == 0 then error("the animation never loaded on the character (not owned by this place's owner?)") end
	local gap = math.max(track.Length, 0.2) / 11
	local samples = {}
	for _ = 1, 10 do
		task.wait(gap)
		if not track.IsPlaying then break end
		local tr = {}
		for part, j in js do tr[part] = components(j.Transform) end
		table.insert(samples, { time = track.TimePosition, transforms = tr })
	end
	return { length = track.Length, samples = samples }
end)
if track then pcall(function() track:Stop(0) end) end
if anim then anim:Destroy() end
if ks then ks:Destroy() end
if not ok then return { ok = false, error = tostring(res), rigType = hum.RigType.Name, wiredIds = wired } end
return { ok = true, rigType = hum.RigType.Name, length = res.length, samples = res.samples, wiredIds = wired }`;

export function verifyProgram(seq: KeyframeSequenceDescription | null, animationId: string | null, slot: string | null): string {
  return `local P = ${jsonToLuau({ sequence: seq, animationId, slot })}\n${SEQUENCE_LUAU}${VERIFY_LUAU}`;
}

export interface VerifyModelReply {
  ok: boolean;
  error?: string;
  rigType?: string;
  loader?: { ids: Record<string, string>; speeds: Record<string, number> };
  length?: number;
  samples?: { time: number; transforms: Record<string, number[]> }[];
  observation?: { mode: 'walked'; reached: boolean; samples: unknown[] };
  skipped?: string;
}

// Playtest server, where the loader runs: optionally play the checked
// animation on the model and sample its joints; then, for a Humanoid, walk it
// to a point and sample (every 0.1 s) its speed and the loader's heaviest
// track, then stand it (port of Roqer's animationVerifyModel / observeModel).
const VERIFY_MODEL_LUAU = `local function components(c) local o = {} for _, v in { c:GetComponents() } do table.insert(o, r6(v)) end return o end
local function round2(v) return math.round(v * 100) / 100 end
local model, controller, err = animatedModel(P.model)
if not model then return { ok = false, error = err } end
local humanoid = controller:IsA("Humanoid") and controller or nil
local animator = controller:FindFirstChildOfClass("Animator")
local deadline = os.clock() + 3
while not animator and os.clock() < deadline do task.wait(0.1) animator = controller:FindFirstChildOfClass("Animator") end
if not animator and (P.sequence or P.animationId) then
	-- Not wired, so the loader made none: playback needs only one of its own.
	animator = Instance.new("Animator")
	animator.Parent = controller
end
if not animator then return { ok = false, error = P.model .. " has no Animator in the playtest, and the loader made none (is it tagged BloxAnimated and is BloxModelAnimate synced?)" } end
local loader = { ids = {}, speeds = {} }
for _, state in { "idle", "walk", "run" } do
	local id = model:GetAttribute("BloxAnim_" .. state)
	if typeof(id) == "string" and id ~= "" then loader.ids[state] = id end
	local sp = model:GetAttribute("BloxAnim_" .. state .. "Speed")
	if typeof(sp) == "number" then loader.speeds[state] = sp end
end
local result = { ok = true, rigType = humanoid and humanoid.RigType.Name or nil, loader = loader }
if P.sequence or P.animationId then
	local js = {}
	for _, d in model:GetDescendants() do
		if d:IsA("AnimationConstraint") and d.Attachment1 and d.Attachment1.Parent then js[d.Attachment1.Parent.Name] = d
		elseif d:IsA("Motor6D") and d.Part1 then js[d.Part1.Name] = d end
	end
	local ks, anim, track
	local ok, res = pcall(function()
		local id = P.animationId
		if not id then
			ks = buildSequence(P.sequence)
			id = tostring(game:GetService("AnimationClipProvider"):RegisterAnimationClip(ks))
		end
		anim = Instance.new("Animation")
		anim.AnimationId = id
		track = animator:LoadAnimation(anim)
		track.Priority = Enum.AnimationPriority.Action4
		track:Play(0)
		local by = os.clock() + 10
		while track.Length == 0 and os.clock() < by do task.wait(0.05) end
		if track.Length == 0 then error("the animation never loaded on " .. P.model .. " (not owned by this place's owner?)") end
		local gap = math.max(track.Length, 0.2) / 11
		local samples = {}
		for _ = 1, 10 do
			task.wait(gap)
			if not track.IsPlaying then break end
			local tr = {}
			for part, j in js do tr[part] = components(j.Transform) end
			table.insert(samples, { time = track.TimePosition, transforms = tr })
		end
		return { length = track.Length, samples = samples }
	end)
	if track then pcall(function() track:Stop(0) end) end
	if anim then anim:Destroy() end
	if ks then ks:Destroy() end
	if not ok then return { ok = false, error = tostring(res), rigType = result.rigType, loader = loader } end
	result.length = res.length
	result.samples = res.samples
end
if next(loader.ids) == nil then
	result.skipped = P.model .. " has nothing wired (BloxAnim_idle/walk/run), so verify does not walk it; animate wire first"
	return result
end
if not humanoid then
	result.skipped = P.model .. " has no Humanoid, so verify does not walk it; move it from your game's code to see its walk"
	return result
end
if humanoid.Health <= 0 or humanoid:GetState() == Enum.HumanoidStateType.Dead then
	return { ok = false, error = P.model .. " is dead in the playtest (fell out of the world, or spawned inside the ground?); place it standing on the ground" }
end
local root = humanoid.RootPart
if not root then return { ok = false, error = P.model .. "'s Humanoid has no root part" } end
for _, p in model:GetDescendants() do
	-- One anchored part holds its whole assembly, the root's included.
	if p:IsA("BasePart") and p.Anchored and (p == root or p.AssemblyRootPart == root.AssemblyRootPart) then
		local which = p == root and (P.model .. "'s root part") or p:GetFullName()
		return { ok = false, error = which .. " is anchored, so it cannot walk; unanchor it (its Humanoid holds it up)" }
	end
end
local target = P.target and Vector3.new(P.target[1], P.target[2], P.target[3]) or (root.CFrame * CFrame.new(0, 0, -math.max(12, humanoid.WalkSpeed * 3))).Position
local ids = {}
for _, id in loader.ids do ids[id] = true end
local samples, started, last = {}, os.clock(), root.Position
local function sample(phase)
	task.wait(0.1)
	local v = root.AssemblyLinearVelocity
	local speed = Vector3.new(v.X, 0, v.Z).Magnitude
	local best
	for _, t in animator:GetPlayingAnimationTracks() do
		local id = t.Animation and t.Animation.AnimationId or ""
		if ids[id] and (not best or t.WeightCurrent > best.WeightCurrent) then best = t end
	end
	local s = { t = round2(os.clock() - started), phase = phase, speed = round2(speed), playing = best and best.Animation.AnimationId or false }
	if best then s.pace = round2(best.Speed) end
	table.insert(samples, s)
end
local reached
local connection = humanoid.MoveToFinished:Connect(function(value) reached = value end)
humanoid:MoveTo(target)
while reached == nil and os.clock() - started < 8 do sample("moving") end
connection:Disconnect()
for _ = 1, 15 do sample("standing") end
result.observation = { mode = "walked", reached = reached == true, samples = samples }
return result`;

export function verifyModelProgram(o: { model: string; sequence: KeyframeSequenceDescription | null; animationId: string | null; target: [number, number, number] | null }): string {
  return `local P = ${jsonToLuau(o)}\n${RESOLVE_LUAU}${SEQUENCE_LUAU}${VERIFY_MODEL_LUAU}`;
}
