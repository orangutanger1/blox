local Players = game:GetService("Players")
local finish = workspace:WaitForChild("Obby"):WaitForChild("Finish")
finish.Touched:Connect(function(hit)
	local player = Players:GetPlayerFromCharacter(hit.Parent)
	if player and not player:GetAttribute("Finished") then
		player:SetAttribute("Finished", true)
		print(player.Name .. " finished!")
	end
end)
