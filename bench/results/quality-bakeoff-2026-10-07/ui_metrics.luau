-- Neutral UI metrics (play client, current device simulator size). Same for every place.
-- Visible GuiObjects in the player's ScreenGuis: tap targets, text size, off-screen, overlapping buttons.
local HttpService = game:GetService("HttpService")
local cam = workspace.CurrentCamera
local vp = cam.ViewportSize
local pg = game:GetService("Players").LocalPlayer:WaitForChild("PlayerGui")
local ENGINE = { Chat = true, BubbleChat = true, TouchGui = true, Freecam = true }

local function visible(g)
	local o = g
	while o and o ~= pg do
		if o:IsA("GuiObject") and not o.Visible then return false end
		if o:IsA("ScreenGui") and not o.Enabled then return false end
		if o:IsA("LayerCollector") and not o:IsA("ScreenGui") then return false end
		o = o.Parent
	end
	return true
end

local inset = game:GetService("GuiService"):GetGuiInset()
local buttons, texts = {}, {}
local small, tiny, offscreen, total = {}, {}, {}, 0
for _, sg in pg:GetChildren() do
	if sg:IsA("ScreenGui") and sg.Enabled and not ENGINE[sg.Name] then
		local off = sg.IgnoreGuiInset and Vector2.zero or inset
		for _, g in sg:GetDescendants() do
			if g:IsA("GuiObject") and visible(g) and g.AbsoluteSize.X > 0 and g.AbsoluteSize.Y > 0 then
				total += 1
				local p = g.AbsolutePosition + off
				local s = g.AbsoluteSize
				if p.X < -1 or p.Y < -1 or p.X + s.X > vp.X + 1 or p.Y + s.Y > vp.Y + 1 then
					if #offscreen < 10 then table.insert(offscreen, g:GetFullName()) end
				end
				local fullscreen = s.X >= vp.X * 0.8 and s.Y >= vp.Y * 0.8 -- modal scrim, not a target
				if g:IsA("GuiButton") and g.Active and not fullscreen then
					table.insert(buttons, { g = g, p = p, s = s })
					if math.min(s.X, s.Y) < 44 then
						table.insert(small, string.format("%s %dx%d", g.Name, s.X, s.Y))
					end
				end
				if (g:IsA("TextLabel") or g:IsA("TextButton") or g:IsA("TextBox")) and g.Text ~= "" and g.TextTransparency < 1 then
					local h = g.TextBounds.Y
					local lines = math.max(1, #string.split(g.ContentText, "\n"))
					local px = h / lines
					table.insert(texts, px)
					if px > 0 and px < 11 then
						table.insert(tiny, string.format("%s %.0fpx '%s'", g.Name, px, string.sub(g.ContentText, 1, 20)))
					end
				end
			end
		end
	end
end
local overlaps = {}
for a = 1, #buttons do
	for b = a + 1, #buttons do
		local A, B = buttons[a], buttons[b]
		if not A.g:IsDescendantOf(B.g) and not B.g:IsDescendantOf(A.g) then
			local ix = math.min(A.p.X + A.s.X, B.p.X + B.s.X) - math.max(A.p.X, B.p.X)
			local iy = math.min(A.p.Y + A.s.Y, B.p.Y + B.s.Y) - math.max(A.p.Y, B.p.Y)
			if ix > 1 and iy > 1 and #overlaps < 10 then
				table.insert(overlaps, A.g.Name .. " x " .. B.g.Name)
			end
		end
	end
end
table.sort(texts)
return HttpService:JSONEncode({
	viewport = { vp.X, vp.Y },
	visibleGuiObjects = total,
	buttons = #buttons,
	smallTapTargets = small,
	tinyText = tiny,
	medianTextPx = texts[math.max(1, math.floor(#texts / 2))] or 0,
	minTextPx = texts[1] or 0,
	offscreen = offscreen,
	overlappingButtons = overlaps,
})
