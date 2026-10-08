import { longString } from '../studio/luau.js';

// Edit-context Luau for `map check`. A raycast grid finds every standable
// point (a 1.2 × HEADROOM standing volume must be free), joined by real moves:
// walk, jump up to JUMP studs, drop any height, with a clear sideways ray. BFS
// forward from the player spawns and backward to them gives reachability,
// pockets with no way back, and which named spawns can reach the players.
// Ported from the quality bake-off's neutral judge (map_metrics.luau) and the
// article arm's MapCheck, plus overlaps, interiors and colour saturation.

export interface MapCheckParams {
  root: string; // e.g. "Workspace.Map" or "ServerStorage.Maps.Farm" (cloned into Workspace for the check)
  playerSpawns?: string; // marker parts players start at: a path or a descendant name under the root; default SpawnLocations
  groups: Record<string, string>; // spawn group name → instance path
  jump: number | null; // studs incl. take-off; null = read StarterPlayer + 0.9
  step: number;
  headroom: number;
  maxColumns: number;
  interiorTag: string;
  boundary?: { min: [number, number]; max: [number, number] };
}

export const TAKEOFF = 0.9; // the Humanoid rises ~0.9 studs more than v²/2g (JumpPower 50 → 7.27)
export const PROBE = '__BloxMapProbe';
export const STAGE = '__BloxMapStage';

// Renders (triangle views, map shots) only see Workspace: put a copy of a map
// kept elsewhere (ServerStorage.Maps.<Id>) there while they run. Returns true when staged.
export function stageProgram(root: string, on: boolean): string {
  if (!on) return `local s = workspace:FindFirstChild("${STAGE}")
if s then s:Destroy() end
return s ~= nil`;
  return `local old = workspace:FindFirstChild("${STAGE}")
if old then old:Destroy() end
local cur = game
for name in string.gmatch(${JSON.stringify(root)}, "[^%.]+") do
	if not (cur == game and name == "game") then cur = cur and cur:FindFirstChild(name) end
end
if not cur or cur:IsDescendantOf(workspace) then return false end
local c = cur:Clone()
c.Name = "${STAGE}"
c.Parent = workspace
return true`;
}

export function mapCheckProgram(p: MapCheckParams): string {
  return `local HttpService = game:GetService("HttpService")
local CollectionService = game:GetService("CollectionService")
local P = HttpService:JSONDecode(${longString(JSON.stringify(p))})
local TAKEOFF = ${TAKEOFF}
local function resolve(path)
	local cur = game
	for name in string.gmatch(path, "[^%.]+") do
		if cur == game and (name == "game") then continue end
		cur = cur:FindFirstChild(name)
		if not cur then return nil end
	end
	return cur
end
local src = resolve(P.root)
if not src then error("map root " .. P.root .. " not found (set map.root in blox.config.json)") end
-- raycasts only see Workspace: check a copy of a map kept elsewhere (ServerStorage.Maps.<Id>)
-- and look at nothing but that copy, so the lobby or another map can't get in the way
local map, tmp = src, nil
if not src:IsDescendantOf(workspace) then
	tmp = src:Clone()
	tmp.Name = "__BloxMapCheck"
	tmp.Parent = workspace
	map = tmp
end
local function scoped(extra)
	local q = RaycastParams.new()
	if tmp then
		q.FilterType = Enum.RaycastFilterType.Include
		q.FilterDescendantsInstances = { tmp }
	else
		q.FilterType = Enum.RaycastFilterType.Exclude
		q.FilterDescendantsInstances = extra or {}
	end
	q.RespectCanCollide = true
	return q
end
-- a group path: absolute ("ServerStorage.Maps.Farm.DogSpawns") or a name under the root ("DogSpawns")
local function find(path)
	return resolve(path) or src:FindFirstChild(path, true)
end
local function points(g)
	local list = {}
	if g:IsA("BasePart") then list = { g } else for _, c in g:GetChildren() do if c:IsA("BasePart") or c:IsA("Model") then table.insert(list, c) end end end
	return list
end
local function where(c)
	if c:IsA("Model") then return c:GetPivot().Position, 0 end
	return c.Position, c.Size.Y
end
local SP = game:GetService("StarterPlayer")
local JUMP = P.jump
if JUMP == nil then
	local g = workspace.Gravity
	if SP.CharacterUseJumpPower then JUMP = SP.CharacterJumpPower ^ 2 / (2 * g) else JUMP = SP.CharacterJumpHeight end
	JUMP += TAKEOFF
end
local HEADROOM, MIN_NY = P.headroom, 0.6

local minV, maxV = Vector3.new(math.huge, math.huge, math.huge), Vector3.new(-math.huge, -math.huge, -math.huge)
local parts, visible, casters = 0, {}, 0
local satSum, areaSum = 0, 0
for _, d in map:GetDescendants() do
	if d:IsA("BasePart") then
		parts += 1
		if d.Transparency < 1 then
			table.insert(visible, d)
			if d.CastShadow then casters += 1 end
			local s = d.Size
			local area = 2 * (s.X * s.Y + s.Y * s.Z + s.X * s.Z)
			local _, sat = d.Color:ToHSV()
			satSum += sat * area
			areaSum += area
			local cf, h = d.CFrame, s / 2
			for _, sx in { -1, 1 } do
				for _, sy in { -1, 1 } do
					for _, sz in { -1, 1 } do
						local q = cf:PointToWorldSpace(Vector3.new(h.X * sx, h.Y * sy, h.Z * sz))
						minV = minV:Min(q)
						maxV = maxV:Max(q)
					end
				end
			end
		end
	end
end
if #visible == 0 then error("map root " .. P.root .. " has no visible parts") end

local spawns = {}
if P.playerSpawns then
	local g = find(P.playerSpawns)
	if not g then
		if tmp then tmp:Destroy() end
		error("player spawns " .. P.playerSpawns .. " not found under " .. P.root .. " (map.playerSpawns)")
	end
	for _, c in points(g) do local pos, h = where(c) table.insert(spawns, { pos = pos, h = h }) end
else
	for _, d in src:GetDescendants() do
		if d:IsA("SpawnLocation") then table.insert(spawns, { pos = d.Position, h = d.Size.Y }) end
	end
	if #spawns == 0 then
		for _, d in workspace:GetDescendants() do
			if d:IsA("SpawnLocation") and not (tmp and d:IsDescendantOf(tmp)) then table.insert(spawns, { pos = d.Position, h = d.Size.Y }) end
		end
	end
end
if #spawns == 0 then
	if tmp then tmp:Destroy() end
	error("no player spawns in the map: add a SpawnLocation, or set map.playerSpawns to the marker parts players start at (map check walks from them)")
end

local params = scoped()

local PAD = 24
local topY = maxV.Y + 40
local STEP, x0, z0, nx, nz
-- grid window: [ax0, az0]..[ax1, az1] (+PAD), step grown to stay under maxColumns
local function window(ax0, az0, ax1, az1, step)
	local spanX, spanZ = ax1 - ax0 + 2 * PAD, az1 - az0 + 2 * PAD
	local cols = (spanX / step + 1) * (spanZ / step + 1)
	if cols > P.maxColumns then step = math.ceil(step * math.sqrt(cols / P.maxColumns) * 2) / 2 end
	STEP, x0, z0 = step, ax0 - PAD, az0 - PAD
	nx, nz = math.floor(spanX / step), math.floor(spanZ / step)
end

local probe = Instance.new("Part")
probe.Name = "${PROBE}"
probe.Anchored, probe.CanCollide, probe.CanQuery, probe.CanTouch = true, false, false, false
probe.Transparency = 1
probe.Size = Vector3.new(1.2, HEADROOM - 0.3, 1.2)
probe.Parent = workspace
local overlap = OverlapParams.new()
overlap.FilterType = if tmp then Enum.RaycastFilterType.Include else Enum.RaycastFilterType.Exclude
overlap.RespectCanCollide = true
overlap.FilterDescendantsInstances = if tmp then { tmp } else { probe }

local interiors = {}
for _, t in CollectionService:GetTagged(P.interiorTag) do
	if t:IsA("BasePart") then table.insert(interiors, { t.CFrame, t.Size })
	elseif t:IsA("Model") then local cf, sz = t:GetBoundingBox() table.insert(interiors, { cf, sz }) end
end
local function inInterior(pos)
	for _, b in interiors do
		local l = b[1]:PointToObjectSpace(pos)
		if math.abs(l.X) <= b[2].X / 2 and math.abs(l.Y) <= b[2].Y / 2 + 1 and math.abs(l.Z) <= b[2].Z / 2 then return true end
	end
	return false
end

local function search()
	local nodes, nodeY, nodeI, nodeJ, nodeRoof = {}, {}, {}, {}, {}
	local N = 0
	local groundYs = {}
	for i = 0, nx do
		nodes[i] = {}
		for j = 0, nz do
			local x, z = x0 + i * STEP, z0 + j * STEP
			local list, oy, lowest = {}, topY, nil
			for _ = 1, 8 do
				local r = workspace:Raycast(Vector3.new(x, oy, z), Vector3.new(0, -(oy - (minV.Y - 60)), 0), params)
				if not r then break end
				if r.Normal.Y >= MIN_NY then
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
		if i % 20 == 0 then task.wait() end
	end
	table.sort(groundYs)
	local groundY = groundYs[math.max(1, math.floor(#groundYs * 0.5))] or 0

	local adj, radj = {}, {}
	for n = 1, N do
		local out = {}
		local i, j, y = nodeI[n], nodeJ[n], nodeY[n]
		for _, d in { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } } do
			local col = nodes[i + d[1]] and nodes[i + d[1]][j + d[2]]
			if col then
				for _, m in col do
					if nodeY[m] - y <= JUMP then
						local h = math.max(y, nodeY[m]) + 2
						local a = Vector3.new(x0 + i * STEP, h, z0 + j * STEP)
						local b = Vector3.new(x0 + (i + d[1]) * STEP, h, z0 + (j + d[2]) * STEP)
						if not workspace:Raycast(a, b - a, params) then table.insert(out, m) end
					end
				end
			end
		end
		adj[n] = out
		radj[n] = radj[n] or {}
		if n % 4000 == 0 then task.wait() end
	end
	for n = 1, N do radj[n] = radj[n] or {} end
	for n = 1, N do for _, m in adj[n] do table.insert(radj[m], n) end end

	local function nearest(pos)
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
							local dd = math.abs(di) + math.abs(dj) + dy * 0.1
							if not bd or dd < bd then best, bd = n, dd end
						end
					end
				end
			end
		end
		return best
	end
	local function bfs(starts, graph)
		local seen, q, h = {}, {}, 1
		for _, s in starts do if s and not seen[s] then seen[s] = true table.insert(q, s) end end
		while h <= #q do
			local n = q[h]
			h += 1
			for _, m in graph[n] do if not seen[m] then seen[m] = true table.insert(q, m) end end
		end
		return seen
	end
	local starts = {}
	for _, s in spawns do table.insert(starts, nearest(s.pos + Vector3.new(0, s.h / 2, 0))) end
	local fwd, back = bfs(starts, adj), bfs(starts, radj)
	return { nodes = nodes, nodeY = nodeY, nodeI = nodeI, nodeJ = nodeJ, nodeRoof = nodeRoof, N = N, groundY = groundY, nearest = nearest, fwd = fwd, back = back }
end

local ok, err = pcall(function()
	-- coarse pass over everything visible finds the play area (a huge outskirts
	-- plane must not coarsen the real search), then a fine pass over it
	window(minV.X, minV.Z, maxV.X, maxV.Z, math.max(P.step, 4))
	local G = search()
	local cx0, cx1, cz0, cz1 = math.huge, -math.huge, math.huge, -math.huge
	for n = 1, G.N do
		if G.fwd[n] then
			local x, z = x0 + G.nodeI[n] * STEP, z0 + G.nodeJ[n] * STEP
			cx0, cx1, cz0, cz1 = math.min(cx0, x), math.max(cx1, x), math.min(cz0, z), math.max(cz1, z)
		end
	end
	if cx0 < math.huge then
		window(cx0 - STEP, cz0 - STEP, cx1 + STEP, cz1 + STEP, P.step)
		G = search()
	end
	local nodes, nodeY, nodeI, nodeJ, nodeRoof, N, groundY, nearest, fwd, back = G.nodes, G.nodeY, G.nodeI, G.nodeJ, G.nodeRoof, G.N, G.groundY, G.nearest, G.fwd, G.back

	local inMinX, inMaxX, inMinZ, inMaxZ = minV.X + 2, maxV.X - 2, minV.Z + 2, maxV.Z - 2
	if P.boundary then inMinX, inMinZ, inMaxX, inMaxZ = P.boundary.min[1], P.boundary.min[2], P.boundary.max[1], P.boundary.max[2] end
	local R = { reach = 0, pockets = 0, high = 0, covered = 0, coveredOutside = 0, outside = 0 }
	local S = { pockets = {}, high = {}, covered = {}, outside = {} }
	local seenS = {}
	local function sample(k, x, y, z)
		local t = string.format("%d,%d,%d", x, y, z)
		if #S[k] < 8 and not seenS[k .. t] then seenS[k .. t] = true table.insert(S[k], t) end
	end
	local rminX, rmaxX, rminZ, rmaxZ = math.huge, -math.huge, math.huge, -math.huge
	for n = 1, N do
		if fwd[n] then
			R.reach += 1
			local x, z, y = x0 + nodeI[n] * STEP, z0 + nodeJ[n] * STEP, nodeY[n]
			rminX, rmaxX, rminZ, rmaxZ = math.min(rminX, x), math.max(rmaxX, x), math.min(rminZ, z), math.max(rmaxZ, z)
			if not back[n] then R.pockets += 1 sample("pockets", x, y, z) end
			if y > groundY + JUMP + 0.5 then R.high += 1 sample("high", x, y, z) end
			if nodeRoof[n] then
				R.covered += 1
				if not inInterior(Vector3.new(x, y + 1, z)) then R.coveredOutside += 1 sample("covered", x, y, z) end
			end
			if x < inMinX or x > inMaxX or z < inMinZ or z > inMaxZ then R.outside += 1 sample("outside", x, y, z) end
		end
	end

	local groups = {}
	for name, path in pairs(P.groups) do
		local g = find(path)
		local entry = { name = name, path = path, found = g ~= nil, points = {} }
		if g then
			for _, c in points(g) do
				local pos = where(c)
				local n = nearest(pos)
				table.insert(entry.points, { name = c.Name, pos = string.format("%d,%d,%d", pos.X, pos.Y, pos.Z), reaches = n ~= nil and back[n] == true })
			end
		end
		table.insert(groups, entry)
	end

	-- floating: visible anchored collidable parts above the ground with nothing within 0.3 studs
	local op = OverlapParams.new()
	op.FilterType = if tmp then Enum.RaycastFilterType.Include else Enum.RaycastFilterType.Exclude
	if tmp then op.FilterDescendantsInstances = { tmp } end
	local floating, floatS = 0, {}
	for _, d in visible do
		if d.Anchored and d.CanCollide and d.Position.Y - d.Size.Y / 2 > groundY + 0.5 then
			if not tmp then op.FilterDescendantsInstances = { d } end
			local touching = 0
			for _, o in workspace:GetPartBoundsInBox(d.CFrame, d.Size + Vector3.new(0.6, 0.6, 0.6), op) do
				if o ~= d then touching += 1 end
			end
			if touching == 0 then
				floating += 1
				if #floatS < 8 then table.insert(floatS, (d:GetFullName():gsub("^Workspace%.__BloxMapCheck", P.root))) end
			end
		end
	end
	-- overlaps: parts whose geometry crosses another's by more than ~0.2 studs
	local overlaps, overS, seenPair = 0, {}, {}
	local oq = OverlapParams.new()
	oq.FilterType = Enum.RaycastFilterType.Include
	oq.FilterDescendantsInstances = { map }
	local shrink = probe:Clone()
	shrink.Parent = workspace
	-- ground layers (big flat parts at ground level) are where everything stands: not overlaps
	local function ground(d)
		return d.Size.Y < 6 and d.Size.X * d.Size.Z >= 1000 and d.Position.Y + d.Size.Y / 2 <= groundY + 1
	end
	for k, d in visible do
		if k > 4000 then break end
		if d:IsA("Part") and not ground(d) then
			shrink.Shape = d.Shape
			shrink.Size = Vector3.new(math.max(0.05, d.Size.X - 0.4), math.max(0.05, d.Size.Y - 0.4), math.max(0.05, d.Size.Z - 0.4))
			shrink.CFrame = d.CFrame
			for _, o in workspace:GetPartsInPart(shrink, oq) do
				if o ~= d and o.Transparency < 1 and not ground(o) then
					local a, b = d:GetFullName(), o:GetFullName()
					local key = if a < b then a .. "|" .. b else b .. "|" .. a
					if not seenPair[key] then
						seenPair[key] = true
						overlaps += 1
						if #overS < 8 then table.insert(overS, d.Name .. " × " .. o.Name .. " (" .. (d.Parent and d.Parent.Name or "?") .. ")") end
					end
				end
			end
		end
		if k % 500 == 0 then task.wait() end
	end
	shrink:Destroy()

	return {
		root = P.root, jump = JUMP, step = STEP, groundY = groundY, standable = N, reachable = R.reach,
		playerSpawns = #spawns, spawnPos = { spawns[1].pos.X, spawns[1].pos.Y, spawns[1].pos.Z },
		bbox = { min = { minV.X, minV.Y, minV.Z }, max = { maxV.X, maxV.Y, maxV.Z } },
		playBbox = { min = { rminX, minV.Y, rminZ }, max = { rmaxX, maxV.Y, rmaxZ } },
		groups = groups,
		pockets = R.pockets, pocketSamples = S.pockets, high = R.high, highSamples = S.high,
		covered = R.covered, coveredOutside = R.coveredOutside, coveredSamples = S.covered,
		outside = R.outside, outsideSamples = S.outside,
		floating = floating, floatSamples = floatS, overlaps = overlaps, overlapSamples = overS,
		saturation = if areaSum > 0 then satSum / areaSum else 0, parts = parts, shadowCasters = casters,
		lighting = (function()
			local L = game:GetService("Lighting")
			local atm = L:FindFirstChildOfClass("Atmosphere")
			local cc = 0
			for _, e in L:GetChildren() do
				if e:IsA("ColorCorrectionEffect") and e.Enabled then cc += e.Saturation end
			end
			return { haze = atm and atm.Haze or 0, density = atm and atm.Density or 0, ccSaturation = cc, brightness = L.Brightness }
		end)(),
	}
end)
probe:Destroy()
if tmp then tmp:Destroy() end
if not ok then error(err, 0) end
return HttpService:JSONEncode(err)`;
}

// Triangles/draw calls the renderer drew for one camera view (edit viewport).
export function triangleProgram(camera: { position: number[]; lookAt: number[] }): string {
  return `local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local ok, svc = pcall(function() return game:GetService("SceneAnalysisService") end)
if not ok or not svc then return HttpService:JSONEncode({ unavailable = true }) end
local cam = workspace.CurrentCamera
local oldType, oldCf = cam.CameraType, cam.CFrame
cam.CameraType = Enum.CameraType.Scriptable
cam.CFrame = CFrame.lookAt(Vector3.new(${camera.position.join(', ')}), Vector3.new(${camera.lookAt.join(', ')}))
for _ = 1, 4 do RunService.RenderStepped:Wait() end
local okc, r = pcall(function() return svc:GetTriangleCompositionAsync() end)
cam.CFrame = oldCf
cam.CameraType = oldType
if not okc then return HttpService:JSONEncode({ unavailable = true, error = tostring(r) }) end
local out = { opaque = 0, shadows = 0, drawcalls = 0 }
for _, c in r.Children or {} do
	local t = c.Sizes and c.Sizes.Triangles or 0
	if c.Name == "Opaque" or c.Name == "Transparent" then out.opaque += t
	elseif c.Name == "Shadows" then out.shadows += t end
	out.drawcalls += c.Sizes and c.Sizes.Drawcalls or 0
end
return HttpService:JSONEncode(out)`;
}
