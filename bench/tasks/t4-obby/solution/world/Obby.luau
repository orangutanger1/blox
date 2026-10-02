return function(model)
	model.Name = "Obby"
	for i = 1, 6 do
		local p = Instance.new("Part")
		p.Name = "Platform" .. i
		p.Anchored = true
		p.Size = Vector3.new(6, 1, 6)
		p.Position = Vector3.new(0, 1 + i * 3, 10 + i * 12)
		p.Color = Color3.fromHSV(i / 7, 0.7, 0.9)
		p.Parent = model
	end
	local f = Instance.new("Part")
	f.Name = "Finish"
	f.Anchored = true
	f.Size = Vector3.new(8, 1, 8)
	f.Position = Vector3.new(0, 22, 94)
	f.Color = Color3.fromRGB(255, 215, 0)
	f.Parent = model
end
