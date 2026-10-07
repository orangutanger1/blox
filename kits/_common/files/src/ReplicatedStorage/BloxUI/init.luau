-- BloxUI: mobile-first game UI built in code, in the "depth stack" look of top
-- Roblox games: every panel, tile and button has a blue-shifted drop shadow, a
-- face gradient, a light strip under the top edge and an even outline, with
-- square-ish corners (never pills) and white text with a dark outline.
-- Everything is sized with Scale plus a UISizeConstraint floor of
-- Theme.minTouch px on buttons, so the same code passes `blox ui lint` on
-- phones, tablets and desktop.
--
--   local UI = require(game.ReplicatedStorage.BloxUI)
--   local gui = UI.screen("HUD")
--   local bar = UI.CurrencyBar(gui, { "coins", "gems" })    bar.set("coins", "1.2K")
--   local rail = UI.Rail(gui, { { id = "Shop", text = "Shop" }, { id = "Rebirth", text = "Rebirth", color = "accent" } })
--   rail.buttons.Shop.Activated:Connect(...)
--   local shop = UI.Modal(gui, { name = "Shop", title = "Shop" })   shop.open()  shop.list
--   UI.Tile(shop.list, { name = "pistol", title = "Pistol", subtitle = "17 dmg", icon = "rbxassetid://…", action = "Buy" })
--   local tabs = UI.Tabs(sidebar, { "Shop", "Inventory" }, { vertical = true })   tabs.select("Inventory")
--   local ask = UI.Dialog(gui, { title = "Buy Uzi?", confirm = "Buy", cancel = "Cancel" })   ask.show("$600")
--   local win = UI.Panel(gui, { title = "SETTINGS" })   (win.body holds your content)
--   local toasts = UI.Toast(gui)   toasts.show("Saved!")   (one shared stack per client)
--   local reveal = UI.Reveal(gui)  reveal.show("Mythic Dragon", "1 in 500")
--   UI.depth(myFrame, "warn")   (the stack on any frame of your own)
--   UI.fit(hudScale, { height = 800, width = 560, min = 0.57 })  (offset-designed HUD → every device)
-- `color` is a Theme.styles name (primary, info, warn, danger, accent, tab,
-- tabActive, panel, row, slot, dark, disabled, locked) or a Color3.
-- Components only build instances (plus close/expiry/tab wiring); callers connect gameplay.
-- No decoration: icons appear only where the caller passes an image id.
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

local function onChanged(inst: Instance, prop: string, fn)
	pcall(function()
		inst:GetPropertyChangedSignal(prop):Connect(fn)
	end)
end

local function corner(p: Instance, r: number?)
	local c = Instance.new("UICorner")
	c.CornerRadius = UDim.new(0, r or Theme.radius)
	c.Parent = p
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

-- Windows and HUD pieces are laid out in design px and scaled to the screen by
-- BloxUI.fit (like top games): the scale never drops below FIT_MIN, so a 62 px
-- design button stays >= the 44 px touch floor on phones (a UIScale shrinks
-- past UISizeConstraint floors).
local FIT_MIN, FIT_MAX = 0.72, 1.6
BloxUI.designTouch = math.ceil(Theme.minTouch / FIT_MIN) -- 62: smallest design-px button
local function designFit(frame: GuiObject, opts: any)
	local s = Instance.new("UIScale")
	s.Name = "Fit"
	s.Parent = frame
	BloxUI.fit(
		s,
		{ width = opts.width, height = opts.height, min = FIT_MIN, max = opts.max or FIT_MAX, fill = false }
	)
	return s
end
local HUD_FIT = { width = 600, height = 600, max = 1.5 }

-- name | Color3 | style table → { top, bottom, stroke, lift }
function BloxUI.style(s: any)
	if typeof(s) == "string" then
		return assert(Theme.styles[s], "BloxUI: no style " .. s)
	elseif typeof(s) == "Color3" then
		local white, black = Color3.new(1, 1, 1), Color3.new(0, 0, 0)
		return {
			top = s:Lerp(white, 0.25),
			bottom = s:Lerp(black, 0.1),
			stroke = s:Lerp(black, 0.55),
			lift = 0.5,
		}
	end
	return s or Theme.styles.panel
end

-- Puts the depth stack on a holder frame and returns the face. The holder turns
-- transparent (it stays the layout item and the hit box); Shadow (ZIndex 0)
-- holds Face, so content children (ZIndex >= 1) draw above both. Calling it
-- again restyles (e.g. a selected tab). Put a UIListLayout in a child, not the
-- holder, or the shadow becomes a list item.
function BloxUI.depth(holder: GuiObject, s: any?, opts: any?): Frame
	opts = opts or {}
	local st = BloxUI.style(s)
	local D = Theme.depth
	local r = opts.radius or Theme.radius
	local old = holder:FindFirstChild("Shadow")
	if old then
		old:Destroy()
	end
	holder.BackgroundTransparency = 1
	local shadow = Instance.new("Frame")
	shadow.Name = "Shadow"
	shadow.BorderSizePixel = 0
	shadow.BackgroundColor3 = D.shadow
	shadow.BackgroundTransparency = D.shadowTransparency
	shadow.Position = UDim2.fromOffset(0, D.shadowOffset)
	shadow.Size = UDim2.fromScale(1, 1)
	shadow.ZIndex = 0
	corner(shadow, r)
	local face = Instance.new("Frame")
	face.Name = "Face"
	face.BorderSizePixel = 0
	face.BackgroundColor3 = Color3.new(1, 1, 1)
	face.Position = UDim2.fromOffset(0, -D.shadowOffset)
	face.Size = UDim2.fromScale(1, 1)
	face.ZIndex = 0
	corner(face, r)
	local g = Instance.new("UIGradient")
	g.Rotation = 90
	g.Color =
		ColorSequence.new({ ColorSequenceKeypoint.new(0, st.top), ColorSequenceKeypoint.new(1, st.bottom) })
	g.Parent = face
	local o = Instance.new("UIStroke")
	o.Color = st.stroke
	o.Thickness = D.outline
	o.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
	o.LineJoinMode = Enum.LineJoinMode.Round
	o.Parent = face
	if (st.lift or 0) > 0 then
		local inset = math.floor(r / 2) + math.ceil(D.outline)
		local lift = Instance.new("Frame")
		lift.Name = "Lift"
		lift.BorderSizePixel = 0
		lift.BackgroundColor3 = Color3.new(1, 1, 1)
		lift.BackgroundTransparency = 1 - st.lift * 0.75
		lift.Position = UDim2.fromOffset(inset, math.ceil(D.outline) + 1)
		lift.Size = UDim2.new(1, -2 * inset, 0, D.liftHeight)
		lift.ZIndex = 0
		corner(lift, math.floor(D.liftHeight / 2))
		lift.Parent = face
	end
	face.Parent = shadow
	shadow.Parent = holder
	return face
end

-- White text with a dark outline (opts.outline = false for none).
function BloxUI.label(parent: Instance, name: string, text: string, opts: any?)
	opts = opts or {}
	local l = Instance.new("TextLabel")
	l.Name = name
	l.BackgroundTransparency = 1
	l.Size = opts.size or UDim2.fromScale(1, 1)
	l.Position = opts.position or UDim2.fromScale(0, 0)
	l.AnchorPoint = opts.anchor or Vector2.new(0, 0)
	l.Font = opts.font or Theme.font
	l.TextColor3 = opts.color or Theme.text
	l.TextScaled = true
	l.Text = text
	l.TextXAlignment = opts.align or Enum.TextXAlignment.Center
	l.ZIndex = 1
	if opts.outline ~= false then
		local s = Instance.new("UIStroke")
		s.Color = Theme.textStroke
		s.Thickness = Theme.depth.textStroke
		s.ApplyStrokeMode = Enum.ApplyStrokeMode.Contextual
		s.Parent = l
	end
	textSize(l)
	l.Parent = parent
	return l
end

-- ScreenGui in the safe area (excludes the top bar and notches).
-- Responsive UIScale for a HUD laid out in offsets at a design size:
-- Scale = clamp(min(H / height, W / width), min, max), where W×H is the size of
-- the scaled frame's parent (the screen for a full-screen frame). fill (default
-- true) resizes the scaled frame to 1/Scale of its parent so it still covers the
-- screen and scale-positioned children (a centred bar) stay screen-relative.
-- Settings live in attributes so `blox ui lint`, which lays out clones without
-- scripts, applies the same scale on each device it emulates.
export type FitOptions = { height: number?, width: number?, min: number?, max: number?, fill: boolean? }

function BloxUI.fitScale(size: Vector2, opts: FitOptions): number
	local k = math.huge
	if (opts.height or 0) > 0 then
		k = math.min(k, size.Y / opts.height :: number)
	end
	if (opts.width or 0) > 0 then
		k = math.min(k, size.X / opts.width :: number)
	end
	if k == math.huge then
		k = 1
	end
	return math.clamp(k, opts.min or 0.5, opts.max or 1.5)
end

function BloxUI.fit(scale: UIScale, opts: FitOptions)
	scale:SetAttribute("BloxFitHeight", opts.height or 0)
	scale:SetAttribute("BloxFitWidth", opts.width or 0)
	scale:SetAttribute("BloxFitMin", opts.min or 0.5)
	scale:SetAttribute("BloxFitMax", opts.max or 1.5)
	scale:SetAttribute("BloxFitFill", opts.fill ~= false)
	local target = scale.Parent :: GuiObject?
	local host = target and target.Parent
	if not target or not host then
		return
	end
	local function apply()
		local ok, size = pcall(function()
			return (host :: any).AbsoluteSize :: Vector2
		end)
		if not ok or size.X <= 0 or size.Y <= 0 then
			return
		end
		local k = BloxUI.fitScale(size, opts)
		scale.Scale = k
		if opts.fill ~= false then
			target.Size = UDim2.fromScale(1 / k, 1 / k)
		end
	end
	apply()
	pcall(function()
		(host :: any):GetPropertyChangedSignal("AbsoluteSize"):Connect(apply)
	end)
end

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

-- opts: name, text, color (style name | Color3), size (UDim2, scale), position, anchor,
-- round (square: aspect 1), icon (image id, left of the text), disabled, radius.
-- The TextButton is the hit box; its Text is shown by the outlined `Label` child.
function BloxUI.Button(parent: Instance, opts: any)
	local b = Instance.new("TextButton")
	b.Name = opts.name or "Button"
	b.Text = opts.text or ""
	b.TextTransparency = 1
	b.Font = Theme.font
	b.TextScaled = true
	b.AutoButtonColor = false
	b.Active = not opts.disabled
	b.Size = opts.size or UDim2.fromScale(0.2, 0.1)
	b.Position = opts.position or UDim2.fromScale(0, 0)
	b.AnchorPoint = opts.anchor or Vector2.new(0, 0)
	BloxUI.depth(b, if opts.disabled then "disabled" else (opts.color or "primary"), { radius = opts.radius })
	minSize(b, Theme.minTouch, Theme.minTouch)
	if opts.round then
		local a = Instance.new("UIAspectRatioConstraint")
		a.AspectRatio = 1
		a.Parent = b
	end
	local x = 0.08
	if opts.icon then
		local i = Instance.new("ImageLabel")
		i.Name = "Icon"
		i.BackgroundTransparency = 1
		i.Image = opts.icon
		i.ScaleType = Enum.ScaleType.Fit
		i.AnchorPoint = Vector2.new(0, 0.5)
		i.Position = UDim2.fromScale(0.06, 0.5)
		i.Size = UDim2.fromScale(0.3, 0.7)
		i.ZIndex = 1
		i.Parent = b
		x = 0.36
	end
	local label = BloxUI.label(b, "Label", b.Text, {
		size = UDim2.fromScale(1 - x - 0.08, 0.72),
		position = UDim2.fromScale(x, 0.14),
	})
	onChanged(b, "Text", function()
		label.Text = b.Text
	end)
	local press = Instance.new("UIScale")
	press.Name = "Press"
	press.Parent = b
	connect(b, "MouseButton1Down", function()
		if b.Active then
			press.Scale = Theme.depth.press
		end
	end)
	connect(b, "MouseButton1Up", function()
		press.Scale = 1
	end)
	connect(b, "MouseLeave", function()
		press.Scale = 1
	end)
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
	local w, h = opts.width or 170, opts.height or 46 -- design px per counter
	bar.Size = UDim2.fromOffset(w * #ids + 10 * (#ids - 1), h)
	bar.BackgroundTransparency = 1
	local layout = Instance.new("UIListLayout")
	layout.FillDirection = Enum.FillDirection.Horizontal
	layout.HorizontalAlignment = Enum.HorizontalAlignment.Center
	layout.Padding = UDim.new(0, 10)
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Parent = bar
	local labels = {}
	for i, id in ids do
		local box = Instance.new("Frame")
		box.Name = id
		box.LayoutOrder = i
		box.Size = UDim2.fromOffset(w, h)
		BloxUI.depth(box, opts.color or "dark")
		labels[id] = BloxUI.label(
			box,
			"Value",
			id .. ": 0",
			{ size = UDim2.fromScale(0.9, 0.76), position = UDim2.fromScale(0.05, 0.12) }
		)
		box.Parent = bar
	end
	bar.Parent = parent
	designFit(bar, HUD_FIT)
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

-- Vertical rail of square buttons (left by default). items: { {id, text, color?, icon?} }.
function BloxUI.Rail(parent: Instance, items: { any }, opts: any?)
	opts = opts or {}
	local right = opts.side == "right"
	local rail = Instance.new("Frame")
	rail.Name = opts.name or "Rail"
	rail.AnchorPoint = Vector2.new(right and 1 or 0, 0.5)
	rail.Position = UDim2.fromScale(right and 0.99 or 0.01, 0.55)
	local cell = opts.size or 72 -- design px per button
	rail.Size = UDim2.fromOffset(cell, cell * #items + 10 * (#items - 1))
	rail.BackgroundTransparency = 1
	local layout = Instance.new("UIListLayout")
	layout.Padding = UDim.new(0, 10)
	layout.VerticalAlignment = Enum.VerticalAlignment.Center
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Parent = rail
	local buttons = {}
	for i, it in items do
		local b = BloxUI.Button(rail, {
			name = it.id,
			text = it.text or it.id,
			color = it.color or "info",
			icon = it.icon,
			size = UDim2.fromOffset(cell, cell),
			round = true,
		})
		b.LayoutOrder = i
		buttons[it.id] = b
	end
	rail.Parent = parent
	designFit(rail, HUD_FIT)
	return { frame = rail, buttons = buttons }
end

-- The close button's X: two crossed white bars with a dark outline (a font "X"
-- sits off-centre and changes with the font).
local function closeButton(parent: Instance, size: UDim2, position: UDim2, anchor: Vector2)
	local close = BloxUI.Button(parent, {
		name = "Close",
		text = "",
		color = "danger",
		size = size,
		position = position,
		anchor = anchor,
		round = true,
	})
	for _, rot in { 45, -45 } do
		local bar = Instance.new("Frame")
		bar.Name = "Bar"
		bar.AnchorPoint = Vector2.new(0.5, 0.5)
		bar.Position = UDim2.fromScale(0.5, 0.5)
		bar.Size = UDim2.fromScale(0.6, 0.15)
		bar.Rotation = rot
		bar.BackgroundColor3 = Theme.text
		bar.BorderSizePixel = 0
		bar.ZIndex = 2
		corner(bar, 2)
		local s = Instance.new("UIStroke")
		s.Color = Theme.textStroke
		s.Thickness = 1.5
		s.Parent = bar
		bar.Parent = close
	end
	return close
end

-- Titled window: { frame, title, close?, body, open, hide, toggle }. opts: name,
-- title, color, size, position, close (default true), hidden.
function BloxUI.Panel(parent: Instance, opts: any)
	local p = Instance.new("Frame")
	p.Name = opts.name or "Panel"
	p.AnchorPoint = opts.anchor or Vector2.new(0.5, 0.5)
	p.Position = opts.position or UDim2.fromScale(0.5, 0.5)
	-- design px (default 500x340), fitted to the screen; a Scale size opts out of fitting
	local design = opts.design or Vector2.new(500, 340)
	p.Size = opts.size or UDim2.fromOffset(design.X, design.Y)
	p.Visible = not opts.hidden
	BloxUI.depth(p, opts.color or "panel", { radius = Theme.panelRadius })
	local bar = BloxUI.designTouch -- title bar height = the close button
	local pad = 12
	local title = BloxUI.label(p, "Title", opts.title or p.Name, {
		size = UDim2.new(1, -2 * (bar + pad), 0, bar - 18),
		position = UDim2.new(0.5, 0, 0, pad + 9),
		anchor = Vector2.new(0.5, 0),
		font = Theme.fontHeavy,
	})
	local close = nil
	if opts.close ~= false then
		close = closeButton(p, UDim2.fromOffset(bar, bar), UDim2.new(1, -pad, 0, pad), Vector2.new(1, 0))
	end
	local body = Instance.new("Frame")
	body.Name = "Body"
	body.BackgroundTransparency = 1
	body.Position = UDim2.fromOffset(pad + 4, bar + pad + 8)
	body.Size = UDim2.new(1, -2 * (pad + 4), 1, -(bar + 2 * pad + 12))
	body.ZIndex = 1
	body.Parent = p
	p.Parent = parent
	if not opts.size or opts.size.X.Scale == 0 then
		local d = opts.size and Vector2.new(opts.size.X.Offset, opts.size.Y.Offset) or design
		designFit(p, { width = d.X / 0.96, height = d.Y / 0.86 })
	end
	local api = { frame = p, title = title, close = close, body = body }
	function api.open()
		p.Visible = true
	end
	function api.hide()
		p.Visible = false
	end
	function api.toggle()
		p.Visible = not p.Visible
	end
	if close then
		connect(close, "Activated", api.hide)
	end
	return api
end

-- Tab buttons in a row (or a column with vertical = true): { frame, buttons,
-- selected, select(id) }. The selected tab takes the tabActive style.
function BloxUI.Tabs(parent: Instance, ids: { string }, opts: any?)
	opts = opts or {}
	local strip = Instance.new("Frame")
	strip.Name = opts.name or "Tabs"
	strip.BackgroundTransparency = 1
	strip.Position = opts.position or UDim2.fromScale(0, 0)
	strip.Size = opts.size or UDim2.fromScale(1, 1)
	strip.ZIndex = 1
	local l = Instance.new("UIListLayout")
	l.FillDirection = if opts.vertical then Enum.FillDirection.Vertical else Enum.FillDirection.Horizontal
	l.Padding = UDim.new(0, 8)
	l.SortOrder = Enum.SortOrder.LayoutOrder
	l.Parent = strip
	local api = { frame = strip, buttons = {}, selected = ids[1] }
	function api.select(id: string)
		api.selected = id
		for tid, b in api.buttons do
			BloxUI.depth(b, if tid == id then "tabActive" else "tab")
		end
	end
	for i, id in ids do
		local b = BloxUI.Button(strip, {
			name = id,
			text = id,
			color = "tab",
			size = if opts.vertical
				then UDim2.new(1, 0, 0, BloxUI.designTouch)
				else UDim2.new(1 / #ids, -8, 1, 0),
		})
		b.LayoutOrder = i
		api.buttons[id] = b
		connect(b, "Activated", function()
			api.select(id)
		end)
	end
	api.select(api.selected)
	strip.Parent = parent
	return api
end

-- Centre modal: a hidden Panel with optional tabs and a scrolling list.
-- { frame, close, list, tabs (id → button), tabBar, open, hide, toggle }.
function BloxUI.Modal(parent: Instance, opts: any)
	local p = BloxUI.Panel(parent, {
		name = opts.name or "Modal",
		title = opts.title,
		color = opts.color,
		design = opts.design,
		hidden = true,
	})
	local top = 0
	local tabs, tabBar = {}, nil
	if opts.tabs and #opts.tabs > 0 then
		tabBar = BloxUI.Tabs(p.body, opts.tabs, { size = UDim2.new(1, 0, 0, BloxUI.designTouch) })
		tabs = tabBar.buttons
		top = BloxUI.designTouch + 10
	end
	local list = Instance.new("ScrollingFrame")
	list.Name = "List"
	list.BackgroundTransparency = 1
	list.BorderSizePixel = 0
	list.Position = UDim2.fromOffset(0, top)
	list.Size = UDim2.new(1, 0, 1, -top)
	list.AutomaticCanvasSize = Enum.AutomaticSize.Y
	list.CanvasSize = UDim2.new()
	list.ScrollBarThickness = 6
	list.ZIndex = 1
	local ll = Instance.new("UIListLayout")
	ll.Padding = UDim.new(0, 10)
	ll.SortOrder = Enum.SortOrder.LayoutOrder
	ll.HorizontalAlignment = Enum.HorizontalAlignment.Center
	ll.Parent = list
	local pad = Instance.new("UIPadding")
	pad.PaddingTop = UDim.new(0, 4)
	pad.PaddingBottom = UDim.new(0, 8)
	pad.Parent = list
	list.Parent = p.body
	return {
		frame = p.frame,
		close = p.close,
		list = list,
		tabs = tabs,
		tabBar = tabBar,
		open = p.open,
		hide = p.hide,
		toggle = p.toggle,
	}
end

-- List row: name label on the left, action button on the right. Fixed height
-- (rows scroll), so it stays >= the touch floor on every screen.
function BloxUI.Row(list: Instance, opts: any)
	local row = Instance.new("Frame")
	row.Name = opts.name or "Row"
	row.Size = UDim2.new(1, -10, 0, BloxUI.designTouch + 14)
	row.LayoutOrder = opts.order or 0
	BloxUI.depth(row, opts.color or "row")
	local label = BloxUI.label(row, "Label", opts.text or row.Name, {
		size = UDim2.fromScale(0.58, 0.6),
		position = UDim2.fromScale(0.04, 0.2),
		align = Enum.TextXAlignment.Left,
	})
	local button = BloxUI.Button(row, {
		name = "Action",
		text = opts.action or "Buy",
		color = opts.actionColor or "primary",
		size = UDim2.new(0.32, 0, 0, BloxUI.designTouch),
		position = UDim2.fromScale(0.97, 0.5),
		anchor = Vector2.new(1, 0.5),
	})
	row.Parent = list
	return { frame = row, label = label, button = button }
end

-- Shop/inventory tile: optional icon on a dark slot, a title, a subtitle and an
-- optional action button. { frame, title, subtitle, icon?, button? }.
-- opts: name, title, subtitle, icon, action, color (default "row"), actionColor,
-- height (px, default 76), order.
function BloxUI.Tile(list: Instance, opts: any)
	local t = Instance.new("Frame")
	t.Name = opts.name or "Tile"
	t.Size = UDim2.new(1, -10, 0, opts.height or 84)
	t.LayoutOrder = opts.order or 0
	BloxUI.depth(t, opts.color or "row")
	local x = 0.04
	local icon = nil
	if opts.icon then
		local slot = Instance.new("Frame")
		slot.Name = "Slot"
		slot.AnchorPoint = Vector2.new(0, 0.5)
		slot.Position = UDim2.fromScale(0.025, 0.5)
		slot.Size = UDim2.fromScale(0.8, 0.8)
		slot.ZIndex = 1
		local a = Instance.new("UIAspectRatioConstraint")
		a.AspectRatio = 1
		a.Parent = slot
		BloxUI.depth(slot, "slot")
		icon = Instance.new("ImageLabel")
		icon.Name = "Icon"
		icon.BackgroundTransparency = 1
		icon.Image = opts.icon
		icon.ScaleType = Enum.ScaleType.Fit
		icon.AnchorPoint = Vector2.new(0.5, 0.5)
		icon.Position = UDim2.fromScale(0.5, 0.5)
		icon.Size = UDim2.fromScale(0.86, 0.86)
		icon.ZIndex = 1
		icon.Parent = slot
		slot.Parent = t
		x = 0.2
	end
	local right = if opts.action then 0.66 else 0.96
	local title = BloxUI.label(t, "Title", opts.title or t.Name, {
		size = UDim2.fromScale(right - x, 0.4),
		position = UDim2.fromScale(x, 0.12),
		align = Enum.TextXAlignment.Left,
	})
	local subtitle = BloxUI.label(t, "Subtitle", opts.subtitle or "", {
		size = UDim2.fromScale(right - x, 0.28),
		position = UDim2.fromScale(x, 0.56),
		align = Enum.TextXAlignment.Left,
		color = Theme.textDim,
	})
	local button = nil
	if opts.action then
		button = BloxUI.Button(t, {
			name = "Action",
			text = opts.action,
			color = opts.actionColor or "primary",
			icon = opts.actionIcon,
			disabled = opts.disabled,
			size = UDim2.new(0.29, 0, 0, BloxUI.designTouch),
			position = UDim2.fromScale(0.975, 0.5),
			anchor = Vector2.new(1, 0.5),
		})
	end
	t.Parent = list
	return { frame = t, title = title, subtitle = subtitle, icon = icon, button = button }
end

-- Confirm dialog over a dim shade: { frame (shade), card, text, confirm, cancel,
-- show(text?), hide() }. Cancel hides it; connect confirm yourself.
function BloxUI.Dialog(parent: Instance, opts: any)
	local shade = Instance.new("Frame")
	shade.Name = opts.name or "Dialog"
	shade.Size = UDim2.fromScale(1, 1)
	shade.BackgroundColor3 = Color3.new(0, 0, 0)
	shade.BackgroundTransparency = 0.45
	shade.BorderSizePixel = 0
	shade.Visible = false
	shade.ZIndex = 5
	local card = BloxUI.Panel(shade, {
		name = "Card",
		title = opts.title or "Are you sure?",
		color = opts.color,
		design = Vector2.new(420, 250),
		close = false,
	})
	local text = BloxUI.label(card.body, "Text", opts.text or "", {
		size = UDim2.new(0.9, 0, 1, -(BloxUI.designTouch + 24)),
		position = UDim2.fromScale(0.05, 0),
	})
	local confirm = BloxUI.Button(card.body, {
		name = "Confirm",
		text = opts.confirm or "OK",
		color = opts.confirmColor or "primary",
		size = UDim2.new(0.46, 0, 0, BloxUI.designTouch),
		position = UDim2.fromScale(0, 1),
		anchor = Vector2.new(0, 1),
	})
	local cancel = BloxUI.Button(card.body, {
		name = "Cancel",
		text = opts.cancel or "Cancel",
		color = "danger",
		size = UDim2.new(0.46, 0, 0, BloxUI.designTouch),
		position = UDim2.fromScale(1, 1),
		anchor = Vector2.new(1, 1),
	})
	shade.Parent = parent
	local api = { frame = shade, card = card.frame, text = text, confirm = confirm, cancel = cancel }
	function api.show(t: string?)
		if t then
			text.Text = t
		end
		shade.Visible = true
	end
	function api.hide()
		shade.Visible = false
	end
	connect(cancel, "Activated", api.hide)
	return api
end

-- Toast stack above the bottom edge, shared by every script on this client:
-- HUD and menus calling Toast() get the same stack, so toasts never overlap.
-- It lives in its own ScreenGui above menus when a PlayerGui is reachable.
-- show(text, seconds?) → toast frame (auto-removed); style(fn) skins every
-- toast (fn(toast) runs on each new one).
local sharedToasts: any = nil

function BloxUI.Toast(parent: Instance)
	if sharedToasts and sharedToasts.frame.Parent then
		return sharedToasts
	end
	local ok, pg = pcall(function()
		local lp = game:GetService("Players").LocalPlayer
		return parent:FindFirstAncestorOfClass("PlayerGui") or (lp and lp:FindFirstChildOfClass("PlayerGui"))
	end)
	local host = parent
	if ok and pg then
		host = pg:FindFirstChild("BloxToasts") or BloxUI.screen("BloxToasts", pg);
		(host :: ScreenGui).DisplayOrder = 100
	end
	-- A script with its own module copy (another VM) still joins the stack.
	local existing = host ~= parent and host:FindFirstChild("Toasts")
	local stack = existing or Instance.new("Frame")
	if not existing then
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
		stack.Parent = host
	end
	local n = 0
	local skin: ((Frame) -> ())? = nil
	sharedToasts = {
		frame = stack,
		style = function(fn: (Frame) -> ())
			skin = fn
		end,
		show = function(text: string, seconds: number?)
			n += 1
			local t = Instance.new("Frame")
			t.Name = "Toast" .. n
			t.LayoutOrder = n
			t.Size = UDim2.new(1, 0, 0, 40)
			BloxUI.depth(t, "dark")
			BloxUI.label(
				t,
				"Text",
				text,
				{ size = UDim2.fromScale(0.94, 0.8), position = UDim2.fromScale(0.03, 0.1) }
			)
			if skin then
				skin(t)
			end
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
	return sharedToasts
end

-- Full-screen reward reveal: show(title, subtitle?) / hide(); tap "Nice!" to close.
function BloxUI.Reveal(parent: Instance)
	local shade = Instance.new("Frame")
	shade.Name = "Reveal"
	shade.Size = UDim2.fromScale(1, 1)
	shade.BackgroundColor3 = Color3.new(0, 0, 0)
	shade.BackgroundTransparency = 0.35
	shade.BorderSizePixel = 0
	shade.Visible = false
	local card = Instance.new("Frame")
	card.Name = "Card"
	card.AnchorPoint = Vector2.new(0.5, 0.5)
	card.Position = UDim2.fromScale(0.5, 0.5)
	card.Size = UDim2.fromOffset(420, 300)
	BloxUI.depth(card, "panel", { radius = Theme.panelRadius })
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
		size = UDim2.new(0.5, 0, 0, BloxUI.designTouch),
		position = UDim2.new(0.5, 0, 1, -16),
		anchor = Vector2.new(0.5, 1),
	})
	card.Parent = shade
	designFit(card, { width = 420 / 0.9, height = 300 / 0.8 })
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
