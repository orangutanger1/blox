-- Builds Workspace.Track: spawn pad, a long run, and one wall per threshold gate
-- (sorted by amount, `wallSpacing` studs apart). Walls carry the GateId attribute;
-- the HUD makes opened walls passable for that player.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Tunables = require(ReplicatedStorage:WaitForChild("Design"):WaitForChild("Tunables"))

return function(model: Model)
	local spacing = (Tunables.tunables and Tunables.tunables.wallSpacing) or 80
	local gates = {}
	for id, g in Tunables.economy.gates or {} do
		if not g.needs.consume then
			table.insert(gates, { id = id, res = g.needs.res, amount = g.needs.amount })
		end
	end
	table.sort(gates, function(a, b)
		return a.amount < b.amount
	end)
	local length = spacing * (#gates + 1)

	local spawn = Instance.new("SpawnLocation")
	spawn.Name = "Spawn"
	spawn.Anchored = true
	spawn.Size = Vector3.new(16, 1, 16)
	spawn.Position = Vector3.new(0, 0.5, 0)
	spawn.Neutral = true
	spawn.Parent = model

	local floor = Instance.new("Part")
	floor.Name = "Run"
	floor.Anchored = true
	floor.Size = Vector3.new(24, 1, length)
	floor.Position = Vector3.new(0, 0, -length / 2 - 8)
	floor.Color = Color3.fromRGB(70, 160, 90)
	floor.Material = Enum.Material.Grass
	floor.Parent = model

	for i, g in gates do
		local wall = Instance.new("Part")
		wall.Name = "Gate_" .. g.id
		wall.Anchored = true
		wall.Size = Vector3.new(24, 16, 2)
		wall.Position = Vector3.new(0, 8.5, -8 - spacing * i)
		wall.Color = Color3.fromHSV((i * 0.17) % 1, 0.7, 0.9)
		wall.Material = Enum.Material.Neon
		wall.Transparency = 0.1
		wall:SetAttribute("GateId", g.id)
		wall.Parent = model
		local sg = Instance.new("SurfaceGui")
		sg.Face = Enum.NormalId.Back -- faces the spawn (+Z)
		sg.Parent = wall
		local t = Instance.new("TextLabel")
		t.Size = UDim2.fromScale(1, 1)
		t.BackgroundTransparency = 1
		t.TextScaled = true
		t.Font = Enum.Font.GothamBlack
		t.TextColor3 = Color3.new(1, 1, 1)
		t.Text = g.amount .. " " .. g.res
		t.Parent = sg
	end
end
