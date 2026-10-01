-- Builds the map at runtime (works with any sync method).
local function part(props)
	local p = Instance.new(props.ClassName or "Part")
	for k, v in props do if k ~= "ClassName" then p[k] = v end end
	p.Parent = workspace
	return p
end
part({ Name = "Baseplate", Anchored = true, Size = Vector3.new(200, 2, 200), Position = Vector3.new(0, -1, 0), Color = Color3.fromRGB(90, 140, 90) })
part({ ClassName = "SpawnLocation", Name = "SpawnLocation", Anchored = true, Size = Vector3.new(8, 1, 8), Position = Vector3.new(0, 0.5, 0), Duration = 0 })
part({ Name = "PressurePlate", Anchored = true, CanCollide = false, Size = Vector3.new(6, 0.4, 6), Position = Vector3.new(0, 0.2, 20), Color = Color3.fromRGB(200, 60, 60) })
part({ Name = "Door", Anchored = true, Size = Vector3.new(12, 12, 1), Position = Vector3.new(0, 6, 35), Color = Color3.fromRGB(110, 80, 50) })
