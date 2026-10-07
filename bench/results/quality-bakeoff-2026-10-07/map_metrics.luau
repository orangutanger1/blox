-- Neutral map metrics (edit mode). Same script for every place.
-- Walkability: raycast grid (STEP studs) over the map, multi-level surfaces per column,
-- graph edges by real movement numbers: step 2.1 (walk), jump 7.2, any drop; a horizontal ray
-- at max(y1,y2)+2 must be clear. BFS forward from player spawns, reverse BFS to spawns.
local HttpService = game:GetService("HttpService")
local STEP = 2
local JUMP = 7.2
local HEADROOM = 4.6 -- R15 default height ~5
local MIN_NY = 0.6

local map = workspace:FindFirstChild("FarmTown")
if not map then return HttpService:JSONEncode({ error = "no Workspace.FarmTown" }) end

-- visible bbox (ignores invisible boundary/markers)
local minV, maxV = Vector3.new(math.huge, math.huge, math.huge), Vector3.new(-math.huge, -math.huge, -math.huge)
local counts = { parts = 0, meshParts = 0, unions = 0, visibleParts = 0, instances = 0, scripts = 0, lights = 0, decalsTextures = 0, surfaceAppearances = 0 }
local materials = {}
local colors = {}
for _, d in map:GetDescendants() do
	counts.instances += 1
	if d:IsA("BasePart") then
		counts.parts += 1
		if d:IsA("MeshPart") then counts.meshParts += 1 end
		if d:IsA("UnionOperation") then counts.unions += 1 end
		if d.Transparency < 1 then
			counts.visibleParts += 1
			local cf, s = d.CFrame, d.Size
			local h = s / 2
			for _, sx in { -1, 1 } do
				for _, sy in { -1, 1 } do
					for _, sz in { -1, 1 } do
						local p = cf:PointToWorldSpace(Vector3.new(h.X * sx, h.Y * sy, h.Z * sz))
						minV = minV:Min(p)
						maxV = maxV:Max(p)
					end
				end
			end
			materials[d.Material.Name] = (materials[d.Material.Name] or 0) + 1
			colors[d.BrickColor.Name] = true
		end
	elseif d:IsA("LuaSourceContainer") then
		counts.scripts += 1
	elseif d:IsA("Light") then
		counts.lights += 1
	elseif d:IsA("Decal") or d:IsA("Texture") then
		counts.decalsTextures += 1
	elseif d:IsA("SurfaceAppearance") then
		counts.surfaceAppearances += 1
	end
end
local nColors = 0
for _ in colors do nColors += 1 end

local spawns = {}
for _, d in map:GetDescendants() do
	if d:IsA("SpawnLocation") then table.insert(spawns, d) end
end
local dogFolder = map:FindFirstChild("DogSpawns")
local dogSpawns = dogFolder and dogFolder:GetChildren() or {}
local boss = map:FindFirstChild("BossSpawn")

local params = RaycastParams.new()
params.FilterType = Enum.RaycastFilterType.Exclude
params.RespectCanCollide = true
local excl = {}
for _, p in game:GetService("Players"):GetPlayers() do if p.Character then table.insert(excl, p.Character) end end
params.FilterDescendantsInstances = excl

local PAD = 24
local x0, z0 = minV.X - PAD, minV.Z - PAD
local nx = math.floor((maxV.X - minV.X + 2 * PAD) / STEP)
local nz = math.floor((maxV.Z - minV.Z + 2 * PAD) / STEP)
local topY = maxV.Y + 40

local probe = Instance.new("Part")
probe.Name = "__JudgeProbe"
probe.Anchored, probe.CanCollide, probe.CanQuery, probe.CanTouch = true, false, false, false
probe.Transparency = 1
probe.Size = Vector3.new(1.2, HEADROOM - 0.3, 1.2)
probe.Parent = workspace
local overlap = OverlapParams.new()
overlap.FilterType = Enum.RaycastFilterType.Exclude
overlap.RespectCanCollide = true
local oexcl = table.clone(excl)
table.insert(oexcl, probe)
overlap.FilterDescendantsInstances = oexcl
-- nodes[i][j] = list of node ids
local nodes = {}
local nodeY, nodeI, nodeJ, nodeRoof = {}, {}, {}, {}
local N = 0
local groundYs = {}
for i = 0, nx do
	nodes[i] = {}
	for j = 0, nz do
		local x, z = x0 + i * STEP, z0 + j * STEP
		local list = {}
		local oy = topY
		local lowest
		for _ = 1, 8 do
			local r = workspace:Raycast(Vector3.new(x, oy, z), Vector3.new(0, -(oy - (minV.Y - 60)), 0), params)
			if not r then break end
			if r.Normal.Y >= MIN_NY then
				-- standing volume must be free of collidable geometry (rays that start inside a part miss it)
				probe.CFrame = CFrame.new(r.Position + Vector3.new(0, 0.25 + HEADROOM / 2, 0))
				if #workspace:GetPartsInPart(probe, overlap) == 0 then
					N += 1
					local roof = workspace:Raycast(r.Position + Vector3.new(0, HEADROOM, 0), Vector3.new(0, 60, 0), params)
					nodeY[N], nodeI[N], nodeJ[N], nodeRoof[N] = r.Position.Y, i, j, roof ~= nil
					table.insert(list, N)
				end
			end
			lowest = r.Position.Y
			oy = r.Position.Y - 0.05
		end
		if lowest then table.insert(groundYs, lowest) end
		nodes[i][j] = list
	end
end
probe:Destroy()
table.sort(groundYs)
local groundY = groundYs[math.max(1, math.floor(#groundYs * 0.5))] or 0

-- adjacency (4-neighbour), built lazily
local function neighbours(n)
	local out = {}
	local i, j, y = nodeI[n], nodeJ[n], nodeY[n]
	for _, d in { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } } do
		local col = nodes[i + d[1]] and nodes[i + d[1]][j + d[2]]
		if col then
			for _, m in col do
				local dy = nodeY[m] - y
				if dy <= JUMP then
					local h = math.max(y, nodeY[m]) + 2
					local a = Vector3.new(x0 + i * STEP, h, z0 + j * STEP)
					local b = Vector3.new(x0 + (i + d[1]) * STEP, h, z0 + (j + d[2]) * STEP)
					if not workspace:Raycast(a, b - a, params) then table.insert(out, m) end
				end
			end
		end
	end
	return out
end

local adj, radj = {}, {}
for n = 1, N do
	adj[n] = neighbours(n)
	if n % 4000 == 0 then task.wait() end
end
for n = 1, N do radj[n] = {} end
for n = 1, N do
	for _, m in adj[n] do table.insert(radj[m], n) end
end

local function nearestNode(pos)
	local i = math.floor((pos.X - x0) / STEP + 0.5)
	local j = math.floor((pos.Z - z0) / STEP + 0.5)
	local best, bd
	for di = -2, 2 do
		for dj = -2, 2 do
			local col = nodes[i + di] and nodes[i + di][j + dj]
			if col then
				for _, n in col do
					local dy = pos.Y - nodeY[n]
					if dy > -2 and dy < 12 then
						local d = math.abs(di) + math.abs(dj) + dy * 0.1
						if not bd or d < bd then best, bd = n, d end
					end
				end
			end
		end
	end
	return best
end

local function bfs(starts, graph)
	local seen, q, h = {}, {}, 1
	for _, s in starts do
		if s and not seen[s] then seen[s] = true; table.insert(q, s) end
	end
	while h <= #q do
		local n = q[h]; h += 1
		for _, m in graph[n] do
			if not seen[m] then seen[m] = true; table.insert(q, m) end
		end
	end
	return seen
end

local spawnNodes = {}
for _, s in spawns do
	table.insert(spawnNodes, nearestNode(s.Position + Vector3.new(0, s.Size.Y / 2, 0)))
end
local fwd = bfs(spawnNodes, adj)
local back = bfs(spawnNodes, radj)

local reach, pockets, high, covered, outside = 0, 0, 0, 0, 0
local rminX, rmaxX, rminZ, rmaxZ = math.huge, -math.huge, math.huge, -math.huge
local highSamples, pocketSamples, outsideSamples = {}, {}, {}
local inMinX, inMaxX, inMinZ, inMaxZ = minV.X + 2, maxV.X - 2, minV.Z + 2, maxV.Z - 2
for n = 1, N do
	if fwd[n] then
		reach += 1
		local x, z = x0 + nodeI[n] * STEP, z0 + nodeJ[n] * STEP
		rminX, rmaxX, rminZ, rmaxZ = math.min(rminX, x), math.max(rmaxX, x), math.min(rminZ, z), math.max(rmaxZ, z)
		if not back[n] then
			pockets += 1
			if #pocketSamples < 6 then table.insert(pocketSamples, string.format("%d,%d,%d", x, nodeY[n], z)) end
		end
		if nodeY[n] > groundY + JUMP + 0.5 then
			high += 1
			if #highSamples < 8 then table.insert(highSamples, string.format("%d,%d,%d", x, nodeY[n], z)) end
		end
		if nodeRoof[n] then covered += 1 end
		if x < inMinX or x > inMaxX or z < inMinZ or z > inMaxZ then
			outside += 1
			if #outsideSamples < 6 then table.insert(outsideSamples, string.format("%d,%d,%d", x, nodeY[n], z)) end
		end
	end
end

local dogOk, dogDetail = 0, {}
for _, d in dogSpawns do
	if d:IsA("BasePart") then
		local n = nearestNode(d.Position)
		local ok = n ~= nil and back[n] == true
		if ok then dogOk += 1 end
		table.insert(dogDetail, { name = d.Name, pos = string.format("%d,%d,%d", d.Position.X, d.Position.Y, d.Position.Z), reachesSpawn = ok, onGrid = n ~= nil })
	end
end
local bossOk = false
if boss and boss:IsA("BasePart") then
	local n = nearestNode(boss.Position)
	bossOk = n ~= nil and back[n] == true and fwd[n] == true
end

-- floating visible anchored parts: nothing within 0.3 studs of their box
local op = OverlapParams.new()
op.FilterType = Enum.RaycastFilterType.Exclude
local floating, floatSamples = 0, {}
for _, d in map:GetDescendants() do
	if d:IsA("BasePart") and d.Transparency < 1 and d.Anchored and d.CanCollide then
		local bottom = d.Position.Y - d.Size.Y / 2
		if bottom > groundY + 0.5 then
			op.FilterDescendantsInstances = { d }
			local hits = workspace:GetPartBoundsInBox(d.CFrame, d.Size + Vector3.new(0.6, 0.6, 0.6), op)
			if #hits == 0 then
				floating += 1
				if #floatSamples < 6 then table.insert(floatSamples, d:GetFullName()) end
			end
		end
	end
end

local L = game:GetService("Lighting")
local sky = L:FindFirstChildOfClass("Sky")
return HttpService:JSONEncode({
	bbox = { min = { minV.X, minV.Y, minV.Z }, max = { maxV.X, maxV.Y, maxV.Z } },
	size = { maxV.X - minV.X, maxV.Y - minV.Y, maxV.Z - minV.Z },
	playBbox = { min = { rminX, minV.Y, rminZ }, max = { rmaxX, maxV.Y, rmaxZ } },
	playArea = { rmaxX - rminX, rmaxZ - rminZ },
	counts = counts,
	materials = materials,
	distinctBrickColors = nColors,
	groundY = groundY,
	grid = { step = STEP, columns = (nx + 1) * (nz + 1), standableNodes = N },
	spawns = #spawns,
	spawnNodesFound = #spawnNodes,
	reachableNodes = reach,
	reachableFraction = N > 0 and reach / N or 0,
	pocketsNoWayBack = pockets,
	pocketSamples = pocketSamples,
	reachableHighGround = high,
	highSamples = highSamples,
	reachableCoveredNodes = covered,
	reachableOutsideVisibleBounds = outside,
	outsideSamples = outsideSamples,
	dogSpawns = #dogSpawns,
	dogSpawnsReachSpawn = dogOk,
	dogDetail = dogDetail,
	bossSpawn = boss ~= nil,
	bossReachable = bossOk,
	floatingParts = floating,
	floatSamples = floatSamples,
	lighting = {
		clock = L.ClockTime, brightness = L.Brightness,
		ambient = tostring(L.Ambient), outdoorAmbient = tostring(L.OutdoorAmbient), sky = sky ~= nil,
		atmosphere = L:FindFirstChildOfClass("Atmosphere") ~= nil,
	},
})
