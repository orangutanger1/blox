-- @context server
local Players = game:GetService("Players")
local LogService = game:GetService("LogService")
test("Baseplate: anchored BasePart, >=100x100, top near Y=0", function()
	local bp = workspace:FindFirstChild("Baseplate", true)
	expect(bp).toExist()
	expect(bp).toBeA("BasePart")
	expect(bp.Anchored).toBe(true)
	expect(bp.Size.X).toBeGreaterThanOrEqual(100)
	expect(bp.Size.Z).toBeGreaterThanOrEqual(100)
	expect(math.abs(bp.Position.Y + bp.Size.Y / 2) <= 5).toBe(true)
end)
test("SpawnLocation exists", function()
	expect(workspace:FindFirstChildWhichIsA("SpawnLocation", true)).toExist()
end)
test("player spawns and stands on the baseplate", function()
	local p = waitFor(function() return Players:GetPlayers()[1] end, 10, "no player")
	local hrp = waitFor(function() return p.Character and p.Character:FindFirstChild("HumanoidRootPart") end, 10, "no character")
	task.wait(2)
	expect(hrp.Position.Y > -5 and hrp.Position.Y < 30).toBe(true)
	expect(p.Character:FindFirstChildOfClass("Humanoid").Health).toBeGreaterThan(0)
end)
test('server printed "Game ready" this session', function()
	local since = os.time() - time() - 2
	local found = false
	for _, e in LogService:GetLogHistory() do
		if e.timestamp >= since and string.find(e.message, "Game ready", 1, true) then found = true end
	end
	expect(found).toBe(true)
end)
