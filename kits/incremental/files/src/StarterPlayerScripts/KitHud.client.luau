-- Incremental kit HUD on BloxUI: currency bar, left rail (Shop, Rebirth), shop
-- modal with one row per item, toasts; makes gate walls you opened passable
-- (locally). State arrives as the "KitState" player attribute (JSON).
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")

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

local railItems = { { id = "ShopButton", text = "Shop" } }
if econ.items.rebirth then
	table.insert(railItems, { id = "RebirthButton", text = "Rebirth", color = UI.Theme.accent })
end
local rail = UI.Rail(gui, railItems)
local shop = UI.Modal(gui, { name = "Shop", title = "Shop" })
local toasts = UI.Toast(gui)

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
if rail.buttons.RebirthButton then
	rail.buttons.RebirthButton.Activated:Connect(function()
		local ok, err = Remotes.Rebirth:InvokeServer()
		toasts.show(ok and "Rebirthed!" or tostring(err))
	end)
end

local function refreshWalls(state)
	local track = Workspace:FindFirstChild("Track")
	if not track then
		return
	end
	for _, part in track:GetDescendants() do
		local id = part:IsA("BasePart") and part:GetAttribute("GateId")
		if id then
			local open = state.open[id] == true
			part.CanCollide = not open
			part.Transparency = open and 0.8 or 0.1
		end
	end
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
	refreshWalls(state)
end

player:GetAttributeChangedSignal("KitState"):Connect(render)
render()
