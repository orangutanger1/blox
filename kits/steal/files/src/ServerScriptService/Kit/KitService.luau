-- Server side of the steal-tycoon kit: player data, plots, pets on display, the
-- economy tick, stealing/carrying/locking, remotes, leaderstats. Economy rules
-- live in ReplicatedStorage.Kit.Economy, steal rules in Kit.StealRules, all
-- numbers in ReplicatedStorage.Design.Tunables (from .blox/design.json).
--
-- Pets ARE generators: a pet of kind k is one owned["generator:k"], so stealing
-- is -1 on the owner (at once, while carried) and +1 on the thief (on delivery).
--
-- Clients read their state from player attributes KitState (JSON), Carrying
-- (kind), LockRemaining / LockCooldown (seconds) and call
-- ReplicatedStorage.Kit.Remotes.Purchase(ref) / Rebirth() / Steal(ownerUserId,
-- kind) / Lock(). Server code, specs and bots use ServerStorage.KitApi
-- (BindableFunction): Invoke(op, player, ...) with op in getState | grant(res,
-- amount) | grantPass(id) | purchase(ref) | rebirth | steal(owner, kind) |
-- lock | carry | plot | tick.

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")
local Workspace = game:GetService("Workspace")

local Kit = ReplicatedStorage:WaitForChild("Kit")
local Economy = require(Kit:WaitForChild("Economy"))
local StealRules = require(Kit:WaitForChild("StealRules"))
local Telemetry = require(ReplicatedStorage:WaitForChild("BloxTelemetry"))
local Tunables = require(ReplicatedStorage:WaitForChild("Design"):WaitForChild("Tunables"))

local TUN = Tunables.tunables or {}
local TICK_SEC = 1
local CARRY_CHECK_SEC = 0.2
local BASE_WALK = 16

local KitService = { Name = "KitService" }
KitService.economy = Economy.new(Tunables)
KitService.rules = StealRules.new(TUN)
local econ = KitService.economy
local rules = KitService.rules

local states: { [Player]: any } = {}
local lastAction: { [Player]: number } = {}
local plots: { [Player]: Model } = {}
-- Player data lives in the framework's DataService (session-locked
-- ProfileStore): each profile's Data.Kit = { state, savedAt } holds this kit's
-- state table itself, so ProfileStore autosaves whatever the kit changes.
local dataService: any = nil
local profiles: { [Player]: any } = {}
local connections: { any } = {}
local running = false

-- Pet kinds = generator ids, cheapest first (also the display/rarity order).
local KINDS = {}
local generators: { [string]: any } = Tunables.economy.generators or {}
for id, g in generators do
	table.insert(KINDS, { id = id, base = g.cost.base, max = g.max })
end
table.sort(KINDS, function(a, b)
	return a.base < b.base
end)
local KIND_INDEX, KIND_MAX = {}, {}
for i, k in KINDS do
	KIND_INDEX[k.id] = i
	KIND_MAX[k.id] = k.max
end
local RARITY_COLORS = {
	Color3.fromRGB(170, 170, 170),
	Color3.fromRGB(70, 140, 255),
	Color3.fromRGB(170, 80, 255),
	Color3.fromRGB(255, 190, 40),
	Color3.fromRGB(255, 70, 90),
	Color3.fromRGB(60, 230, 200),
}

local function petCounts(s): { [string]: number }
	local c = {}
	for _, k in KINDS do
		c[k.id] = s.owned["generator:" .. k.id] or 0
	end
	return c
end

local function root(player: Player): BasePart?
	local char = player.Character
	local hum = char and char:FindFirstChildOfClass("Humanoid")
	if not hum or hum.Health <= 0 then
		return nil
	end
	return hum.RootPart
end

local function plotCenter(plot: Model): Vector3
	return (plot.PrimaryPart :: BasePart).Position
end

local function basesModel(): Instance?
	return Workspace:FindFirstChild("Bases")
end

-- Plots ----------------------------------------------------------------------

-- Owner sign text on both faces (market side and plot side).
local function setSign(p: Model, text: string)
	local board = p:FindFirstChild("OwnerSign")
	for _, g in board and board:GetChildren() or {} do
		if g:IsA("SurfaceGui") and g:FindFirstChild("Text") then
			g.Text.Text = text
		end
	end
end

local function assignPlot(player: Player): Model?
	local bases = basesModel()
	if not bases then
		return nil
	end
	local list = {}
	for _, p in bases:GetChildren() do
		if p:IsA("Model") and p:GetAttribute("PlotIndex") then
			table.insert(list, p)
		end
	end
	table.sort(list, function(a, b)
		return a:GetAttribute("PlotIndex") < b:GetAttribute("PlotIndex")
	end)
	for _, p in list do
		if not p:GetAttribute("Owner") then
			p:SetAttribute("Owner", player.UserId)
			setSign(p, player.DisplayName .. "'s base")
			plots[player] = p
			player:SetAttribute("PlotIndex", p:GetAttribute("PlotIndex"))
			return p
		end
	end
	warn("[Kit] no free plot for " .. player.Name .. " — raise meta.serverSize or the place's max players")
	return nil
end

local function releasePlot(player: Player)
	local p = plots[player]
	plots[player] = nil
	if not p then
		return
	end
	p:SetAttribute("Owner", nil)
	setSign(p, "Empty plot")
	p.Pets:ClearAllChildren()
	p.Shield.Transparency = 1
end

local function playerByUserId(id: number): Player?
	for p in states do
		if p.UserId == id then
			return p
		end
	end
	return nil
end

-- Pet visuals: one block per pet on a grid over the plot floor. Reskin by
-- replacing makePet (keep PetKind/Owner attributes and the Steal prompt).
local function makePet(kind: string, owner: Player): Model
	local m = Instance.new("Model")
	m.Name = kind
	local i = KIND_INDEX[kind] or 1
	local body = Instance.new("Part")
	body.Name = "Body"
	body.Anchored = true
	body.CanCollide = false
	body.Size = Vector3.one * (1.6 + 0.35 * i)
	body.Color = RARITY_COLORS[(i - 1) % #RARITY_COLORS + 1]
	body.Material = i >= 4 and Enum.Material.Neon or Enum.Material.SmoothPlastic
	body.Parent = m
	m.PrimaryPart = body
	m:SetAttribute("PetKind", kind)
	m:SetAttribute("Owner", owner.UserId)
	local pp = Instance.new("ProximityPrompt")
	pp.Name = "StealPrompt"
	pp.ActionText = "Steal"
	pp.ObjectText = kind
	pp.HoldDuration = 1
	pp.MaxActivationDistance = 10
	pp.RequiresLineOfSight = false
	pp.Parent = body
	return m
end

function KitService.renderPets(player: Player)
	local p, s = plots[player], states[player]
	if not p or not s then
		return
	end
	local folder = p.Pets
	folder:ClearAllChildren()
	local half = (TUN.plotRadius or 22) - 3
	local cols = 9
	local step = (half * 2) / (cols - 1)
	local n = 0
	local base = p.PrimaryPart.CFrame
	for _, k in KINDS do
		for _ = 1, s.owned["generator:" .. k.id] or 0 do
			local row, col = n // cols, n % cols
			local pet = makePet(k.id, player)
			pet:PivotTo(base * CFrame.new(-half + col * step, 2, -half + 6 + row * step))
			pet.Parent = folder
			n += 1
		end
	end
end

-- State push -------------------------------------------------------------------

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
			val.Value = math.floor(v)
			val.Parent = ls
		end
		val.Value = math.floor(v)
	end
	local pets = ls:FindFirstChild("Pets")
	if not pets then
		pets = Instance.new("IntValue")
		pets.Name = "Pets"
		pets.Parent = ls
	end
	local total = 0
	for _, n in petCounts(s) do
		total += n
	end
	pets.Value = total
end

function KitService.sync(player: Player)
	local s = states[player]
	if not s then
		return
	end
	player:SetAttribute("KitState", HttpService:JSONEncode(s))
	local c = rules:carrying(player.UserId)
	player:SetAttribute("Carrying", c and c.kind or nil)
	player:SetAttribute("LockRemaining", math.ceil(rules:lockRemaining(player.UserId)))
	player:SetAttribute("LockCooldown", math.ceil(rules:cooldownRemaining(player.UserId)))
	leaderstats(player)
	local hum = player.Character and player.Character:FindFirstChildOfClass("Humanoid")
	if hum then
		hum.WalkSpeed = c and BASE_WALK * (TUN.carrySpeedMult or 0.75) or BASE_WALK
	end
	local p = plots[player]
	if p then
		p.Shield.Transparency = rules:isLocked(player.UserId) and 0.6 or 1
	end
end

-- Economy ----------------------------------------------------------------------

function KitService.getState(player: Player)
	return states[player]
end

function KitService.grant(player: Player, res: string, amount: number): boolean
	local s = states[player]
	if not s or s.bal[res] == nil then
		return false
	end
	s.bal[res] += amount
	KitService.sync(player)
	return true
end

function KitService.grantPass(player: Player, id: string): (boolean, string?)
	local s = states[player]
	if not s then
		return false, "no state"
	end
	local ok, err = econ:grantPass(s, id)
	KitService.sync(player)
	return ok, err
end

local function onPetGained(player: Player, kind: string)
	if kind ~= (KINDS[1] and KINDS[1].id) then
		Telemetry.step(player, "first-" .. kind)
	end
end

function KitService.purchase(player: Player, ref: string): (boolean, string?, string?)
	local s = states[player]
	if not s then
		return false, "no state", nil
	end
	local kind = string.match(ref, "^generator:(.+)$")
	if kind then
		local room, why = rules:hasRoom(petCounts(s), kind, KIND_MAX[kind])
		if not room then
			return false, why, nil
		end
	end
	local ok, err, outcome = econ:purchase(s, ref)
	if ok then
		Telemetry.event(player, ref)
		Telemetry.step(player, "first-buy")
		if kind then
			onPetGained(player, kind)
			KitService.renderPets(player)
		end
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
	if rules:carrying(player.UserId) then
		return false, "deliver your pet first"
	end
	local ok, err = econ:rebirth(s)
	if ok then
		Telemetry.event(player, "rebirth")
		Telemetry.step(player, "first-rebirth")
		KitService.renderPets(player)
	end
	KitService.sync(player)
	return ok, err
end

-- Stealing ---------------------------------------------------------------------

local function attachCarry(thief: Player, kind: string)
	local r = root(thief)
	if not r then
		return
	end
	local pet = makePet(kind, thief)
	pet.Name = "CarriedPet"
	pet.Body.StealPrompt:Destroy()
	pet.Body.Anchored = false
	pet.Body.Massless = true
	pet:PivotTo(r.CFrame * CFrame.new(0, 4, 0))
	local w = Instance.new("WeldConstraint")
	w.Part0 = r
	w.Part1 = pet.Body
	w.Parent = pet.Body
	pet.Parent = thief.Character
end

local function detachCarry(thief: Player)
	local c = thief.Character and thief.Character:FindFirstChild("CarriedPet")
	if c then
		c:Destroy()
	end
end

function KitService.steal(thief: Player, owner: Player, kind: string): (boolean, string?)
	local ts, os_ = states[thief], states[owner]
	local p = plots[owner]
	if not ts or not os_ or not p then
		return false, "no such base"
	end
	if typeof(kind) ~= "string" or not KIND_INDEX[kind] then
		return false, "unknown pet"
	end
	local r = root(thief)
	local ok, why = rules:canSteal(thief.UserId, owner.UserId, kind, {
		ownerCount = os_.owned["generator:" .. kind] or 0,
		distance = r and (r.Position - plotCenter(p)).Magnitude or math.huge,
	})
	if not ok then
		return false, why
	end
	os_.owned["generator:" .. kind] -= 1
	rules:startCarry(thief.UserId, owner.UserId, kind)
	attachCarry(thief, kind)
	Telemetry.event(thief, "steal:" .. kind)
	Telemetry.step(thief, "first-steal")
	KitService.renderPets(owner)
	KitService.sync(owner)
	KitService.sync(thief)
	return true, nil
end

-- Ends thief's carry: delivered → thief +1, otherwise the pet goes home (or, if
-- its owner already left, stays with the thief when there is room).
local function finishCarry(thief: Player, delivered: boolean, reason: string?)
	local c = rules:endCarry(thief.UserId)
	if not c then
		return
	end
	detachCarry(thief)
	local ref = "generator:" .. c.kind
	local owner = playerByUserId(c.owner)
	local ts = states[thief]
	local keep = delivered or owner == nil
	if keep and ts then
		local room, why = rules:hasRoom(petCounts(ts), c.kind, KIND_MAX[c.kind])
		if room then
			ts.owned[ref] = (ts.owned[ref] or 0) + 1
			Telemetry.event(thief, "delivered:" .. c.kind)
			onPetGained(thief, c.kind)
			KitService.renderPets(thief)
			KitService.sync(thief)
			thief:SetAttribute("LastCarry", "delivered " .. c.kind)
			return
		end
		reason = why
	end
	if owner and states[owner] then
		states[owner].owned[ref] = (states[owner].owned[ref] or 0) + 1
		KitService.renderPets(owner)
		KitService.sync(owner)
	end
	if states[thief] then
		KitService.sync(thief)
	end
	thief:SetAttribute("LastCarry", "lost " .. c.kind .. (reason and (": " .. reason) or ""))
end

function KitService.lock(player: Player): (boolean, string?)
	if not states[player] then
		return false, "no state"
	end
	local ok, why = rules:lock(player.UserId)
	if ok then
		Telemetry.event(player, "lock")
	end
	KitService.sync(player)
	return ok, why
end

-- One pass over every carry: deliver, expire, tag or drop.
function KitService.checkCarries()
	for thief in states do
		local c = rules:carrying(thief.UserId)
		if c then
			local r = root(thief)
			local owner = playerByUserId(c.owner)
			local ownerRoot = owner and root(owner)
			local home = plots[thief]
			if not r then
				finishCarry(thief, false, "you fell")
			elseif rules:expired(thief.UserId) then
				finishCarry(thief, false, "too slow")
			elseif ownerRoot and (ownerRoot.Position - r.Position).Magnitude <= (TUN.tagRange or 6) then
				finishCarry(thief, false, "caught by the owner")
			elseif home and (r.Position - plotCenter(home)).Magnitude <= (TUN.plotRadius or 22) then
				finishCarry(thief, true)
			end
		end
	end
end

-- Lifecycle ----------------------------------------------------------------------

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
	assignPlot(player)
	KitService.renderPets(player)
	KitService.sync(player)
	table.insert(
		connections,
		player.CharacterAdded:Connect(function(char)
			task.defer(KitService.sync, player)
			-- Spawn at home.
			local p = plots[player]
			if p then
				task.defer(function()
					char:PivotTo(p.PrimaryPart.CFrame * CFrame.new(0, 4, 0))
				end)
			end
		end)
	)
end

local function onLeave(player: Player, profile: any)
	finishCarry(player, false, "left")
	rules:forget(player.UserId)
	if type(profile.Kit) == "table" then
		profile.Kit.savedAt = os.time()
	end
	releasePlot(player)
	profiles[player] = nil
	states[player] = nil
	lastAction[player] = nil
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
	local remotes = Kit:FindFirstChild("Remotes") or Instance.new("Folder")
	remotes.Name = "Remotes"
	remotes.Parent = Kit
	local function remote(name: string, handler)
		local rf = remotes:FindFirstChild(name) or Instance.new("RemoteFunction")
		rf.Name = name
		rf.Parent = remotes
		rf.OnServerInvoke = function(player, ...)
			if rateLimited(player) then
				return false, "slow down"
			end
			return handler(player, ...)
		end
	end
	remote("Purchase", function(player, ref)
		if typeof(ref) ~= "string" or #ref > 100 then
			return false, "bad request"
		end
		return KitService.purchase(player, ref)
	end)
	remote("Rebirth", KitService.rebirth)
	remote("Lock", KitService.lock)
	remote("Steal", function(player, ownerId, kind)
		if typeof(ownerId) ~= "number" or typeof(kind) ~= "string" or #kind > 50 then
			return false, "bad request"
		end
		local owner = playerByUserId(ownerId)
		if not owner then
			return false, "no such base"
		end
		return KitService.steal(player, owner, kind)
	end)

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
		elseif op == "steal" then
			return KitService.steal(player, ...)
		elseif op == "lock" then
			return KitService.lock(player)
		elseif op == "carry" then
			return rules:carrying(player.UserId)
		elseif op == "plot" then
			return plots[player]
		elseif op == "tick" then
			KitService.checkCarries()
			return true
		end
		error("unknown KitApi op " .. tostring(op))
	end

	-- Prompts in the world: market stands (Buy), lock pads, pets (Steal).
	local bases = Workspace:WaitForChild("Bases", 30)
	if bases then
		for _, d in bases:GetDescendants() do
			if d:IsA("ProximityPrompt") then
				local holder = d.Parent
				local kind = holder:GetAttribute("PetKind")
				if kind then
					d.Triggered:Connect(function(player)
						KitService.purchase(player, "generator:" .. kind)
					end)
				elseif holder.Name == "LockPad" then
					d.Triggered:Connect(function(player)
						local plot = holder.Parent
						if plot:GetAttribute("Owner") == player.UserId then
							KitService.lock(player)
						end
					end)
				end
			end
		end
	else
		warn("[Kit] Workspace.Bases missing — sync world/Bases.luau")
	end
	game:GetService("ProximityPromptService").PromptTriggered:Connect(function(pp, player)
		if pp.Name ~= "StealPrompt" then
			return
		end
		local pet = pp:FindFirstAncestorOfClass("Model")
		local owner = pet and playerByUserId(pet:GetAttribute("Owner"))
		if owner then
			KitService.steal(player, owner, pet:GetAttribute("PetKind"))
		end
	end)

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
			task.wait(CARRY_CHECK_SEC)
			KitService.checkCarries()
		end
	end)
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
				econ:tick(s, dt, true)
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
