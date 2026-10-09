import { longString } from '../studio/luau.js';
import { TOPBAR, type Device, type UiElement } from './lint.js';
import { EDIT_HOST } from './stage.js';

// Client-context Luau that lays out the player's GUI at each device size
// without plugin APIs: every enabled PlayerGui ScreenGui's children are cloned
// (scripts stripped) into a Frame of the device's pixel size, inset the way
// that ScreenGui would be on the device. A GuiButton with Interactable=false (art
// inside a bigger hit area) is not a touch target. Two frames later the layout engine has
// resolved scale, constraints, list layouts and TextFits; the probe reports
// each visible GuiObject's rect relative to the device.
//
// execute_luau replies are capped (live: 50KB fine, 100KB cut off), so one call
// lays out one device and returns elements from index SKIP until about BUDGET
// characters of JSON, with \`next\` = where the following call resumes (null when
// done). Layout is rebuilt each call; descendant order of the clones is stable.
//
// Inset approximation: IgnoreGuiInset → full screen; otherwise the top bar
// (and a top notch) is excluded, and with ScreenInsets ≠ None the device's
// side/bottom safe insets too.
export const PROBE_BUDGET = 20_000;

// Recomputes BloxUI.fit scales for the device frames in \`frames\` (scripts were
// stripped from the clones, so their own fit handlers never run). Sets \`fitted\`.
export const FIT_LUAU = `-- BloxUI.fit scales: recompute for this device from the attributes (scripts were stripped)
local fitted = false
for _, D in frames do
	for _, s in D:GetDescendants() do
		local h, w = s:GetAttribute("BloxFitHeight"), s:GetAttribute("BloxFitWidth")
		if s:IsA("UIScale") and (h or w) and s.Parent and s.Parent.Parent and s.Parent.Parent:IsA("GuiBase2d") then
			local size = s.Parent.Parent.AbsoluteSize
			local k = math.huge
			if (h or 0) > 0 then k = math.min(k, size.Y / h) end
			if (w or 0) > 0 then k = math.min(k, size.X / w) end
			if k == math.huge then k = 1 end
			k = math.clamp(k, s:GetAttribute("BloxFitMin") or 0.5, s:GetAttribute("BloxFitMax") or 1.5)
			s.Scale = k
			if s:GetAttribute("BloxFitFill") ~= false and s.Parent:IsA("GuiObject") then
				s.Parent.Size = UDim2.fromScale(1 / k, 1 / k)
			end
			fitted = true
		end
	end
end
`;
const MAX_ELEMENTS = 2000;

// root 'edit': lay out what a mount staged in CoreGui.${EDIT_HOST} (no Play).
export function uiProbeProgram(device: Device, skip = 0, budget = PROBE_BUDGET, root: 'player' | 'edit' = 'player'): string {
  const pgLuau = root === 'edit'
    ? `local pg = game:GetService("CoreGui"):FindFirstChild("${EDIT_HOST}")\nif not pg then error("ui edit host missing: mount the UI first") end`
    : `local player = game:GetService("Players").LocalPlayer\nlocal pg = player:WaitForChild("PlayerGui")`;
  return `local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
${pgLuau}
local DEVICES = { HttpService:JSONDecode(${longString(JSON.stringify(device))}) }
local TOPBAR = ${TOPBAR}
local SKIP = ${Math.max(0, Math.floor(skip))}
local BUDGET = ${Math.max(1, Math.floor(budget))}
local MAX_ELEMENTS = ${MAX_ELEMENTS}

local root = Instance.new("ScreenGui")
root.Name = "__BloxUiLint"
root.IgnoreGuiInset = true
root.ScreenInsets = Enum.ScreenInsets.None
root.ResetOnSpawn = false
-- Roblox-injected GUIs (legacy chat, mobile thumbstick, freecam) are not the game's UI.
local ENGINE_GUIS = { Chat = true, BubbleChat = true, TouchGui = true, Freecam = true }
local sources = {}
for _, g in pg:GetChildren() do
	if g:IsA("ScreenGui") and g.Enabled and g.Name ~= root.Name and not ENGINE_GUIS[g.Name] then
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
${FIT_LUAU}if fitted then RunService.RenderStepped:Wait() end
RunService.RenderStepped:Wait()

local function rel(o, D)
	local names = {}
	while o and o ~= D do
		table.insert(names, 1, o.Name)
		o = o.Parent
	end
	return table.concat(names, ".")
end
local D = frames[1]
local ox, oy = D.AbsolutePosition.X, D.AbsolutePosition.Y
local els, idx, used, nextSkip = {}, 0, 0, nil
for _, o in D:GetDescendants() do
	if idx >= MAX_ELEMENTS then break end
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
			idx += 1
			if idx > SKIP then
				local e = {
					path = rel(o, D), cls = o.ClassName,
					x = x0 - ox, y = y0 - oy, w = o.AbsoluteSize.X, h = o.AbsoluteSize.Y,
					button = o:IsA("GuiButton") and o.Interactable, clipped = clipped,
				}
				if o.Rotation ~= 0 then
					e.rot = o.Rotation
				end
				if o:IsA("TextLabel") or o:IsA("TextButton") or o:IsA("TextBox") then
					e.text = string.sub(o.Text, 1, 200)
					e.textScaled = o.TextScaled
					e.textFits = o.TextFits
					e.textHeight = o.TextBounds.Y
				end
				local lay = o.Parent and o.Parent:FindFirstChildWhichIsA("UIGridStyleLayout")
				if lay then
					e.listed = if lay:IsA("UIListLayout") then (if lay.FillDirection == Enum.FillDirection.Vertical then "y" else "x") else "xy"
				end
				if e.button then
					local c = o:FindFirstChildOfClass("UICorner")
					local sh = o:FindFirstChild("Shadow")
					if not c and sh then c = sh:FindFirstChildOfClass("UICorner") end
					if c then
						local m = math.min(o.AbsoluteSize.X, o.AbsoluteSize.Y)
						e.cr = math.min(m / 2, c.CornerRadius.Offset + c.CornerRadius.Scale * m)
					end
				end
				local cost = #HttpService:JSONEncode(e) + 1
				if used > 0 and used + cost > BUDGET then nextSkip = idx - 1 break end
				used += cost
				table.insert(els, e)
			end
		end
	end
end
root:Destroy()
return HttpService:JSONEncode({ sources = #sources, device = DEVICES[1].name, elements = els, next = nextSkip })`;
}

export interface ProbePage {
  sources: number;
  device: string;
  elements: UiElement[];
  next: number | null;
}

export function parseProbePage(raw: unknown): ProbePage {
  if (typeof raw !== 'string') throw new Error('ui probe returned no data');
  const j = JSON.parse(raw) as { sources?: number; device?: string; elements?: unknown; next?: unknown };
  return {
    sources: j.sources ?? 0,
    device: j.device ?? '',
    elements: Array.isArray(j.elements) ? (j.elements as UiElement[]) : [],
    next: typeof j.next === 'number' ? j.next : null,
  };
}
