local Players = game:GetService("Players")
local PointsService = require(game:GetService("ReplicatedStorage"):WaitForChild("PointsService"))

local function setup(player)
	local stats = Instance.new("Folder")
	stats.Name = "leaderstats"
	local points = Instance.new("IntValue")
	points.Name = "Points"
	points.Parent = stats
	stats.Parent = player
end
Players.PlayerAdded:Connect(setup)
for _, p in Players:GetPlayers() do setup(p) end

while true do
	task.wait(1)
	for _, player in Players:GetPlayers() do
		PointsService.award(player, 1)
	end
end
