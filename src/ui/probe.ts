import { longString } from '../studio/luau.js';
import { TOPBAR, type Device, type UiElement } from './lint.js';

// Client-context Luau that lays out the player's GUI at each device size
// without plugin APIs: every enabled PlayerGui ScreenGui's children are cloned
// (scripts stripped) into a Frame of the device's pixel size, inset the way
// that ScreenGui would be on the device. Two frames later the layout engine has
// resolved scale, constraints, list layouts and TextFits; the probe reports
// each visible GuiObject's rect relative to the device.
//
// Inset approximation: IgnoreGuiInset → full screen; otherwise the top bar
// (and a top notch) is excluded, and with ScreenInsets ≠ None the device's
// side/bottom safe insets too.
export function uiProbeProgram(devices: Device[]): string {
  return `local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local player = game:GetService("Players").LocalPlayer
local pg = player:WaitForChild("PlayerGui")
local DEVICES = HttpService:JSONDecode(${longString(JSON.stringify(devices))})
local TOPBAR = ${TOPBAR}
local MAX_ELEMENTS = 2000

local root = Instance.new("ScreenGui")
root.Name = "__BloxUiLint"
root.IgnoreGuiInset = true
root.ScreenInsets = Enum.ScreenInsets.None
root.ResetOnSpawn = false
local sources = {}
for _, g in pg:GetChildren() do
	if g:IsA("ScreenGui") and g.Enabled and g.Name ~= root.Name then
		table.insert(sources, g)
	end
end
local frames = {}
for i, d in DEVICES do
	local D = Instance.new("Frame")
	D.Name = d.name
	D.Size = UDim2.fromOffset(d.w, d.h)
	D.Position = UDim2.fromOffset(100000 + i * 4000, 0) -- off screen; layout still resolves
	D.BackgroundTransparency = 1
	D.Parent = root
	for _, g in sources do
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
	frames[i] = D
end
root.Parent = pg
RunService.RenderStepped:Wait()
RunService.RenderStepped:Wait()

local function rel(o, D)
	local names = {}
	while o and o ~= D do
		table.insert(names, 1, o.Name)
		o = o.Parent
	end
	return table.concat(names, ".")
end
local out = {}
for i, d in DEVICES do
	local D = frames[i]
	local ox, oy = D.AbsolutePosition.X, D.AbsolutePosition.Y
	local els = {}
	for _, o in D:GetDescendants() do
		if #els >= MAX_ELEMENTS then break end
		if o:IsA("GuiObject") and o.Parent ~= D then
			local visible, clipped, hidden = true, false, false
			local x0, y0 = o.AbsolutePosition.X, o.AbsolutePosition.Y
			local x1, y1 = x0 + o.AbsoluteSize.X, y0 + o.AbsoluteSize.Y
			local a = o
			while a and a ~= D do
				if a:IsA("GuiObject") then
					if not a.Visible then visible = false break end
					if a ~= o and a.ClipsDescendants then
						local ax0, ay0 = a.AbsolutePosition.X, a.AbsolutePosition.Y
						local ax1, ay1 = ax0 + a.AbsoluteSize.X, ay0 + a.AbsoluteSize.Y
						if x1 <= ax0 or x0 >= ax1 or y1 <= ay0 or y0 >= ay1 then hidden = true break end
						if x0 < ax0 or y0 < ay0 or x1 > ax1 or y1 > ay1 then clipped = true end
					end
				end
				a = a.Parent
			end
			if visible and not hidden then
				local e = {
					path = rel(o, D), cls = o.ClassName,
					x = x0 - ox, y = y0 - oy, w = o.AbsoluteSize.X, h = o.AbsoluteSize.Y,
					button = o:IsA("GuiButton"), clipped = clipped,
				}
				if o:IsA("TextLabel") or o:IsA("TextButton") or o:IsA("TextBox") then
					e.text = o.Text
					e.textScaled = o.TextScaled
					e.textFits = o.TextFits
					e.textHeight = o.TextBounds.Y
				end
				table.insert(els, e)
			end
		end
	end
	out[d.name] = els
end
root:Destroy()
return HttpService:JSONEncode({ sources = #sources, devices = out })`;
}

export interface ProbeResult {
  sources: number;
  devices: Record<string, UiElement[]>;
}

export function parseProbe(raw: unknown): ProbeResult {
  if (typeof raw !== 'string') throw new Error('ui probe returned no data');
  const j = JSON.parse(raw) as { sources?: number; devices?: Record<string, unknown> };
  const devices: Record<string, UiElement[]> = {};
  for (const [name, els] of Object.entries(j.devices && !Array.isArray(j.devices) ? j.devices : {})) devices[name] = Array.isArray(els) ? (els as UiElement[]) : [];
  return { sources: j.sources ?? 0, devices };
}
