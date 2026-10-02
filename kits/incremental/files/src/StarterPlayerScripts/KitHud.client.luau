-- Minimal kit HUD: currency bar, shop, rebirth button, toasts; makes gate walls
-- you have opened passable (locally). Built in code, scale-based for mobile.
-- Pipeline item 4 (UI kit) replaces the look; keep the data flow.
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")

local player = Players.LocalPlayer
local Kit = ReplicatedStorage:WaitForChild("Kit")
local Economy = require(Kit:WaitForChild("Economy"))
local Format = require(Kit:WaitForChild("Format"))
local Tunables = require(ReplicatedStorage:WaitForChild("Design"):WaitForChild("Tunables"))
local Remotes = Kit:WaitForChild("Remotes")
local econ = Economy.new(Tunables)

local gui = Instance.new("ScreenGui")
gui.Name = "KitHud"
gui.ResetOnSpawn = false
gui.IgnoreGuiInset = false
gui.Parent = player:WaitForChild("PlayerGui")

local function corner(p, r)
	local c = Instance.new("UICorner")
	c.CornerRadius = UDim.new(0, r or 10)
	c.Parent = p
end

local function label(parent, name, text)
	local l = Instance.new("TextLabel")
	l.Name = name
	l.BackgroundTransparency = 1
	l.TextScaled = true
	l.Font = Enum.Font.GothamBold
	l.TextColor3 = Color3.new(1, 1, 1)
	l.Text = text
	l.Parent = parent
	return l
end

local function button(parent, name, text, color)
	local b = Instance.new("TextButton")
	b.Name = name
	b.Text = text
	b.TextScaled = true
	b.Font = Enum.Font.GothamBold
	b.TextColor3 = Color3.new(1, 1, 1)
	b.BackgroundColor3 = color
	b.AutoButtonColor = true
	b.Parent = parent
	corner(b)
	return b
end

-- Currency bar (top centre)
local bar = Instance.new("Frame")
bar.Name = "Currencies"
bar.AnchorPoint = Vector2.new(0.5, 0)
bar.Position = UDim2.fromScale(0.5, 0.02)
bar.Size = UDim2.fromScale(0.5, 0.07)
bar.BackgroundColor3 = Color3.fromRGB(20, 20, 30)
bar.BackgroundTransparency = 0.25
bar.Parent = gui
corner(bar, 14)
local barLayout = Instance.new("UIListLayout")
barLayout.FillDirection = Enum.FillDirection.Horizontal
barLayout.HorizontalAlignment = Enum.HorizontalAlignment.Center
barLayout.Padding = UDim.new(0.02, 0)
barLayout.Parent = bar
local resIds = {}
for id in Tunables.economy.resources do
	table.insert(resIds, id)
end
table.sort(resIds)
local resLabels = {}
for _, id in resIds do
	local l = label(bar, id, id .. ": 0")
	l.Size = UDim2.fromScale(1 / #resIds - 0.02, 1)
	resLabels[id] = l
end

-- Right rail: Shop + Rebirth
local rail = Instance.new("Frame")
rail.Name = "Rail"
rail.AnchorPoint = Vector2.new(1, 0.5)
rail.Position = UDim2.fromScale(0.98, 0.55)
rail.Size = UDim2.fromScale(0.14, 0.3)
rail.BackgroundTransparency = 1
rail.Parent = gui
local railLayout = Instance.new("UIListLayout")
railLayout.Padding = UDim.new(0.05, 0)
railLayout.Parent = rail
local shopButton = button(rail, "ShopButton", "Shop", Color3.fromRGB(46, 160, 67))
shopButton.Size = UDim2.fromScale(1, 0.4)
local rebirthButton = button(rail, "RebirthButton", "Rebirth", Color3.fromRGB(150, 60, 200))
rebirthButton.Size = UDim2.fromScale(1, 0.4)
rebirthButton.Visible = econ.items.rebirth ~= nil

-- Shop panel
local shop = Instance.new("Frame")
shop.Name = "Shop"
shop.AnchorPoint = Vector2.new(0.5, 0.5)
shop.Position = UDim2.fromScale(0.5, 0.55)
shop.Size = UDim2.fromScale(0.5, 0.6)
shop.BackgroundColor3 = Color3.fromRGB(25, 25, 40)
shop.Visible = false
shop.Parent = gui
corner(shop, 16)
local close = button(shop, "Close", "X", Color3.fromRGB(200, 60, 60))
close.AnchorPoint = Vector2.new(1, 0)
close.Position = UDim2.fromScale(0.98, 0.02)
close.Size = UDim2.fromScale(0.1, 0.1)
local list = Instance.new("ScrollingFrame")
list.Name = "Items"
list.Position = UDim2.fromScale(0.03, 0.14)
list.Size = UDim2.fromScale(0.94, 0.83)
list.BackgroundTransparency = 1
list.AutomaticCanvasSize = Enum.AutomaticSize.Y
list.CanvasSize = UDim2.new()
list.ScrollBarThickness = 6
list.Parent = shop
local listLayout = Instance.new("UIListLayout")
listLayout.Padding = UDim.new(0, 6)
listLayout.Parent = list

local toast = label(gui, "Toast", "")
toast.AnchorPoint = Vector2.new(0.5, 1)
toast.Position = UDim2.fromScale(0.5, 0.92)
toast.Size = UDim2.fromScale(0.5, 0.05)
toast.Visible = false
local toastSeq = 0
local function showToast(text)
	toastSeq += 1
	local mine = toastSeq
	toast.Text = text
	toast.Visible = true
	task.delay(2, function()
		if toastSeq == mine then
			toast.Visible = false
		end
	end)
end

local rows = {}
for _, ref in econ:itemRefs() do
	local row = Instance.new("Frame")
	row.Name = ref
	row.Size = UDim2.new(1, -8, 0, 54)
	row.BackgroundColor3 = Color3.fromRGB(40, 40, 60)
	row.Parent = list
	corner(row, 8)
	local name = label(row, "Name", ref)
	name.Position = UDim2.fromScale(0.03, 0.1)
	name.Size = UDim2.fromScale(0.6, 0.8)
	name.TextXAlignment = Enum.TextXAlignment.Left
	local buy = button(row, "Buy", "Buy", Color3.fromRGB(46, 160, 67))
	buy.AnchorPoint = Vector2.new(1, 0.5)
	buy.Position = UDim2.fromScale(0.97, 0.5)
	buy.Size = UDim2.fromScale(0.32, 0.8)
	buy.Activated:Connect(function()
		local ok, err, outcome = Remotes.Purchase:InvokeServer(ref)
		showToast(ok and ("Got " .. (outcome or ref)) or tostring(err))
	end)
	rows[ref] = { row = row, name = name, buy = buy }
end

shopButton.Activated:Connect(function()
	shop.Visible = not shop.Visible
end)
close.Activated:Connect(function()
	shop.Visible = false
end)
rebirthButton.Activated:Connect(function()
	local ok, err = Remotes.Rebirth:InvokeServer()
	showToast(ok and "Rebirthed!" or tostring(err))
end)

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
	for id, l in resLabels do
		l.Text = id .. ": " .. Format.abbreviate(state.bal[id] or 0)
	end
	for ref, r in rows do
		local avail, why = econ:available(state, ref)
		local price, res = econ:cost(state, ref)
		r.name.Text = ref .. "  (" .. Format.abbreviate(state.owned[ref] or 0) .. ")"
		r.buy.Text = avail and (Format.abbreviate(price) .. " " .. res) or (why or "")
		r.buy.AutoButtonColor = avail
		r.buy.BackgroundColor3 = (avail and (state.bal[res] or 0) >= price) and Color3.fromRGB(46, 160, 67) or Color3.fromRGB(90, 90, 100)
	end
	if econ.items.rebirth then
		local price, res = econ:cost(state, "rebirth")
		rebirthButton.Text = "Rebirth\n" .. Format.abbreviate(price) .. " " .. res
	end
	refreshWalls(state)
end

player:GetAttributeChangedSignal("KitState"):Connect(render)
render()
