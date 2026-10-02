-- @context server
-- Bench-only helper so client checks can set/read server state. Not part of the game.
test("helper: install", function()
	local rf = Instance.new("RemoteFunction")
	rf.Name = "__BenchHelper"
	rf.OnServerInvoke = function(player, op, value)
		local ls = player:FindFirstChild("leaderstats")
		local pets = player:FindFirstChild("Pets")
		if op == "setCash" and ls then ls.Cash.Value = value return true end
		if op == "setRebirths" and ls then ls.Rebirths.Value = value return true end
		if op == "setPets" and pets then
			pets:ClearAllChildren()
			for i, name in value do
				local v = Instance.new("StringValue")
				v.Name = "Pet" .. i
				v.Value = name
				v.Parent = pets
			end
			return true
		end
		if op == "get" then
			local names = {}
			if pets then for _, v in pets:GetChildren() do if v:IsA("StringValue") then table.insert(names, v.Value) end end end
			return { cash = ls and ls.Cash.Value, rebirths = ls and ls.Rebirths.Value, pets = names }
		end
		return nil
	end
	rf.Parent = game:GetService("ReplicatedStorage")
	expect(rf.Parent).toExist()
end)
