import { longString } from '../studio/luau.js';
import { FIT_LUAU } from './probe.js';
import { TOPBAR, type Device } from './lint.js';

// Edit-mode UI staging (no Play): a mount chunk builds the game's ScreenGuis
// into a Folder that stands in for PlayerGui; lint probes that folder and
// preview lays it out at a device size in StarterGui for a screen capture.
// Edit-context runLuau requires modules fresh, so the chunk can require the
// game's UI modules as they are on disk after a sync.

export const EDIT_HOST = '__BloxUiEdit';
export const PREVIEW_GUI = '__BloxUiPreview';

// Default mount: the static UI the game ships in StarterGui.
const DEFAULT_MOUNT = `for _, g in game:GetService("StarterGui"):GetChildren() do
	if g:IsA("ScreenGui") and string.sub(g.Name, 1, 6) ~= "__Blox" then
		g:Clone().Parent = host
	end
end`;

// mount/state: Luau with \`host\` (the stand-in PlayerGui) in scope. Parent
// ScreenGuis to host, e.g. UI.screen("HUD", host). Returns the ScreenGui count.
export function mountProgram(mount?: string, state?: string): string {
  return `local CoreGui = game:GetService("CoreGui")
local old = CoreGui:FindFirstChild("${EDIT_HOST}")
if old then old:Destroy() end
local host = Instance.new("Folder")
host.Name = "${EDIT_HOST}"
host.Parent = CoreGui
local function __mount(host)
${mount?.trim() || DEFAULT_MOUNT}
end
local function __state(host)
${state?.trim() ?? ''}
end
__mount(host)
__state(host)
local n = 0
for _, g in host:GetChildren() do
	if g:IsA("ScreenGui") then n += 1 end
end
return n`;
}

// Lays the mounted UI out at device d inside StarterGui (shown in the edit
// viewport), scaled to fit the viewport; returns the device rect in viewport px.
export function previewProgram(device: Device): string {
  return `local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local SG = game:GetService("StarterGui")
local host = game:GetService("CoreGui"):FindFirstChild("${EDIT_HOST}")
if not host then error("ui edit host missing: mount the UI first") end
local old = SG:FindFirstChild("${PREVIEW_GUI}")
if old then old:Destroy() end
local d = HttpService:JSONDecode(${longString(JSON.stringify(device))})
local TOPBAR = ${TOPBAR}
SG.ShowDevelopmentGui = true
local out = Instance.new("ScreenGui")
out.Name = "${PREVIEW_GUI}"
out.IgnoreGuiInset = true
out.DisplayOrder = 1000000
out.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
local bg = Instance.new("Frame")
bg.Size = UDim2.fromScale(1, 1)
bg.BackgroundColor3 = Color3.fromRGB(28, 28, 28)
bg.BorderSizePixel = 0
bg.Parent = out
local vp = workspace.CurrentCamera.ViewportSize
local k = math.min(vp.X * 0.97 / d.w, vp.Y * 0.97 / d.h)
local D = Instance.new("Frame")
D.Name = d.name
D.AnchorPoint = Vector2.new(0.5, 0.5)
D.Position = UDim2.fromScale(0.5, 0.5)
D.Size = UDim2.fromOffset(d.w, d.h)
D.BackgroundColor3 = Color3.fromRGB(96, 132, 104) -- stand-in for the 3D world
D.BorderSizePixel = 0
D.ClipsDescendants = true
D.Parent = bg
local sc = Instance.new("UIScale") -- applied after fit: fit reads AbsoluteSize
sc.Scale = 1
sc.Parent = D
-- Roblox's top-bar buttons, so collisions with them show
for i = 0, 1 do
	local t = Instance.new("Frame")
	t.Size = UDim2.fromOffset(44, 44)
	t.Position = UDim2.fromOffset(16 + d.safe.left + i * 52, 6 + d.safe.top)
	t.BackgroundColor3 = Color3.fromRGB(18, 18, 22)
	t.BackgroundTransparency = 0.35
	t.ZIndex = 100
	local c = Instance.new("UICorner")
	c.CornerRadius = UDim.new(0, 10)
	c.Parent = t
	t.Parent = D
end
for _, g in host:GetChildren() do
	if g:IsA("ScreenGui") and g.Enabled then
		local top, left, right, bottom = 0, 0, 0, 0
		if not g.IgnoreGuiInset then
			top = math.max(TOPBAR, d.safe.top)
			if g.ScreenInsets ~= Enum.ScreenInsets.None then
				left, right, bottom = d.safe.left, d.safe.right, d.safe.bottom
			end
		end
		local C = Instance.new("Frame")
		C.Name = g.Name
		C.BackgroundTransparency = 1
		C.Position = UDim2.fromOffset(left, top)
		C.Size = UDim2.new(1, -(left + right), 1, -(top + bottom))
		C.ZIndex = 1 + g.DisplayOrder
		C.Parent = D
		for _, child in g:GetChildren() do
			if not child:IsA("LuaSourceContainer") then
				local ok, c = pcall(function() return child:Clone() end)
				if ok and c then
					for _, s in c:GetDescendants() do
						if s:IsA("LuaSourceContainer") then s:Destroy() end
					end
					c.Parent = C
				end
			end
		end
	end
end
out.Parent = SG
local frames = { D }
RunService.RenderStepped:Wait()
${FIT_LUAU}RunService.RenderStepped:Wait()
sc.Scale = k
RunService.RenderStepped:Wait()
RunService.RenderStepped:Wait()
return HttpService:JSONEncode({ vw = vp.X, vh = vp.Y, x = vp.X / 2 - d.w * k / 2, y = vp.Y / 2 - d.h * k / 2, w = d.w * k, h = d.h * k })`;
}

export const UNSTAGE = `local SG = game:GetService("StarterGui")
local p = SG:FindFirstChild("${PREVIEW_GUI}")
if p then p:Destroy() end
local h = game:GetService("CoreGui"):FindFirstChild("${EDIT_HOST}")
if h then h:Destroy() end
return "ok"`;
