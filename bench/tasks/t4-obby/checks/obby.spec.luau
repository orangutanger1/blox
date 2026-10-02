-- @context server
local Players = game:GetService("Players")
local function obby() return waitFor(function() return workspace:FindFirstChild("Obby") end, 5, "no Workspace.Obby") end
local function platform(i)
	return obby():FindFirstChild("Platform" .. i, true)
end
test("obby: Model with anchored Platform1..Platform6", function()
	expect(obby()).toBeA("Model")
	for i = 1, 6 do
		local p = platform(i)
		expect(p).toExist()
		expect(p).toBeA("BasePart")
		expect(p.Anchored).toBe(true)
	end
end)
test("obby: platforms climb, each jump reachable (rise <= 4.5, gap <= 10)", function()
	for i = 2, 6 do
		local a, b = platform(i - 1), platform(i)
		local topA = a.Position.Y + a.Size.Y / 2
		local topB = b.Position.Y + b.Size.Y / 2
		expect(topB).toBeGreaterThan(topA)
		expect(topB - topA <= 4.5).toBe(true)
		local d = (Vector2.new(a.Position.X, a.Position.Z) - Vector2.new(b.Position.X, b.Position.Z)).Magnitude
		local gap = d - (math.min(a.Size.X, a.Size.Z) + math.min(b.Size.X, b.Size.Z)) / 2
		if gap > 10 then error(("gap between Platform%d and Platform%d is %.1f studs"):format(i - 1, i, gap)) end
	end
end)
test("obby: touching Finish sets the Finished attribute and prints", function()
	local finish = obby():FindFirstChild("Finish", true)
	expect(finish).toExist()
	expect(finish).toBeA("BasePart")
	local p = waitFor(function() return Players:GetPlayers()[1] end, 10, "no player")
	local root = waitFor(function() return p.Character and p.Character:FindFirstChild("HumanoidRootPart") end, 10, "no character")
	root.CFrame = finish.CFrame + Vector3.new(0, 2, 0)
	waitFor(function() return p:GetAttribute("Finished") == true end, 3, "Finished attribute not set")
	local since = os.time() - time() - 2
	local found = false
	for _, e in game:GetService("LogService"):GetLogHistory() do
		if e.timestamp >= since and string.find(e.message, p.Name .. " finished!", 1, true) then found = true end
	end
	expect(found).toBe(true)
end)
