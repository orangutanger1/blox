local PointsService = {}

-- Adds `amount` points to the player's leaderstats.
function PointsService.award(player: Player, amount: number)
	local stats = player:FindFirstChild("leaderstats")
	if stats then
		local points = stats:FindFirstChild("Points")
		if points then
			points.Value += amount
		end
	end
end

return PointsService
