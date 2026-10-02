-- Server side of the incremental kit: player data, the economy tick, remotes,
-- leaderstats. All rules live in ReplicatedStorage.Kit.Economy; all numbers in
-- ReplicatedStorage.Design.Tunables (generated from .blox/design.json).
--
-- Clients read their state from the "KitState" player attribute (JSON) and call
-- ReplicatedStorage.Kit.Remotes.Purchase / .Rebirth. Server code and specs use
-- ServerStorage.KitApi (BindableFunction): Invoke(op, player, ...) with op in
-- getState | grant(res, amount) | grantPass(id) | purchase(ref) | rebirth.

local DataStoreService = game:GetService("DataStoreService")
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")

local Economy = require(ReplicatedStorage:WaitForChild("Kit"):WaitForChild("Economy"))
local Tunables = require(ReplicatedStorage:WaitForChild("Design"):WaitForChild("Tunables"))

local TUN = Tunables.tunables or {}
local STORE_NAME = "KitPlayerData_v1"
local TICK_SEC = 1

local KitService = {}
KitService.economy = Economy.new(Tunables)
local econ = KitService.economy

local states: { [Player]: any } = {}
local canSave: { [Player]: boolean } = {}
local lastAction: { [Player]: number } = {}
local memoryStore = {} -- used when DataStores are unavailable (Studio without API access)
local store = nil

local function dataStore()
	if store == nil then
		local ok, ds = pcall(function()
			return DataStoreService:GetDataStore(STORE_NAME)
		end)
		store = ok and ds or false
	end
	return store or nil
end

local function key(player: Player): string
	return "u" .. player.UserId
end

local function load(player: Player): (any?, boolean)
	local ds = dataStore()
	if not ds then
		return memoryStore[key(player)], true
	end
	local ok, data = pcall(function()
		return ds:GetAsync(key(player))
	end)
	if ok then
		return data, true
	end
	-- Studio without API access or an outage: play from memory, never overwrite saved data.
	warn("[Kit] data load failed for " .. player.Name .. ": " .. tostring(data) .. " — progress will not be saved this session")
	return memoryStore[key(player)], false
end

local function save(player: Player)
	local s = states[player]
	if not s then
		return
	end
	local data = { state = s, savedAt = os.time() }
	memoryStore[key(player)] = HttpService:JSONDecode(HttpService:JSONEncode(data))
	local ds = dataStore()
	if ds and canSave[player] then
		local ok, err = pcall(function()
			ds:SetAsync(key(player), data)
		end)
		if not ok then
			warn("[Kit] save failed for " .. player.Name .. ": " .. tostring(err))
		end
	end
end

local function leaderstats(player: Player)
	local ls = player:FindFirstChild("leaderstats")
	if not ls then
		ls = Instance.new("Folder")
		ls.Name = "leaderstats"
		ls.Parent = player
	end
	local s = states[player]
	for res, v in s.bal do
		local val = ls:FindFirstChild(res)
		if not val then
			val = Instance.new("NumberValue")
			val.Name = res
			val.Parent = ls
		end
		val.Value = math.floor(v)
	end
	local rb = ls:FindFirstChild("Rebirths")
	if econ.items.rebirth then
		if not rb then
			rb = Instance.new("IntValue")
			rb.Name = "Rebirths"
			rb.Parent = ls
		end
		rb.Value = s.owned.rebirth or 0
	end
end

-- Pushes state to the client (attribute), leaderstats and walk speed.
function KitService.sync(player: Player)
	local s = states[player]
	if not s then
		return
	end
	player:SetAttribute("KitState", HttpService:JSONEncode(s))
	leaderstats(player)
	local speedRes = TUN.speedResource or "speed"
	local hum = player.Character and player.Character:FindFirstChildOfClass("Humanoid")
	if hum and s.bal[speedRes] then
		local per = TUN.walkSpeedPerSpeed or 0.05
		hum.WalkSpeed = math.clamp(16 + (s.bal[speedRes] - 16) * per, 16, TUN.maxWalkSpeed or 100)
	end
end

function KitService.getState(player: Player)
	return states[player]
end

function KitService.grant(player: Player, res: string, amount: number): boolean
	local s = states[player]
	if not s or s.bal[res] == nil then
		return false
	end
	s.bal[res] += amount
	econ:openGates(s)
	KitService.sync(player)
	return true
end

-- Hook for real purchases (MarketplaceService) — wiring them is a human decision.
function KitService.grantPass(player: Player, id: string): (boolean, string?)
	local s = states[player]
	if not s then
		return false, "no state"
	end
	local ok, err = econ:grantPass(s, id)
	KitService.sync(player)
	return ok, err
end

function KitService.purchase(player: Player, ref: string): (boolean, string?, string?)
	local s = states[player]
	if not s then
		return false, "no state", nil
	end
	local ok, err, outcome = econ:purchase(s, ref)
	KitService.sync(player)
	return ok, err, outcome
end

function KitService.rebirth(player: Player): (boolean, string?)
	local s = states[player]
	if not s then
		return false, "no state"
	end
	local ok, err = econ:rebirth(s)
	KitService.sync(player)
	return ok, err
end

local function onJoin(player: Player)
	local data, trusted = load(player)
	canSave[player] = trusted
	local s = econ:newState()
	if type(data) == "table" and type(data.state) == "table" then
		for _, field in { "bal", "owned", "open", "chanceIncome", "passes" } do
			for k, v in data.state[field] or {} do
				s[field][k] = v
			end
		end
		econ:applyPasses(s)
		if type(data.savedAt) == "number" then
			econ:offline(s, math.max(0, os.time() - data.savedAt))
		end
	end
	states[player] = s
	KitService.sync(player)
	player.CharacterAdded:Connect(function()
		task.defer(KitService.sync, player)
	end)
end

local function onLeave(player: Player)
	save(player)
	states[player] = nil
	canSave[player] = nil
	lastAction[player] = nil
end

-- Actions (e.g. "+1 speed per step") only accrue while the character moves.
local function isActive(player: Player): boolean
	local hum = player.Character and player.Character:FindFirstChildOfClass("Humanoid")
	return hum ~= nil and hum.MoveDirection.Magnitude > 0.1
end

local function rateLimited(player: Player): boolean
	local now = os.clock()
	if now - (lastAction[player] or 0) < (TUN.purchaseCooldownSec or 0.2) then
		return true
	end
	lastAction[player] = now
	return false
end

local started = false
function KitService.start()
	if started then
		return
	end
	started = true
	local kit = ReplicatedStorage:WaitForChild("Kit")
	local remotes = kit:FindFirstChild("Remotes") or Instance.new("Folder")
	remotes.Name = "Remotes"
	remotes.Parent = kit
	local purchase = remotes:FindFirstChild("Purchase") or Instance.new("RemoteFunction")
	purchase.Name = "Purchase"
	purchase.Parent = remotes
	purchase.OnServerInvoke = function(player, ref)
		if typeof(ref) ~= "string" or #ref > 100 then
			return false, "bad request"
		end
		if rateLimited(player) then
			return false, "slow down"
		end
		return KitService.purchase(player, ref)
	end
	local rebirth = remotes:FindFirstChild("Rebirth") or Instance.new("RemoteFunction")
	rebirth.Name = "Rebirth"
	rebirth.Parent = remotes
	rebirth.OnServerInvoke = function(player)
		if rateLimited(player) then
			return false, "slow down"
		end
		return KitService.rebirth(player)
	end

	local api = ServerStorage:FindFirstChild("KitApi") or Instance.new("BindableFunction")
	api.Name = "KitApi"
	api.Parent = ServerStorage
	api.OnInvoke = function(op, player, ...)
		if op == "getState" then
			return KitService.getState(player)
		elseif op == "grant" then
			return KitService.grant(player, ...)
		elseif op == "grantPass" then
			return KitService.grantPass(player, ...)
		elseif op == "purchase" then
			return KitService.purchase(player, ...)
		elseif op == "rebirth" then
			return KitService.rebirth(player)
		end
		error("unknown KitApi op " .. tostring(op))
	end

	Players.PlayerAdded:Connect(onJoin)
	Players.PlayerRemoving:Connect(onLeave)
	for _, p in Players:GetPlayers() do
		task.spawn(onJoin, p)
	end
	game:BindToClose(function()
		for p in states do
			save(p)
		end
	end)

	task.spawn(function()
		local sinceSave = 0
		while true do
			local dt = task.wait(TICK_SEC)
			sinceSave += dt
			for player, s in states do
				econ:tick(s, dt, isActive(player))
				KitService.sync(player)
			end
			if sinceSave >= (TUN.autosaveSec or 60) then
				sinceSave = 0
				for player in states do
					task.spawn(save, player)
				end
			end
		end
	end)
end

return KitService
