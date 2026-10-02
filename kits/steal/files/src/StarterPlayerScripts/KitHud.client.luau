-- Steal-tycoon kit HUD on BloxUI: cash bar, left rail (Shop, Lock, Rebirth),
-- shop modal with one row per pet/upgrade, a status line (carrying / lock) and
-- toasts. State arrives as player attributes: KitState (JSON), Carrying,
-- LockRemaining, LockCooldown, LastCarry.
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local player = Players.LocalPlayer
local Kit = ReplicatedStorage:WaitForChild("Kit")
local Economy = require(Kit:WaitForChild("Economy"))
local Format = require(Kit:WaitForChild("Format"))
local UI = require(ReplicatedStorage:WaitForChild("BloxUI"))
local Tunables = require(ReplicatedStorage:WaitForChild("Design"):WaitForChild("Tunables"))
local Remotes = Kit:WaitForChild("Remotes")
local econ = Economy.new(Tunables)

local gui = UI.screen("KitHud", player:WaitForChild("PlayerGui"))

local resIds = {}
for id in Tunables.economy.resources do
	table.insert(resIds, id)
end
table.sort(resIds)
local bar = UI.CurrencyBar(gui, resIds)

local railItems = {
	{ id = "ShopButton", text = "Shop" },
	{ id = "LockButton", text = "Lock", color = UI.Theme.accent },
}
if econ.items.rebirth then
	table.insert(railItems, { id = "RebirthButton", text = "Rebirth", color = UI.Theme.accent })
end
local rail = UI.Rail(gui, railItems)
local shop = UI.Modal(gui, { name = "Shop", title = "Pets & upgrades" })
local toasts = UI.Toast(gui)
local status =
	UI.label(gui, "Status", "", { size = UDim2.fromScale(0.5, 0.06), position = UDim2.fromScale(0.25, 0.86) })

local rows = {}
for i, ref in econ:itemRefs() do
	local row = UI.Row(shop.list, { name = ref, text = ref, action = "Buy", order = i })
	row.button.Activated:Connect(function()
		local ok, err, outcome = Remotes.Purchase:InvokeServer(ref)
		toasts.show(ok and ("Got " .. (outcome or ref)) or tostring(err))
	end)
	rows[ref] = row
end

rail.buttons.ShopButton.Activated:Connect(shop.toggle)
rail.buttons.LockButton.Activated:Connect(function()
	local ok, err = Remotes.Lock:InvokeServer()
	toasts.show(ok and "Base locked!" or tostring(err))
end)
if rail.buttons.RebirthButton then
	rail.buttons.RebirthButton.Activated:Connect(function()
		local ok, err = Remotes.Rebirth:InvokeServer()
		toasts.show(ok and "Rebirthed!" or tostring(err))
	end)
end

local function renderStatus()
	local carrying = player:GetAttribute("Carrying")
	local lock = player:GetAttribute("LockRemaining") or 0
	local cd = player:GetAttribute("LockCooldown") or 0
	if carrying then
		status.Text = "Carrying a " .. carrying .. " — run home!"
	elseif lock > 0 then
		status.Text = "Base locked " .. Format.duration(lock)
	else
		status.Text = ""
	end
	rail.buttons.LockButton.Text = lock > 0 and ("Locked " .. Format.duration(lock))
		or (cd > 0 and ("Lock " .. Format.duration(cd)) or "Lock")
end

local function render()
	local raw = player:GetAttribute("KitState")
	if type(raw) ~= "string" then
		return
	end
	local ok, state = pcall(HttpService.JSONDecode, HttpService, raw)
	if not ok or type(state) ~= "table" then
		return
	end
	-- JSON turns empty maps into arrays; normalise the fields Economy reads.
	for _, f in { "bal", "owned", "open", "chanceIncome", "passes" } do
		if type(state[f]) ~= "table" then
			state[f] = {}
		end
	end
	for _, id in resIds do
		bar.set(id, id .. ": " .. Format.abbreviate(state.bal[id] or 0))
	end
	for ref, r in rows do
		local avail, why = econ:available(state, ref)
		local price, res = econ:cost(state, ref)
		r.label.Text = ref .. "  (" .. Format.abbreviate(state.owned[ref] or 0) .. ")"
		r.button.Text = avail and (Format.abbreviate(price) .. " " .. res) or (why or "")
		local affordable = avail and (state.bal[res] or 0) >= price
		r.button.BackgroundColor3 = affordable and UI.Theme.primary or UI.Theme.disabled
	end
	if rail.buttons.RebirthButton then
		local price, res = econ:cost(state, "rebirth")
		rail.buttons.RebirthButton.Text = "Rebirth " .. Format.abbreviate(price) .. " " .. res
	end
	renderStatus()
end

player:GetAttributeChangedSignal("KitState"):Connect(render)
for _, a in { "Carrying", "LockRemaining", "LockCooldown" } do
	player:GetAttributeChangedSignal(a):Connect(renderStatus)
end
player:GetAttributeChangedSignal("LastCarry"):Connect(function()
	local msg = player:GetAttribute("LastCarry")
	if msg then
		toasts.show(msg)
	end
end)
render()
