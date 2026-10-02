-- Builds the base map at runtime (works with any sync method).
local function part(props)
	local p = Instance.new(props.ClassName or "Part")
	for k, v in props do if k ~= "ClassName" then p[k] = v end end
	p.Parent = workspace
	return p
end
if not workspace:FindFirstChild("Baseplate") then
	part({ Name = "Baseplate", Anchored = true, Size = Vector3.new(200, 2, 200), Position = Vector3.new(0, -1, 0), Color = Color3.fromRGB(90, 140, 90), TopSurface = Enum.SurfaceType.Smooth })
end
if not workspace:FindFirstChildWhichIsA("SpawnLocation") then
	part({ ClassName = "SpawnLocation", Name = "SpawnLocation", Anchored = true, Size = Vector3.new(8, 1, 8), Position = Vector3.new(0, 0.5, 0), Duration = 0 })
end
