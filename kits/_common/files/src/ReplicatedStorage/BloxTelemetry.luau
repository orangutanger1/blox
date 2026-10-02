-- BloxTelemetry: onboarding funnel + playtest metrics (server only; no-ops on clients).
--   Telemetry.start()                 once at server boot (idempotent)
--   Telemetry.step(player, "open-wall1")  first time a player reaches an FTUE step
--   Telemetry.event(player, "generator:pet")  timeline entries (purchases, gates, rebirths)
-- Steps listed in Design/Tunables.ftue are also sent to AnalyticsService as
-- onboarding funnel steps (Creator Hub → Analytics → Funnels). blox's
-- `metrics ftue|soak` reads the JSON dump published (every PUBLISH_SEC) to
-- ServerStorage.BloxTelemetryDump: Studio's MCP thread may read values but not
-- invoke game code. ServerStorage.BloxTelemetry:Invoke("dump") still works for
-- game scripts.
local AnalyticsService = game:GetService("AnalyticsService")
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local ServerStorage = game:GetService("ServerStorage")
local Stats = game:GetService("Stats")

local SAMPLE_SEC = 5
local PUBLISH_SEC = 1
local MAX_EVENTS = 5000
local MAX_SAMPLES = 2000
local SETTLE_SEC = 1 -- ignore leaderstats changes this soon after a value appears (initialisation)

local Telemetry = {}
local t0 = os.clock()
local players = {}
local events = {}
local samples = {}
local started = false

local order = {}
do
	local ok, T = pcall(function()
		local design = ReplicatedStorage:FindFirstChild("Design")
		local mod = design and design:FindFirstChild("Tunables")
		return mod and require(mod)
	end)
	if ok and type(T) == "table" and type(T.ftue) == "table" then
		order = T.ftue
	end
end

local function now(): number
	return os.clock() - t0
end

local function record(player: Player)
	local uid = tostring(player.UserId)
	local p = players[uid]
	if not p then
		p = { joinedAt = now(), steps = {} }
		players[uid] = p
	end
	return p, uid
end

function Telemetry.step(player: Player, id: string)
	if not RunService:IsServer() then
		return
	end
	Telemetry.start()
	local p = record(player)
	if p.steps[id] ~= nil then
		return
	end
	p.steps[id] = now() - p.joinedAt
	local index = table.find(order, id)
	if index then
		pcall(function()
			AnalyticsService:LogOnboardingFunnelStepEvent(player, index, id)
		end)
	end
end

function Telemetry.event(player: Player, name: string, value: number?)
	if not RunService:IsServer() then
		return
	end
	local p, uid = record(player)
	if #events < MAX_EVENTS then
		table.insert(events, { t = now() - p.joinedAt, uid = uid, name = name, value = value })
	end
end

function Telemetry.dump()
	return { elapsed = now(), players = players, events = events, samples = samples }
end

local function watchLeaderstats(player: Player)
	local function hook(v: Instance)
		if not v:IsA("ValueBase") then
			return
		end
		local added = os.clock()
		local last = (v :: any).Value
		v.Changed:Connect(function(new)
			if
				typeof(new) == "number"
				and typeof(last) == "number"
				and new > last
				and os.clock() - added > SETTLE_SEC
			then
				Telemetry.step(player, "auto:first-currency")
			end
			last = new
		end)
	end
	local function onFolder(ls: Instance)
		for _, v in ls:GetChildren() do
			hook(v)
		end
		ls.ChildAdded:Connect(hook)
	end
	local ls = player:FindFirstChild("leaderstats")
	if ls then
		onFolder(ls)
	end
	player.ChildAdded:Connect(function(c)
		if c.Name == "leaderstats" then
			onFolder(c)
		end
	end)
end

local function sample()
	local stats = {}
	for _, p in Players:GetPlayers() do
		local ls = p:FindFirstChild("leaderstats")
		if ls then
			local row = {}
			for _, v in ls:GetChildren() do
				if v:IsA("ValueBase") and typeof((v :: any).Value) == "number" then
					row[v.Name] = (v :: any).Value
				end
			end
			stats[tostring(p.UserId)] = row
		end
	end
	table.insert(samples, { t = now(), memMb = Stats:GetTotalMemoryUsageMb(), stats = stats })
	if #samples > MAX_SAMPLES then
		table.remove(samples, 1)
	end
end

function Telemetry.start()
	if started or not RunService:IsServer() then
		return
	end
	started = true
	local function onJoin(p: Player)
		record(p)
		watchLeaderstats(p)
	end
	for _, p in Players:GetPlayers() do
		onJoin(p)
	end
	Players.PlayerAdded:Connect(onJoin)
	local api = ServerStorage:FindFirstChild("BloxTelemetry") or Instance.new("BindableFunction")
	api.Name = "BloxTelemetry"
	api.Parent = ServerStorage;
	(api :: BindableFunction).OnInvoke = function(op)
		if op == "dump" then
			return HttpService:JSONEncode(Telemetry.dump())
		end
		error("unknown BloxTelemetry op " .. tostring(op))
	end
	task.spawn(function()
		while true do
			sample()
			task.wait(SAMPLE_SEC)
		end
	end)
	local pub = ServerStorage:FindFirstChild("BloxTelemetryDump") or Instance.new("StringValue")
	pub.Name = "BloxTelemetryDump"
	pub.Parent = ServerStorage
	task.spawn(function()
		while true do
			(pub :: StringValue).Value = HttpService:JSONEncode(Telemetry.dump())
			task.wait(PUBLISH_SEC)
		end
	end)
end

return Telemetry
