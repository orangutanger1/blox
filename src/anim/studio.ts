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
		root = rig:FindFirstChild(P.model.rootPart, true)
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
