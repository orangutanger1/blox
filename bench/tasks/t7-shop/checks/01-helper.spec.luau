-- @context server
-- Bench-only helper so client checks can set/read server state. Not part of the game.
test("helper: install", function()
	local rf = Instance.new("RemoteFunction")
	rf.Name = "__BenchHelper"
	rf.OnServerInvoke = function(player, op, value)
		local coins = player:FindFirstChild("leaderstats") and player.leaderstats:FindFirstChild("Coins")
		if op == "setCoins" and coins then coins.Value = value return true end
		if op == "get" then
			local hum = player.Character and player.Character:FindFirstChildOfClass("Humanoid")
			return { coins = coins and coins.Value, walkSpeed = hum and hum.WalkSpeed }
		end
		return nil
	end
	rf.Parent = game:GetService("ReplicatedStorage")
	expect(rf.Parent).toExist()
end)
