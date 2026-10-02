import { longString } from '../studio/luau.js';
import type { Shot } from './schema.js';

// Edit-context Luau that stages one shot in Workspace.__BloxRenderRig: a posed
// avatar (R15 from a default HumanoidDescription, or a block rig if that is
// unavailable), an optional hero clone, and the overlay text on an
// AlwaysOnTop billboard in the upper third of the camera's view.
// Poses rotate Motor6D C0s and place parts outward from the root by hand, so
// they hold in edit mode without physics. Angles are degrees (X, Y, Z).
export const POSE_TABLE: Record<string, Record<string, [number, number, number]>> = {
  idle: {},
  cheer: { LeftShoulder: [170, 0, 0], RightShoulder: [170, 0, 0], LeftElbow: [15, 0, 0], RightElbow: [15, 0, 0] },
  carry: { LeftShoulder: [80, 0, 0], RightShoulder: [80, 0, 0], LeftElbow: [25, 0, 0], RightElbow: [25, 0, 0] },
  punch: { RightShoulder: [90, 0, 0], LeftShoulder: [-30, 0, 0], LeftElbow: [70, 0, 0] },
  run: { LeftShoulder: [45, 0, 0], RightShoulder: [-45, 0, 0], LeftHip: [-40, 0, 0], RightHip: [40, 0, 0], LeftKnee: [-30, 0, 0], RightKnee: [-10, 0, 0] },
  point: { RightShoulder: [90, 0, 0], RightElbow: [5, 0, 0] },
};

export const RIG_NAME = '__BloxRenderRig';
export const CLEANUP = `local r = workspace:FindFirstChild("${RIG_NAME}") if r then r:Destroy() end return true`;

export function rigProgram(shot: Shot): string {
  return `local HttpService = game:GetService("HttpService")
local SHOT = HttpService:JSONDecode(${longString(JSON.stringify(shot))})
local POSES = HttpService:JSONDecode(${longString(JSON.stringify(POSE_TABLE))})
local old = workspace:FindFirstChild("${RIG_NAME}")
if old then old:Destroy() end
local rig = Instance.new("Model")
rig.Name = "${RIG_NAME}"
local function v3(t) return Vector3.new(t[1], t[2], t[3]) end

local function blockRig()
	local m = Instance.new("Model")
	local function part(name, size, color)
		local p = Instance.new("Part")
		p.Name = name
		p.Size = size
		p.Color = color
		p.TopSurface = Enum.SurfaceType.Smooth
		p.BottomSurface = Enum.SurfaceType.Smooth
		p.Parent = m
		return p
	end
	local root = part("HumanoidRootPart", Vector3.new(2, 2, 1), Color3.new(1, 1, 1))
	root.Transparency = 1
	local torso = part("Torso", Vector3.new(2, 2, 1), Color3.fromRGB(13, 105, 172))
	local head = part("Head", Vector3.new(1.2, 1.2, 1.2), Color3.fromRGB(245, 205, 48))
	local function joint(name, p0, p1, c0, c1)
		local j = Instance.new("Motor6D")
		j.Name = name
		j.Part0, j.Part1, j.C0, j.C1 = p0, p1, c0, c1
		j.Parent = p1
	end
	joint("RootJoint", root, torso, CFrame.new(), CFrame.new())
	joint("Neck", torso, head, CFrame.new(0, 1, 0), CFrame.new(0, -0.6, 0))
	for _, side in { "Left", "Right" } do
		local s = side == "Left" and -1 or 1
		local arm = part(side .. "Arm", Vector3.new(1, 2, 1), Color3.fromRGB(245, 205, 48))
		joint(side .. "Shoulder", torso, arm, CFrame.new(1.5 * s, 0.5, 0), CFrame.new(0, 0.5, 0))
		local leg = part(side .. "Leg", Vector3.new(1, 2, 1), Color3.fromRGB(75, 151, 75))
		joint(side .. "Hip", torso, leg, CFrame.new(0.5 * s, -1, 0), CFrame.new(0, 1, 0))
	end
	local h = Instance.new("Humanoid")
	h.Parent = m
	m.PrimaryPart = root
	return m
end

local function pose(char, name)
	local P = POSES[name or "idle"] or {}
	local motors = {}
	for _, d in char:GetDescendants() do
		if d:IsA("Motor6D") then table.insert(motors, d) end
	end
	for _, m in motors do
		local a = P[m.Name]
		if a then m.C0 = m.C0 * CFrame.Angles(math.rad(a[1]), math.rad(a[2]), math.rad(a[3])) end
	end
	local placed = { [char.PrimaryPart] = true }
	for _ = 1, #motors do
		for _, m in motors do
			if m.Part0 and m.Part1 and placed[m.Part0] and not placed[m.Part1] then
				m.Part1.CFrame = m.Part0.CFrame * m.C0 * m.C1:Inverse()
				placed[m.Part1] = true
			end
		end
	end
	for _, d in char:GetDescendants() do
		if d:IsA("BasePart") then d.Anchored = true end
	end
end

local avatarKind = "none"
if SHOT.subject then
	local ok, char = pcall(function()
		return game:GetService("Players"):CreateHumanoidModelFromDescription(Instance.new("HumanoidDescription"), Enum.HumanoidRigType.R15)
	end)
	avatarKind = "r15"
	if not ok or not char then
		char = blockRig()
		avatarKind = "block"
	end
	char.Name = "Avatar"
	if not char.PrimaryPart then char.PrimaryPart = char:FindFirstChild("HumanoidRootPart") end
	char:PivotTo(CFrame.new(v3(SHOT.subject.at)) * CFrame.Angles(0, math.rad(SHOT.subject.yaw or 0), 0))
	pose(char, SHOT.subject.pose)
	char.Parent = rig
end

if SHOT.hero then
	local src = game
	for name in string.gmatch(SHOT.hero.path, "[^%.]+") do
		if src == game and (name == "game" or name == "Workspace" or name == "workspace") then
			src = name == "game" and game or workspace
		else
			src = src:FindFirstChild(name)
			if not src then error("hero not found: " .. SHOT.hero.path, 0) end
		end
	end
	local c = src:Clone()
	if c:IsA("Model") then
		c:PivotTo(CFrame.new(v3(SHOT.hero.at)))
		if SHOT.hero.scale then c:ScaleTo(SHOT.hero.scale) end
	elseif c:IsA("BasePart") then
		c.CFrame = CFrame.new(v3(SHOT.hero.at))
		if SHOT.hero.scale then c.Size = c.Size * SHOT.hero.scale end
	end
	for _, d in c:GetDescendants() do
		if d:IsA("BasePart") then d.Anchored = true end
	end
	if c:IsA("BasePart") then c.Anchored = true end
	c.Parent = rig
end

if SHOT.overlay then
	local cam = CFrame.lookAt(v3(SHOT.camera.position), v3(SHOT.camera.lookAt))
	local D = 10
	local anchor = Instance.new("Part")
	anchor.Name = "OverlayAnchor"
	anchor.Anchored = true
	anchor.CanCollide = false
	anchor.CanQuery = false
	anchor.Transparency = 1
	anchor.Size = Vector3.new(0.1, 0.1, 0.1)
	anchor.CFrame = cam * CFrame.new(0, D * 0.4, -D)
	anchor.Parent = rig
	local bb = Instance.new("BillboardGui")
	bb.AlwaysOnTop = true
	bb.LightInfluence = 0
	bb.Size = UDim2.new(D * 2, 0, D * 0.42, 0)
	bb.Parent = anchor
	local function text(name, str, y, h, color)
		local l = Instance.new("TextLabel")
		l.Name = name
		l.BackgroundTransparency = 1
		l.Size = UDim2.fromScale(1, h)
		l.Position = UDim2.fromScale(0, y)
		l.Font = Enum.Font.GothamBlack
		l.TextScaled = true
		l.Text = str
		l.TextColor3 = color
		l.TextStrokeTransparency = 0
		l.TextStrokeColor3 = Color3.new(0, 0, 0)
		local s = Instance.new("UIStroke")
		s.Thickness = 4
		s.Color = Color3.new(0, 0, 0)
		s.Parent = l
		l.Parent = bb
	end
	local color = SHOT.overlay.color and Color3.fromHex(SHOT.overlay.color) or Color3.new(1, 1, 1)
	text("Text", SHOT.overlay.text, 0, SHOT.overlay.sub and 0.68 or 1, color)
	if SHOT.overlay.sub then text("Sub", SHOT.overlay.sub, 0.7, 0.3, Color3.new(1, 1, 1)) end
end

rig.Parent = workspace
return avatarKind`;
}
