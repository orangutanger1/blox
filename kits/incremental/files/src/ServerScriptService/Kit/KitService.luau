-- Server side of the incremental kit: player data, the economy tick, remotes,
-- leaderstats. All rules live in ReplicatedStorage.Kit.Economy; all numbers in
-- ReplicatedStorage.Design.Tunables (generated from .blox/design.json).
--
-- Clients read their state from the "KitState" player attribute (JSON) and call
-- ReplicatedStorage.Kit.Remotes.Purchase / .Rebirth. Server code and specs use
-- ServerStorage.KitApi (BindableFunction): Invoke(op, player, ...) with op in
-- getState | grant(res, amount) | grantPass(id) | purchase(ref) | claimGate(id) | rebirth.

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")

local Economy = require(ReplicatedStorage:WaitForChild("Kit"):WaitForChild("Economy"))
local Telemetry = require(ReplicatedStorage:WaitForChild("BloxTelemetry"))
local Tunables = require(ReplicatedStorage:WaitForChild("Design"):WaitForChild("Tunables"))

local TUN = Tunables.tunables or {}
local TICK_SEC = 1

local KitService = { Name = "KitService" }
KitService.economy = Economy.new(Tunables)
local econ = KitService.economy

local states: { [Player]: any } = {}
local lastAction: { [Player]: number } = {}
local seenGates: { [Player]: { [string]: boolean } } = {}
-- Player data lives in the framework's DataService (session-locked
-- ProfileStore): each profile's Data.Kit = { state, savedAt } holds this kit's
-- state table itself, so ProfileStore autosaves whatever the kit changes.
local dataService: any = nil
local profiles: { [Player]: any } = {}
local connections: { RBXScriptConnection | any } = {}
local running = false

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
			val.Value = math.floor(v) -- before parenting: telemetry ignores initial values
			val.Parent = ls
		end
		val.Value = math.floor(v)
	end
	local rb = ls:FindFirstChild("Rebirths")
	if econ.items.rebirth then
		if not rb then
			rb = Instance.new("IntValue")
			rb.Name = "Rebirths"
			rb.Value = s.owned.rebirth or 0
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
	-- Gate opens (from ticks, grants or purchases) → FTUE step "open-<gate>" + timeline.
	local seen = seenGates[player]
	if seen then
		for id in s.open do
			if not seen[id] then
				seen[id] = true
				Telemetry.event(player, "gate:" .. id)
				Telemetry.step(player, "open-" .. id)
			end
		end
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
	if ok then
		Telemetry.event(player, ref)
		Telemetry.step(player, "first-buy")
	end
	KitService.sync(player)
	return ok, err, outcome
end

-- Claim gates (design gates with claim:true) open when the game says the player got
-- there, e.g. on a checkpoint touch, once the threshold is met; they pay their grants.
function KitService.claimGate(player: Player, id: string): (boolean, string?)
	local s = states[player]
	if not s then
		return false, "no state"
	end
	local ok, err = econ:claimGate(s, id)
	KitService.sync(player)
	return ok, err
end

function KitService.rebirth(player: Player): (boolean, string?)
	local s = states[player]
	if not s then
		return false, "no state"
	end
	local ok, err = econ:rebirth(s)
	if ok then
		seenGates[player] = {}
		Telemetry.event(player, "rebirth")
		Telemetry.step(player, "first-rebirth")
	end
	KitService.sync(player)
	return ok, err
end

local function onJoin(player: Player, profile: any)
	local saved = profile.Kit
	local s = econ:newState()
	if type(saved) == "table" and type(saved.state) == "table" then
		for _, field in { "bal", "owned", "open", "chanceIncome", "passes" } do
			for k, v in saved.state[field] or {} do
				s[field][k] = v
			end
		end
		econ:applyPasses(s)
		if type(saved.savedAt) == "number" then
			econ:offline(s, math.max(0, os.time() - saved.savedAt))
		end
	end
	profile.Kit = { state = s, savedAt = os.time() }
	profiles[player] = profile
	states[player] = s
	seenGates[player] = table.clone(s.open)
	KitService.sync(player)
	table.insert(
		connections,
		player.CharacterAdded:Connect(function()
			task.defer(KitService.sync, player)
		end)
	)
end

local function onLeave(player: Player, profile: any)
	if type(profile.Kit) == "table" then
		profile.Kit.savedAt = os.time()
	end
	profiles[player] = nil
	states[player] = nil
	lastAction[player] = nil
	seenGates[player] = nil
end

-- Actions (e.g. "+1 speed per step") only accrue while the character moves.
-- MoveDirection reflects player input; horizontal velocity also counts so
-- server-driven movement (Humanoid:MoveTo, playtest bots) accrues too.
local function isActive(player: Player): boolean
	local char = player.Character
	local hum = char and char:FindFirstChildOfClass("Humanoid")
	if not hum then
		return false
	end
	if hum.MoveDirection.Magnitude > 0.1 then
		return true
	end
	local root = hum.RootPart
	local v = root and root.AssemblyLinearVelocity
	return v ~= nil and Vector3.new(v.X, 0, v.Z).Magnitude > 2
end

local function rateLimited(player: Player): boolean
	local now = os.clock()
	if now - (lastAction[player] or 0) < (TUN.purchaseCooldownSec or 0.2) then
		return true
	end
	lastAction[player] = now
	return false
end

function KitService.Init(_self: any, services: { [string]: any })
	dataService = services.DataService
end

function KitService.Start(_self: any)
	running = true
	Telemetry.start()
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
		elseif op == "claimGate" then
			return KitService.claimGate(player, ...)
		elseif op == "rebirth" then
			return KitService.rebirth(player)
		end
		error("unknown KitApi op " .. tostring(op))
	end

	table.insert(connections, dataService.PlayerLoaded:Connect(onJoin))
	table.insert(connections, dataService.PlayerReleasing:Connect(onLeave))
	for _, p in Players:GetPlayers() do
		local profile = dataService:GetData(p)
		if profile and not states[p] then
			task.spawn(onJoin, p, profile)
		end
	end

	task.spawn(function()
		while running do
			local dt = task.wait(TICK_SEC)
			local now = os.time()
			for _, profile in profiles do
				if type(profile.Kit) == "table" then
					profile.Kit.savedAt = now
				end
			end
			for player, s in states do
				-- passiveActions: "+1 every second" games accrue actions while online, moving or not.
				local active = TUN.passiveActions == true or isActive(player)
				if active then
					Telemetry.step(player, "first-step")
				end
				econ:tick(s, dt, active)
				KitService.sync(player)
			end
		end
	end)
end

function KitService.Destroy(_self: any)
	running = false
	for _, connection in connections do
		connection:Disconnect()
	end
	table.clear(connections)
end

return KitService
