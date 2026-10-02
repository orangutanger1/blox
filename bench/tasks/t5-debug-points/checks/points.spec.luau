-- @context server
local Players = game:GetService("Players")
local function points()
	local p = waitFor(function() return Players:GetPlayers()[1] end, 10, "no player")
	return waitFor(function() local ls = p:FindFirstChild("leaderstats") return ls and ls:FindFirstChild("Points") end, 10, "no leaderstats.Points")
end
test("points: Points increase over time", function()
	local v = points()
	local start = v.Value
	waitFor(function() return v.Value >= start + 2 end, 5, "Points stuck at " .. v.Value)
end)
test("points: rate is about 1 per second", function()
	local v = points()
	local a = v.Value
	task.wait(4)
	local gained = v.Value - a
	if gained < 3 or gained > 5 then error("gained " .. gained .. " points in 4s (expected ~4)") end
end)
