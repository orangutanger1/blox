local ReplicatedStorage = game:GetService("ReplicatedStorage")

local PRICE = 10
local SPEED = 24

local buySpeed = Instance.new("RemoteFunction")
buySpeed.Name = "BuySpeed"
buySpeed.Parent = ReplicatedStorage

buySpeed.OnServerInvoke = function(player)
	local stats = player:FindFirstChild("leaderstats")
	local coins = stats and stats:FindFirstChild("Coins")
	local humanoid = player.Character and player.Character:FindFirstChildOfClass("Humanoid")
	if not coins or not humanoid or coins.Value < PRICE then
		return false
	end
	coins.Value -= PRICE
	humanoid.WalkSpeed = SPEED
	return true
end
