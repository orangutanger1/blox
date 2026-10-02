-- Builds Workspace.Bases: a central Market with one stand per pet rarity
-- (generator, cheapest first) and `meta.serverSize` plots in a ring around it.
-- Plots carry PlotIndex; the server assigns owners on join and renders each
-- owner's pets into Plot.Pets. Stands carry PetKind and a "Buy" prompt; plots a
-- "Lock base" prompt on their LockPad. Every size comes from Design/Tunables.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Tunables = require(ReplicatedStorage:WaitForChild("Design"):WaitForChild("Tunables"))

local RARITY_COLORS = {
	Color3.fromRGB(170, 170, 170),
	Color3.fromRGB(70, 140, 255),
	Color3.fromRGB(170, 80, 255),
	Color3.fromRGB(255, 190, 40),
	Color3.fromRGB(255, 70, 90),
	Color3.fromRGB(60, 230, 200),
}

local function part(
	parent: Instance,
	name: string,
	size: Vector3,
	cf: CFrame,
	color: Color3,
	material: Enum.Material?
)
	local p = Instance.new("Part")
	p.Name = name
	p.Anchored = true
	p.Size = size
	p.CFrame = cf
	p.Color = color
	p.Material = material or Enum.Material.SmoothPlastic
	p.TopSurface = Enum.SurfaceType.Smooth
	p.Parent = parent
	return p
end

local function sign(p: BasePart, text: string, face: Enum.NormalId?)
	local g = Instance.new("SurfaceGui")
	g.Name = "Sign"
	g.Face = face or Enum.NormalId.Front
	g.SizingMode = Enum.SurfaceGuiSizingMode.PixelsPerStud
	g.PixelsPerStud = 40
	g.Parent = p
	local l = Instance.new("TextLabel")
	l.Name = "Text"
	l.Size = UDim2.fromScale(1, 1)
	l.BackgroundTransparency = 1
	l.TextScaled = true
	l.Font = Enum.Font.GothamBlack
	l.TextColor3 = Color3.new(1, 1, 1)
	l.TextStrokeTransparency = 0
	l.Text = text
	l.Parent = g
	return l
end

local function prompt(parent: Instance, action: string, object: string)
	local pp = Instance.new("ProximityPrompt")
	pp.ActionText = action
	pp.ObjectText = object
	pp.HoldDuration = 0
	pp.MaxActivationDistance = 12
	pp.RequiresLineOfSight = false
	pp.Parent = parent
	return pp
end

return function(model: Model)
	local T = Tunables.tunables or {}
	local n = (Tunables.meta and Tunables.meta.serverSize) or 6
	local ring = T.plotRingRadius or 110
	local half = T.plotRadius or 22

	-- Market: stands sorted by base cost so rarity reads left to right.
	local market = Instance.new("Model")
	market.Name = "Market"
	market.Parent = model
	local floor = part(
		market,
		"Floor",
		Vector3.new(60, 1, 30),
		CFrame.new(0, 0, 0),
		Color3.fromRGB(90, 70, 50),
		Enum.Material.WoodPlanks
	)
	floor:SetAttribute("MarketFloor", true)
	local kinds = {}
	for id, g in Tunables.economy.generators or {} do
		table.insert(kinds, { id = id, base = g.cost.base })
	end
	table.sort(kinds, function(a, b)
		return a.base < b.base
	end)
	local spacing = math.min(10, 56 / math.max(1, #kinds))
	for i, k in kinds do
		local x = (i - (#kinds + 1) / 2) * spacing
		local stand = part(
			market,
			"Stand_" .. k.id,
			Vector3.new(spacing * 0.7, 4, 4),
			CFrame.new(x, 2.5, -8),
			RARITY_COLORS[(i - 1) % #RARITY_COLORS + 1],
			Enum.Material.Neon
		)
		stand:SetAttribute("PetKind", k.id)
		sign(stand, k.id)
		prompt(stand, "Buy", k.id)
	end

	-- Plots in a ring, each facing the market.
	for i = 1, n do
		local a = (i - 1) / n * math.pi * 2
		local center = Vector3.new(math.cos(a) * ring, 0, math.sin(a) * ring)
		local cf = CFrame.lookAt(center, Vector3.new(0, 0, 0))
		local plot = Instance.new("Model")
		plot.Name = "Plot" .. i
		plot:SetAttribute("PlotIndex", i)
		plot.Parent = model
		local base = part(
			plot,
			"Floor",
			Vector3.new(half * 2, 1, half * 2),
			cf,
			Color3.fromRGB(60, 120, 70),
			Enum.Material.Grass
		)
		plot.PrimaryPart = base
		local signPart = part(
			plot,
			"OwnerSign",
			Vector3.new(14, 4, 0.5),
			cf * CFrame.new(0, 6, -half),
			Color3.fromRGB(30, 30, 40)
		)
		sign(signPart, "Empty plot", Enum.NormalId.Front)
		sign(signPart, "Empty plot", Enum.NormalId.Back).Parent.Name = "SignBack"
		local pad = part(
			plot,
			"LockPad",
			Vector3.new(5, 0.4, 5),
			cf * CFrame.new(half - 4, 0.7, -half + 4),
			Color3.fromRGB(80, 200, 255),
			Enum.Material.Neon
		)
		prompt(pad, "Lock base", "Base")
		-- The shield is invisible until the owner locks the base.
		local shield = part(
			plot,
			"Shield",
			Vector3.new(half * 2 + 2, 14, half * 2 + 2),
			cf * CFrame.new(0, 7, 0),
			Color3.fromRGB(80, 200, 255),
			Enum.Material.ForceField
		)
		shield.Transparency = 1
		shield.CanCollide = false
		shield.CanQuery = false
		local pets = Instance.new("Folder")
		pets.Name = "Pets"
		pets.Parent = plot
	end

	-- Spawn on the market.
	local spawn = Instance.new("SpawnLocation")
	spawn.Name = "Spawn"
	spawn.Anchored = true
	spawn.Size = Vector3.new(10, 1, 10)
	spawn.CFrame = CFrame.new(0, 0.6, 10)
	spawn.Neutral = true
	spawn.Parent = model
end
