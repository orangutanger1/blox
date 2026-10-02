-- BloxUI: mobile-first HUD components built in code. Everything is sized with
-- Scale plus a UISizeConstraint floor of Theme.minTouch px on buttons, so the
-- same code passes `blox ui lint` on phones, tablets and desktop.
--
--   local UI = require(game.ReplicatedStorage.BloxUI)
--   local gui = UI.screen("HUD")
--   local bar = UI.CurrencyBar(gui, { "coins", "gems" })    bar.set("coins", "1.2K")
--   local rail = UI.Rail(gui, { { id = "Shop", text = "Shop" }, { id = "Rebirth", text = "Rebirth", color = UI.Theme.accent } })
--   rail.buttons.Shop.Activated:Connect(...)
--   local shop = UI.Modal(gui, { name = "Shop", title = "Shop" })   shop.open()  shop.list
--   UI.Row(shop.list, { name = "pet", text = "Pet", action = "10 coins" }).button.Activated:Connect(...)
--   local toasts = UI.Toast(gui)   toasts.show("Saved!")
--   local reveal = UI.Reveal(gui)  reveal.show("Mythic Dragon", "1 in 500")
-- Components only build instances (plus close/expiry wiring); callers connect gameplay.
local Theme = require(script.Theme)

local BloxUI = { Theme = Theme }

local function connect(inst: Instance, signal: string, fn)
	-- Signals are absent when built outside the engine (offline tests); skip quietly.
	local ok, sig = pcall(function()
		return (inst :: any)[signal]
	end)
	if ok and sig then
		sig:Connect(fn)
	end
end

local function corner(p: Instance, r: number?)
	local c = Instance.new("UICorner")
	c.CornerRadius = UDim.new(0, r or Theme.radius)
	c.Parent = p
end

local function stroke(p: Instance)
	local s = Instance.new("UIStroke")
	s.Color = Theme.stroke
	s.Thickness = 2
	s.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
	s.Parent = p
end

local function textSize(p: Instance)
	local t = Instance.new("UITextSizeConstraint")
	t.MaxTextSize = Theme.maxText
	t.MinTextSize = Theme.minText
	t.Parent = p
end

local function minSize(p: Instance, w: number, h: number)
	local c = Instance.new("UISizeConstraint")
	c.MinSize = Vector2.new(w, h)
	c.Parent = p
end

function BloxUI.label(parent: Instance, name: string, text: string, opts: any?)
	opts = opts or {}
	local l = Instance.new("TextLabel")
	l.Name = name
	l.BackgroundTransparency = 1
	l.Size = opts.size or UDim2.fromScale(1, 1)
	l.Position = opts.position or UDim2.fromScale(0, 0)
	l.Font = opts.font or Theme.font
	l.TextColor3 = opts.color or Theme.text
	l.TextScaled = true
	l.Text = text
	l.TextXAlignment = opts.align or Enum.TextXAlignment.Center
	textSize(l)
	l.Parent = parent
	return l
end

-- ScreenGui in the safe area (excludes the top bar and notches).
function BloxUI.screen(name: string, parent: Instance?)
	local gui = Instance.new("ScreenGui")
	gui.Name = name
	gui.ResetOnSpawn = false
	gui.IgnoreGuiInset = false
	gui.ScreenInsets = Enum.ScreenInsets.CoreUISafeInsets
	gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
	if parent then
		gui.Parent = parent
	else
		local ok, pg = pcall(function()
			local lp = game:GetService("Players").LocalPlayer
			return lp and lp:FindFirstChildOfClass("PlayerGui")
		end)
		if ok and pg then
			gui.Parent = pg
		end
	end
	return gui
end

-- opts: name, text, color, size (UDim2, scale), position, anchor, round (square+circle)
function BloxUI.Button(parent: Instance, opts: any)
	local b = Instance.new("TextButton")
	b.Name = opts.name or "Button"
	b.Text = opts.text or ""
	b.Font = Theme.font
	b.TextColor3 = Theme.text
	b.TextScaled = true
	b.AutoButtonColor = true
	b.BackgroundColor3 = opts.color or Theme.primary
	b.Size = opts.size or UDim2.fromScale(0.2, 0.1)
	b.Position = opts.position or UDim2.fromScale(0, 0)
	b.AnchorPoint = opts.anchor or Vector2.new(0, 0)
	corner(b, opts.round and 999 or nil)
	stroke(b)
	textSize(b)
	minSize(b, Theme.minTouch, Theme.minTouch)
	if opts.round then
		local a = Instance.new("UIAspectRatioConstraint")
		a.AspectRatio = 1
		a.Parent = b
	end
	local pad = Instance.new("UIPadding")
	pad.PaddingLeft = UDim.new(0.08, 0)
	pad.PaddingRight = UDim.new(0.08, 0)
	pad.PaddingTop = UDim.new(0.12, 0)
	pad.PaddingBottom = UDim.new(0.12, 0)
	pad.Parent = b
	b.Parent = parent
	return b
end

-- Top-centre counters. Returns { frame, labels, set(id, text) }.
function BloxUI.CurrencyBar(parent: Instance, ids: { string }, opts: any?)
	opts = opts or {}
	local bar = Instance.new("Frame")
	bar.Name = opts.name or "Currencies"
	bar.AnchorPoint = Vector2.new(0.5, 0)
	bar.Position = UDim2.fromScale(0.5, 0.01)
	bar.Size = UDim2.fromScale(math.min(0.9, 0.22 * #ids), 0.08)
	bar.BackgroundTransparency = 1
	minSize(bar, 120 * #ids, 36)
	local layout = Instance.new("UIListLayout")
	layout.FillDirection = Enum.FillDirection.Horizontal
	layout.HorizontalAlignment = Enum.HorizontalAlignment.Center
	layout.Padding = UDim.new(0.02, 0)
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Parent = bar
	local labels = {}
	for i, id in ids do
		local pill = Instance.new("Frame")
		pill.Name = id
		pill.LayoutOrder = i
		pill.Size = UDim2.fromScale(1 / #ids - 0.02, 1)
		pill.BackgroundColor3 = Theme.panel
		pill.BackgroundTransparency = 0.15
		corner(pill, 999)
		stroke(pill)
		labels[id] = BloxUI.label(
			pill,
			"Value",
			id .. ": 0",
			{ size = UDim2.fromScale(0.9, 0.8), position = UDim2.fromScale(0.05, 0.1) }
		)
		pill.Parent = bar
	end
	bar.Parent = parent
	return {
		frame = bar,
		labels = labels,
		set = function(id: string, text: string)
			if labels[id] then
				labels[id].Text = text
			end
		end,
	}
end

-- Vertical rail of round buttons (left by default). items: { {id, text, color?} }.
function BloxUI.Rail(parent: Instance, items: { any }, opts: any?)
	opts = opts or {}
	local right = opts.side == "right"
	local rail = Instance.new("Frame")
	rail.Name = opts.name or "Rail"
	rail.AnchorPoint = Vector2.new(right and 1 or 0, 0.5)
	rail.Position = UDim2.fromScale(right and 0.99 or 0.01, 0.55)
	rail.Size = UDim2.fromScale(0.09, 0.6)
	rail.BackgroundTransparency = 1
	minSize(rail, 56, 56 * #items)
	local layout = Instance.new("UIListLayout")
	layout.Padding = UDim.new(0.03, 0)
	layout.VerticalAlignment = Enum.VerticalAlignment.Center
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Parent = rail
	local buttons = {}
	for i, it in items do
		local b = BloxUI.Button(rail, {
			name = it.id,
			text = it.text or it.id,
			color = it.color or Theme.info,
			size = UDim2.fromScale(1, 1),
			round = true,
		})
		b.LayoutOrder = i
		buttons[it.id] = b
	end
	rail.Parent = parent
	return { frame = rail, buttons = buttons }
end

-- Centre modal: title, close button, optional tabs, scrolling list. Hidden until open().
function BloxUI.Modal(parent: Instance, opts: any)
	local m = Instance.new("Frame")
	m.Name = opts.name or "Modal"
	m.AnchorPoint = Vector2.new(0.5, 0.5)
	m.Position = UDim2.fromScale(0.5, 0.5)
	m.Size = UDim2.fromScale(0.62, 0.78)
	m.BackgroundColor3 = Theme.panel
	m.Visible = false
	corner(m, 16)
	stroke(m)
	local limits = Instance.new("UISizeConstraint")
	limits.MinSize = Vector2.new(280, 220)
	limits.MaxSize = Vector2.new(760, 600)
	limits.Parent = m
	BloxUI.label(m, "Title", opts.title or m.Name, {
		size = UDim2.fromScale(0.7, 0.12),
		position = UDim2.fromScale(0.04, 0.02),
		font = Theme.fontHeavy,
		align = Enum.TextXAlignment.Left,
	})
	local close = BloxUI.Button(m, {
		name = "Close",
		text = "X",
		color = Theme.danger,
		size = UDim2.fromScale(0.12, 0.12),
		position = UDim2.fromScale(0.97, 0.02),
		anchor = Vector2.new(1, 0),
		round = true,
	})
	local top = 0.17
	local tabs = {}
	if opts.tabs and #opts.tabs > 0 then
		local strip = Instance.new("Frame")
		strip.Name = "Tabs"
		strip.BackgroundTransparency = 1
		strip.Position = UDim2.fromScale(0.04, 0.16)
		strip.Size = UDim2.fromScale(0.92, 0.12)
		local l = Instance.new("UIListLayout")
		l.FillDirection = Enum.FillDirection.Horizontal
		l.Padding = UDim.new(0.02, 0)
		l.Parent = strip
		for _, t in opts.tabs do
			tabs[t] = BloxUI.Button(strip, {
				name = t,
				text = t,
				color = Theme.panelAlt,
				size = UDim2.fromScale(1 / #opts.tabs - 0.02, 1),
			})
		end
		strip.Parent = m
		top = 0.31
	end
	local list = Instance.new("ScrollingFrame")
	list.Name = "List"
	list.BackgroundTransparency = 1
	list.BorderSizePixel = 0
	list.Position = UDim2.fromScale(0.04, top)
	list.Size = UDim2.fromScale(0.92, 0.97 - top)
	list.AutomaticCanvasSize = Enum.AutomaticSize.Y
	list.CanvasSize = UDim2.new()
	list.ScrollBarThickness = 6
	local ll = Instance.new("UIListLayout")
	ll.Padding = UDim.new(0, 8)
	ll.SortOrder = Enum.SortOrder.LayoutOrder
	ll.Parent = list
	list.Parent = m
	m.Parent = parent
	local api = { frame = m, close = close, list = list, tabs = tabs }
	function api.open()
		m.Visible = true
	end
	function api.hide()
		m.Visible = false
	end
	function api.toggle()
		m.Visible = not m.Visible
	end
	connect(close, "Activated", api.hide)
	return api
end

-- List row: name label on the left, action button on the right. Fixed height
-- (rows scroll), so it stays >= the touch floor on every screen.
function BloxUI.Row(list: Instance, opts: any)
	local row = Instance.new("Frame")
	row.Name = opts.name or "Row"
	row.Size = UDim2.new(1, -10, 0, 60)
	row.BackgroundColor3 = Theme.panelAlt
	row.LayoutOrder = opts.order or 0
	corner(row, 10)
	local label = BloxUI.label(row, "Label", opts.text or row.Name, {
		size = UDim2.fromScale(0.58, 0.7),
		position = UDim2.fromScale(0.03, 0.15),
		align = Enum.TextXAlignment.Left,
	})
	local button = BloxUI.Button(row, {
		name = "Action",
		text = opts.action or "Buy",
		size = UDim2.fromScale(0.34, 0.8),
		position = UDim2.fromScale(0.98, 0.5),
		anchor = Vector2.new(1, 0.5),
	})
	row.Parent = list
	return { frame = row, label = label, button = button }
end

-- Toast stack above the bottom edge. show(text, seconds?) → label (auto-removed).
function BloxUI.Toast(parent: Instance)
	local stack = Instance.new("Frame")
	stack.Name = "Toasts"
	stack.AnchorPoint = Vector2.new(0.5, 1)
	stack.Position = UDim2.fromScale(0.5, 0.97)
	stack.Size = UDim2.fromScale(0.5, 0.3)
	stack.BackgroundTransparency = 1
	local l = Instance.new("UIListLayout")
	l.VerticalAlignment = Enum.VerticalAlignment.Bottom
	l.HorizontalAlignment = Enum.HorizontalAlignment.Center
	l.Padding = UDim.new(0, 6)
	l.SortOrder = Enum.SortOrder.LayoutOrder
	l.Parent = stack
	stack.Parent = parent
	local n = 0
	return {
		frame = stack,
		show = function(text: string, seconds: number?)
			n += 1
			local t = Instance.new("Frame")
			t.Name = "Toast" .. n
			t.LayoutOrder = n
			t.Size = UDim2.new(1, 0, 0, 40)
			t.BackgroundColor3 = Theme.panel
			t.BackgroundTransparency = 0.1
			corner(t, 999)
			BloxUI.label(
				t,
				"Text",
				text,
				{ size = UDim2.fromScale(0.94, 0.8), position = UDim2.fromScale(0.03, 0.1) }
			)
			t.Parent = stack
			local kids = 0
			for _, c in stack:GetChildren() do
				if c:IsA("Frame") then
					kids += 1
				end
			end
			if kids > 4 then
				for _, c in stack:GetChildren() do
					if c:IsA("Frame") and c ~= t then
						c:Destroy()
						break
					end
				end
			end
			task.delay(seconds or 2.5, function()
				if t.Parent then
					t:Destroy()
				end
			end)
			return t
		end,
	}
end

-- Full-screen reward reveal: show(title, subtitle?) / hide(); tap "Nice!" to close.
function BloxUI.Reveal(parent: Instance)
	local shade = Instance.new("Frame")
	shade.Name = "Reveal"
	shade.Size = UDim2.fromScale(1, 1)
	shade.BackgroundColor3 = Color3.new(0, 0, 0)
	shade.BackgroundTransparency = 0.35
	shade.Visible = false
	local card = Instance.new("Frame")
	card.Name = "Card"
	card.AnchorPoint = Vector2.new(0.5, 0.5)
	card.Position = UDim2.fromScale(0.5, 0.5)
	card.Size = UDim2.fromScale(0.45, 0.6)
	card.BackgroundColor3 = Theme.panel
	corner(card, 20)
	stroke(card)
	local lim = Instance.new("UISizeConstraint")
	lim.MinSize = Vector2.new(260, 200)
	lim.Parent = card
	local title = BloxUI.label(
		card,
		"Title",
		"",
		{ size = UDim2.fromScale(0.9, 0.3), position = UDim2.fromScale(0.05, 0.12), font = Theme.fontHeavy }
	)
	local sub = BloxUI.label(
		card,
		"Subtitle",
		"",
		{ size = UDim2.fromScale(0.9, 0.16), position = UDim2.fromScale(0.05, 0.45), color = Theme.textDim }
	)
	local ok = BloxUI.Button(card, {
		name = "Ok",
		text = "Nice!",
		size = UDim2.fromScale(0.5, 0.18),
		position = UDim2.fromScale(0.5, 0.92),
		anchor = Vector2.new(0.5, 1),
	})
	card.Parent = shade
	shade.Parent = parent
	local api = { frame = shade, ok = ok }
	function api.show(t: string, s: string?)
		title.Text = t
		sub.Text = s or ""
		shade.Visible = true
	end
	function api.hide()
		shade.Visible = false
	end
	connect(ok, "Activated", api.hide)
	return api
end

return BloxUI
