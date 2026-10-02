-- @context server
local Players = game:GetService("Players")
local function player() return waitFor(function() return Players:GetPlayers()[1] end, 10, "no player") end
local function root(p) return waitFor(function() return p.Character and p.Character:FindFirstChild("HumanoidRootPart") end, 10, "no character") end
local function coinsValue(p)
	return waitFor(function() local ls = p:FindFirstChild("leaderstats") return ls and ls:FindFirstChild("Coins") end, 10, "no leaderstats.Coins")
end
local function coinParts()
	local folder = workspace:FindFirstChild("Coins")
	local out = {}
	if folder then for _, c in folder:GetDescendants() do if c:IsA("BasePart") and c.Name == "Coin" then table.insert(out, c) end end end
	return out
end
local function away(p) root(p).CFrame = CFrame.new(0, 6, -40) task.wait(0.4) end
local function touchAt(p, cf) root(p).CFrame = cf task.wait(0.6) end

test("coins: leaderstats.Coins IntValue exists", function()
	expect(coinsValue(player())).toBeA("IntValue")
end)
test("coins: at least 5 anchored Coin parts under Workspace.Coins", function()
	local cs = coinParts()
	expect(#cs).toBeGreaterThanOrEqual(5)
	for _, c in cs do expect(c.Anchored).toBe(true) end
end)
test("coins: touching a coin gives exactly +1 and disables that coin", function()
	local p = player()
	local v = coinsValue(p)
	away(p)
	local before = v.Value
	local target = coinParts()[1]
	local cf = target.CFrame
	touchAt(p, cf)
	waitFor(function() return v.Value == before + 1 end, 3, "Coins did not go up by 1 (now " .. v.Value .. ")")
	away(p)
	expect(v.Value).toBe(before + 1)
	touchAt(p, cf)
	away(p)
	expect(v.Value).toBe(before + 1)
end)
test("coins: a collected coin comes back after ~5s", function()
	local p = player()
	local v = coinsValue(p)
	away(p)
	local cf = coinParts()[2].CFrame
	local before = v.Value
	touchAt(p, cf)
	away(p)
	waitFor(function() return v.Value == before + 1 end, 3, "first pickup failed")
	task.wait(5.5)
	touchAt(p, cf)
	away(p)
	waitFor(function() return v.Value == before + 2 end, 3, "coin did not come back")
end)
