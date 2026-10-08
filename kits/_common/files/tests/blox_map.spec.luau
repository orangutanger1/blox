-- @context edit
-- BloxMap: saturated palette, bright lighting, and building blocks with real
-- openings, invisible barriers and low triangle counts.
local Map = require(game:GetService("ReplicatedStorage").BloxMap)
local B, P = Map.Build, Map.Palette

local function inside(p: BasePart, pt: Vector3): boolean
	local l = p.CFrame:PointToObjectSpace(pt)
	return math.abs(l.X) < p.Size.X / 2 and math.abs(l.Y) < p.Size.Y / 2 and math.abs(l.Z) < p.Size.Z / 2
end

test("the palette is saturated except the neutrals", function()
	local n = 0
	for name, s in P.colors do
		local _, sat = s.color:ToHSV()
		if not P.neutral[name] then
			n += 1
			expect(sat >= 0.35).toBe(true)
		end
	end
	expect(n >= 15).toBe(true)
end)

test("bright lighting: colour correction boost and little haze", function()
	local L = game:GetService("Lighting")
	Map.Lighting.apply("bright")
	local cc = L:FindFirstChild("BloxMapColor")
	expect(cc).toExist()
	expect(cc.Saturation >= 0.1).toBe(true)
	local atm = L:FindFirstChildOfClass("Atmosphere")
	expect(atm.Haze <= 0.3).toBe(true)
	expect(atm.Density <= 0.3).toBe(true)
end)

test("an enterable house has a real door gap, a floor, a roof and a tagged interior", function()
	local root = Instance.new("Model")
	local h = B.house(
		root,
		"House",
		CFrame.new(0, 0, 0),
		{ L = 24, D = 18, H = 20, style = "cream", roof = "gable", enterable = true }
	)
	local doorCentre = Vector3.new(0, 4, 18 / 2 - 0.5)
	for _, p in h:GetDescendants() do
		if p:IsA("BasePart") and p.CanCollide then
			expect(inside(p, doorCentre)).toBe(false)
		end
	end
	expect(h:FindFirstChild("Floor", true)).toExist()
	expect(h:FindFirstChild("Roof", true)).toExist()
	local vol = h:FindFirstChild("InteriorVolume", true)
	expect(vol).toExist()
	expect(vol.CanCollide).toBe(false)
	expect(vol:HasTag("Interior")).toBe(true)
end)

test("a closed house is solid, and flat roofs work", function()
	local root = Instance.new("Model")
	local h = B.house(
		root,
		"Shed",
		CFrame.new(50, 0, 0),
		{ L = 12, D = 10, H = 10, style = "barnRed", roof = "flat", enterable = false }
	)
	expect(h:FindFirstChild("Body")).toExist()
	expect(h:FindFirstChild("Roof", true)).toExist()
	expect(h:FindFirstChild("InteriorVolume", true)).toBe(nil)
end)

test("boundary: visible walls plus a taller invisible barrier", function()
	local root = Instance.new("Model")
	local f = B.boundary(root, { centre = Vector3.new(0, 0, 0), size = Vector2.new(200, 160), height = 24 })
	local walls, barriers = 0, 0
	for _, p in f:GetDescendants() do
		if p:IsA("BasePart") then
			if p.Transparency == 1 then
				barriers += 1
				expect(p.CanCollide).toBe(true)
				expect(p.Size.Y > 24).toBe(true)
			elseif p.Name == "Wall" then
				walls += 1
			end
		end
	end
	expect(walls).toBe(4)
	expect(barriers).toBe(4)
end)

test("roads get kerbs on both sides", function()
	local root = Instance.new("Model")
	local r = B.road(root, Vector3.new(-50, 0, 0), Vector3.new(50, 0, 0), { width = 16 })
	local kerbs = 0
	for _, p in r:GetChildren() do
		if p.Name == "Kerb" then
			kerbs += 1
		end
	end
	expect(kerbs).toBe(2)
end)

test("silo is a low-poly prism, no cylinder parts", function()
	local root = Instance.new("Model")
	local s = B.silo(root, Vector3.new(0, 0, 0), { radius = 6, height = 30 })
	local n = 0
	for _, p in s:GetDescendants() do
		if p:IsA("BasePart") then
			n += 1
			if p:IsA("Part") then
				expect(p.Shape == Enum.PartType.Cylinder).toBe(false)
			end
		end
	end
	expect(n <= 16).toBe(true)
end)

test("props are anchored, and small ones cast no shadow", function()
	local root = Instance.new("Model")
	B.crate(root, Vector3.new(0, 0, 0))
	B.bale(root, Vector3.new(10, 0, 0))
	B.fence(root, Vector3.new(0, 0, 10), Vector3.new(20, 0, 10))
	B.tree(root, Vector3.new(30, 0, 0))
	B.lamp(root, Vector3.new(40, 0, 0))
	for _, p in root:GetDescendants() do
		if p:IsA("BasePart") then
			expect(p.Anchored).toBe(true)
			if p.Size.Magnitude < 8 then
				expect(p.CastShadow).toBe(false)
			end
		end
	end
end)

test("markers are invisible, not collidable and not queryable", function()
	local root = Instance.new("Model")
	local m = B.marker(root, "BossSpawn", Vector3.new(0, 3, 0))
	expect(m.Transparency).toBe(1)
	expect(m.CanCollide).toBe(false)
	expect(m.CanQuery).toBe(false)
end)

test("night preset: dark sky, blue ambient (not black), no haze", function()
	local L = game:GetService("Lighting")
	Map.Lighting.apply("night")
	expect(L.ClockTime).toBe(0)
	local _, _, v = L.Ambient:ToHSV()
	expect(v > 0.2).toBe(true)
	expect(L:FindFirstChildOfClass("Atmosphere").Haze).toBe(0)
	Map.Lighting.apply("bright")
	expect(L.ClockTime).toBe(14)
	expect(L:FindFirstChildOfClass("Atmosphere").Haze <= 0.3).toBe(true)
end)

test("roofs, upper storeys and lintels are tagged Roof; walls and floors are not", function()
	local root = Instance.new("Model")
	local h =
		B.house(root, "House", CFrame.new(), { L = 24, D = 18, H = 20, roof = "gable", enterable = true })
	local tagged = {}
	for _, p in h:GetDescendants() do
		if p:IsA("BasePart") and p:HasTag("Roof") then
			tagged[p.Name] = true
		end
	end
	expect(tagged.Roof).toBe(true)
	expect(tagged.Gable).toBe(true)
	expect(tagged.UpperFloor).toBe(true)
	expect(tagged.Lintel).toBe(true)
	expect(tagged.SideWall).toBeNil()
	expect(tagged.Floor).toBeNil()
	local flat = B.house(root, "Shed", CFrame.new(40, 0, 0), { L = 10, D = 10, H = 8, roof = "flat" })
	expect(flat:FindFirstChild("Roof"):HasTag("Roof")).toBe(true)
end)

test("flat-top tree, car and tanker are anchored low-part props", function()
	local root = Instance.new("Model")
	for _, m in
		{
			B.flatTree(root, Vector3.new(0, 0, 0), { scale = 1.2, lean = 8 }),
			B.car(root, CFrame.new(20, 0, 0), { style = "skyBlue" }),
			B.tanker(root, CFrame.new(40, 0, 0)),
		}
	do
		local n = 0
		for _, p in m:GetDescendants() do
			if p:IsA("BasePart") then
				n += 1
				expect(p.Anchored).toBe(true)
				expect(p.Shape == Enum.PartType.Ball).toBe(false)
			end
		end
		expect(n >= 3 and n <= 24).toBe(true)
	end
	local body = root:FindFirstChild("Car"):FindFirstChild("Body")
	expect(body.Size.Z > 8 and body.Size.Z < 12).toBe(true) -- front -Z: length along Z
end)

test("canopy: lit white top tagged Roof on four pillars, no light casts shadows", function()
	local root = Instance.new("Model")
	local c = B.canopy(root, CFrame.new(), { L = 40, D = 20, H = 12, lights = true })
	local top = c:FindFirstChild("Canopy")
	expect(top:HasTag("Roof")).toBe(true)
	local pillars, lights = 0, 0
	for _, d in c:GetDescendants() do
		if d.Name == "Pillar" then
			pillars += 1
		end
		if d:IsA("Light") then
			lights += 1
			expect(d.Shadows).toBe(false)
		end
	end
	expect(pillars).toBe(4)
	expect(lights >= 2).toBe(true)
end)
