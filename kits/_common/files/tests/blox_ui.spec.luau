-- @context edit
-- BloxUI builds mobile-safe components: every button has a >= 44 px touch floor
-- and nothing is sized in fixed pixels except list rows/toasts (which scroll/stack).
local UI = require(game:GetService("ReplicatedStorage").BloxUI)

local function build()
	local gui = UI.screen("LintProbe", nil)
	local bar = UI.CurrencyBar(gui, { "coins", "gems" })
	local rail = UI.Rail(gui, { { id = "Shop", text = "Shop" }, { id = "Rebirth", text = "Rebirth" } })
	local modal = UI.Modal(gui, { name = "Shop", title = "Shop", tabs = { "Pets", "Boosts" } })
	local row = UI.Row(modal.list, { name = "pet", text = "Pet", action = "10" })
	local toasts = UI.Toast(gui)
	local reveal = UI.Reveal(gui)
	return gui, bar, rail, modal, row, toasts, reveal
end

test("every button has a touch-size floor of at least 44 px", function()
	local gui = build()
	local n = 0
	for _, d in gui:GetDescendants() do
		if d:IsA("GuiButton") then
			n += 1
			local c = d:FindFirstChildOfClass("UISizeConstraint")
			expect(c).toExist()
			expect(c.MinSize.X).toBeGreaterThanOrEqual(44)
			expect(c.MinSize.Y).toBeGreaterThanOrEqual(44)
		end
	end
	expect(n).toBeGreaterThanOrEqual(7)
end)

test("screen uses the safe area and survives respawn", function()
	local gui = build()
	expect(gui.ScreenInsets).toBe(Enum.ScreenInsets.CoreUISafeInsets)
	expect(gui.IgnoreGuiInset).toBe(false)
	expect(gui.ResetOnSpawn).toBe(false)
end)

test("layout containers are scale-sized", function()
	local _, bar, rail, modal = build()
	for _, f in { bar.frame, rail.frame, modal.frame, modal.list } do
		expect(f.Size.X.Offset).toBe(0)
		expect(f.Size.Y.Offset).toBe(0)
	end
end)

test("rail buttons are square tiles keyed by id; modal starts hidden", function()
	local _, _, rail, modal = build()
	expect(rail.buttons.Shop:FindFirstChildOfClass("UIAspectRatioConstraint")).toExist()
	expect(rail.buttons.Shop.Shadow.Face:FindFirstChildOfClass("UICorner").CornerRadius.Offset).toBe(
		UI.Theme.radius
	)
	expect(rail.buttons.Rebirth.Text).toBe("Rebirth")
	expect(modal.frame.Visible).toBe(false)
	modal.open()
	expect(modal.frame.Visible).toBe(true)
	expect(modal.tabs.Pets).toExist()
end)

test("currency bar set() and rows", function()
	local _, bar, _, _, row = build()
	bar.set("coins", "1.2K")
	expect(bar.labels.coins.Text).toBe("1.2K")
	expect(row.button.Text).toBe("10")
	expect(row.frame.Size.Y.Offset).toBeGreaterThanOrEqual(44)
end)

test("reveal show/hide", function()
	local _, _, _, _, _, _, reveal = build()
	reveal.show("Mythic", "1 in 500")
	expect(reveal.frame.Visible).toBe(true)
	expect(reveal.frame.Card.Title.Text).toBe("Mythic")
	reveal.hide()
	expect(reveal.frame.Visible).toBe(false)
end)

test("every Toast() call on a client shares one stack, and style skins each toast", function()
	local a = UI.Toast(UI.screen("A", nil))
	local b = UI.Toast(UI.screen("B", nil))
	expect(a).toBe(b)
	local seen = 0
	a.style(function(t)
		seen += 1
		t.BackgroundTransparency = 0.5
	end)
	local t = b.show("hi", 0.01)
	expect(seen).toBe(1)
	expect(t.BackgroundTransparency).toBe(0.5)
	expect(t.Parent).toBe(a.frame)
end)

test("fit: scale from the tighter of height/width, clamped; attributes for ui lint", function()
	local opts = { height = 800, width = 560, min = 0.57, max = 1.25 }
	expect(UI.fitScale(Vector2.new(1920, 1080), opts)).toBe(1.25)
	expect(math.abs(UI.fitScale(Vector2.new(390, 797), opts) - 390 / 560) < 1e-6).toBe(true)
	expect(UI.fitScale(Vector2.new(750, 311), opts)).toBe(0.57)
	local f = Instance.new("Frame")
	local s = Instance.new("UIScale")
	s.Parent = f
	UI.fit(s, opts)
	expect(s:GetAttribute("BloxFitHeight")).toBe(800)
	expect(s:GetAttribute("BloxFitMin")).toBe(0.57)
	expect(s:GetAttribute("BloxFitFill")).toBe(true)
end)

-- Depth stack: shadow (behind, offset down) > face (gradient, outline, lift) > content.
local function corners(root)
	local out = {}
	for _, d in root:GetDescendants() do
		if d:IsA("UICorner") then
			table.insert(out, d)
		end
	end
	return out
end

test("depth() stacks a blue-shifted shadow, a gradient face with an outline, and a top lift", function()
	local holder = Instance.new("Frame")
	holder.Size = UDim2.fromOffset(200, 60)
	UI.depth(holder, "primary")
	expect(holder.BackgroundTransparency).toBe(1)
	local shadow = holder.Shadow
	expect(shadow.ZIndex).toBe(0)
	expect(shadow.Position.Y.Offset).toBe(UI.Theme.depth.shadowOffset)
	expect(shadow.BackgroundColor3).toBe(UI.Theme.depth.shadow)
	local face = shadow.Face
	expect(face.Position.Y.Offset).toBe(-UI.Theme.depth.shadowOffset)
	expect(face:FindFirstChildOfClass("UIGradient").Rotation).toBe(90)
	expect(face:FindFirstChildOfClass("UIStroke").Color).toBe(UI.Theme.styles.primary.stroke)
	expect(face.Lift).toExist()
end)

test("depth() accepts a plain Color3 and derives the stack from it", function()
	local holder = Instance.new("Frame")
	UI.depth(holder, Color3.fromRGB(200, 60, 160))
	local g = holder.Shadow.Face:FindFirstChildOfClass("UIGradient")
	local top = g.Color.Keypoints[1].Value
	local bottom = g.Color.Keypoints[#g.Color.Keypoints].Value
	expect(top.R > bottom.R).toBe(true)
end)

test("buttons show their text on an outlined label above the face", function()
	local gui = UI.screen("B", nil)
	local b = UI.Button(gui, { name = "Buy", text = "Buy", color = "primary" })
	expect(b.Text).toBe("Buy")
	expect(b.TextTransparency).toBe(1)
	expect(b.Label.Text).toBe("Buy")
	expect(b.Label.ZIndex >= 1).toBe(true)
	expect(b.Label:FindFirstChildOfClass("UIStroke")).toExist()
	expect(b.Label.TextColor3).toBe(UI.Theme.text)
end)

test("disabled buttons are grey and inactive", function()
	local b = UI.Button(UI.screen("D", nil), { text = "Locked", disabled = true })
	expect(b.Active).toBe(false)
	expect(b.Shadow.Face:FindFirstChildOfClass("UIStroke").Color).toBe(UI.Theme.styles.disabled.stroke)
end)

test("no pills: no corner is rounder than the theme radius on buttons, tiles and bars", function()
	local gui = build()
	for _, c in corners(gui) do
		expect(c.CornerRadius.Scale).toBe(0)
		expect(c.CornerRadius.Offset <= UI.Theme.panelRadius).toBe(true)
	end
end)

test("Tile: icon, title, subtitle and an action button on a depth face", function()
	local list = Instance.new("ScrollingFrame")
	local t = UI.Tile(list, {
		name = "pistol",
		title = "Pistol",
		subtitle = "17 dmg",
		icon = "rbxassetid://1",
		action = "Buy",
		color = "row",
		actionColor = "primary",
	})
	expect(t.frame.Parent).toBe(list)
	expect(t.frame.Size.Y.Offset >= 64).toBe(true)
	expect(t.frame.Shadow.Face).toExist()
	expect(t.title.Text).toBe("Pistol")
	expect(t.subtitle.Text).toBe("17 dmg")
	expect(t.icon.Image).toBe("rbxassetid://1")
	expect(t.button.Text).toBe("Buy")
	local plain = UI.Tile(list, { name = "x", title = "X" })
	expect(plain.icon).toBe(nil)
	expect(plain.button).toBe(nil)
end)

test("Panel: titled window whose close X is drawn from two bars, not a glyph", function()
	local p = UI.Panel(UI.screen("P", nil), { name = "Shop", title = "SHOP" })
	expect(p.frame.Shadow.Face).toExist()
	expect(p.title.Text).toBe("SHOP")
	expect(p.close.Text).toBe("")
	local bars = 0
	for _, d in p.close:GetDescendants() do
		if d:IsA("Frame") and d.Name == "Bar" then
			bars += 1
			expect(math.abs(d.Rotation)).toBe(45)
		end
	end
	expect(bars).toBe(2)
	expect(p.body).toExist()
	expect(p.body.ZIndex >= 1).toBe(true)
end)

test("Dialog: confirm and cancel, hidden until shown", function()
	local d = UI.Dialog(
		UI.screen("Dl", nil),
		{ title = "Buy Uzi?", text = "$600", confirm = "Buy", cancel = "Cancel" }
	)
	expect(d.frame.Visible).toBe(false)
	d.show("$700")
	expect(d.frame.Visible).toBe(true)
	expect(d.text.Text).toBe("$700")
	expect(d.confirm.Text).toBe("Buy")
	expect(d.cancel.Text).toBe("Cancel")
	d.hide()
	expect(d.frame.Visible).toBe(false)
end)

test("Tabs: select() moves the active style", function()
	local t = UI.Tabs(UI.screen("T", nil), { "Shop", "Inventory" }, { vertical = true })
	expect(t.selected).toBe("Shop")
	local function stroke(id)
		return t.buttons[id].Shadow.Face:FindFirstChildOfClass("UIStroke").Color
	end
	expect(stroke("Shop")).toBe(UI.Theme.styles.tabActive.stroke)
	t.select("Inventory")
	expect(t.selected).toBe("Inventory")
	expect(stroke("Inventory")).toBe(UI.Theme.styles.tabActive.stroke)
	expect(stroke("Shop")).toBe(UI.Theme.styles.tab.stroke)
end)
