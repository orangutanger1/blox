return function(model)
	local bp = Instance.new("Part")
	bp.Name = "Baseplate"
	bp.Anchored = true
	bp.Size = Vector3.new(200, 2, 200)
	bp.Position = Vector3.new(0, -1, 0)
	bp.Parent = model
	local sp = Instance.new("SpawnLocation")
	sp.Anchored = true
	sp.Size = Vector3.new(8, 1, 8)
	sp.Position = Vector3.new(0, 0.5, 0)
	sp.Parent = model
end
