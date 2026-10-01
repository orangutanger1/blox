local Players = game:GetService("Players")

Players.PlayerAdded:Connect(function(player)
	local stats = Instance.new("Folder")
	stats.Name = "leaderstats"
	local coins = Instance.new("IntValue")
	coins.Name = "Coins"
	coins.Value = 0
	coins.Parent = stats
	stats.Parent = player
end)

local folder = Instance.new("Folder")
folder.Name = "Coins"
folder.Parent = workspace

local function setActive(coin, active)
	coin.Transparency = active and 0 or 1
	coin.CanTouch = active
	coin:SetAttribute("Active", active)
end

for i = 1, 5 do
	local coin = Instance.new("Part")
	coin.Name = "Coin"
	coin.Shape = Enum.PartType.Cylinder
	coin.Size = Vector3.new(0.6, 3, 3)
	coin.Color = Color3.fromRGB(255, 200, 0)
	coin.Material = Enum.Material.Neon
	coin.Anchored = true
	coin.CanCollide = false
	coin.Position = Vector3.new(-30 + i * 10, 3, 25)
	coin.Parent = folder
	setActive(coin, true)
	coin.Touched:Connect(function(hit)
		if not coin:GetAttribute("Active") then return end
		local player = Players:GetPlayerFromCharacter(hit.Parent)
		if not player then return end
		local stats = player:FindFirstChild("leaderstats")
		if not stats then return end
		setActive(coin, false)
		stats.Coins.Value += 1
		task.delay(5, function() setActive(coin, true) end)
	end)
end
