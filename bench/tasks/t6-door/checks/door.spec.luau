-- @context server
local Players = game:GetService("Players")
local function root()
	local p = waitFor(function() return Players:GetPlayers()[1] end, 10, "no player")
	return waitFor(function() return p.Character and p.Character:FindFirstChild("HumanoidRootPart") end, 10, "no character")
end
test("door: opens when a player steps on the plate", function()
	local door = workspace:WaitForChild("Door", 5)
	local plate = workspace:WaitForChild("PressurePlate", 5)
	expect(door).toExist()
	expect(plate).toExist()
	expect(door.CanCollide).toBe(true)
	root().CFrame = plate.CFrame + Vector3.new(0, 3, 0)
	waitFor(function() return door.CanCollide == false end, 3, "door did not open")
	expect(door.Transparency).toBeCloseTo(0.5, 0.01)
end)
test("door: closes again after ~3 seconds", function()
	local door = workspace.Door
	root().CFrame = CFrame.new(0, 5, -30)
	waitFor(function() return door.CanCollide == true end, 6, "door did not close")
	expect(door.Transparency).toBeCloseTo(0, 0.01)
end)
test("door: no infinite-yield warnings at runtime", function()
	local since = os.time() - time() - 2
	for _, e in game:GetService("LogService"):GetLogHistory() do
		if e.timestamp >= since and string.find(e.message, "Infinite yield possible", 1, true) then error(e.message) end
	end
end)
