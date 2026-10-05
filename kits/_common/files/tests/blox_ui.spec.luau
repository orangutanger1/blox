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

test("rail buttons are round and keyed by id; modal starts hidden", function()
	local _, _, rail, modal = build()
	expect(rail.buttons.Shop:FindFirstChildOfClass("UIAspectRatioConstraint")).toExist()
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
