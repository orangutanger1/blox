-- @context client
local Players = game:GetService("Players")
local RS = game:GetService("ReplicatedStorage")
local function helper(...) return RS:WaitForChild("__BenchHelper", 5):InvokeServer(...) end
local function remote(name) return waitFor(function() return RS:FindFirstChild(name) end, 5, "no ReplicatedStorage." .. name) end
local function reset(cash, pets, rebirths)
	helper("setRebirths", rebirths or 0)
	helper("setPets", pets or {})
	helper("setCash", cash)
end
local valid = { Common = true, Rare = true, Legendary = true }

test("hatch: HatchEgg and Rebirth are RemoteFunctions", function()
	expect(remote("HatchEgg")).toBeA("RemoteFunction")
	expect(remote("Rebirth")).toBeA("RemoteFunction")
end)
test("hatch: refuses below EggCost and changes nothing", function()
	reset(49)
	expect(remote("HatchEgg"):InvokeServer()).toBeNil()
	local s = helper("get")
	expect(s.cash).toBe(49)
	expect(#s.pets).toBe(0)
end)
test("hatch: charges 50, adds one pet matching the returned rarity", function()
	reset(120)
	local r = remote("HatchEgg"):InvokeServer()
	expect(valid[r]).toBe(true)
	local s = helper("get")
	expect(#s.pets).toBe(1)
	expect(s.pets[1]).toBe(r)
	expect(s.cash).toBeGreaterThanOrEqual(70) -- one income tick may land in between
	expect(s.cash).toBeLessThan(96)
end)
test("hatch: full inventory (MaxPets) refuses without charging", function()
	local twelve = {}
	for i = 1, 12 do twelve[i] = "Common" end
	reset(1000, twelve)
	expect(remote("HatchEgg"):InvokeServer()).toBeNil()
	local s = helper("get")
	expect(#s.pets).toBe(12)
	expect(s.cash).toBeGreaterThanOrEqual(1000)
end)
test("hatch: client cannot choose the rarity", function()
	reset(100000)
	local legendary = 0
	for _ = 1, 10 do
		if remote("HatchEgg"):InvokeServer("Legendary", "Legendary") == "Legendary" then legendary += 1 end
	end
	expect(#helper("get").pets).toBe(10)
	expect(legendary).toBeLessThan(10)
end)
test("income: floor(sum * 1.5^rebirths) per second from the Pets folder", function()
	reset(0, { "Rare", "Rare" }, 2) -- 10 * 2.25 = 22.5 → 22 per tick
	task.wait(3.5)
	local gained = helper("get").cash
	expect(gained).toBeGreaterThanOrEqual(44)
	expect(gained).toBeLessThan(100)
	expect(gained % 22).toBe(0)
end)
test("rebirth: refuses below RebirthCost", function()
	reset(999)
	expect(remote("Rebirth"):InvokeServer()).toBe(false)
	local s = helper("get")
	expect(s.rebirths).toBe(0)
	expect(s.cash).toBeGreaterThanOrEqual(999)
end)
test("rebirth: resets cash to 100, clears pets, increments Rebirths", function()
	reset(1500, { "Rare", "Common" }, 1)
	expect(remote("Rebirth"):InvokeServer()).toBe(true)
	local s = helper("get")
	expect(s.rebirths).toBe(2)
	expect(#s.pets).toBe(0)
	expect(s.cash).toBe(100)
end)
test("ui: HUD with live CashLabel, HatchButton, RebirthButton (phone-sized)", function()
	local hud = waitFor(function()
		for _, c in Players.LocalPlayer.PlayerGui:GetChildren() do
			if c.Name == "HUD" and c:IsA("ScreenGui") then return c end
		end
		return nil
	end, 5, "no ScreenGui HUD")
	local label = hud:FindFirstChild("CashLabel", true)
	expect(label).toBeA("TextLabel")
	helper("setCash", 4321)
	local cash = Players.LocalPlayer.leaderstats.Cash
	pcall(waitFor, function() return label.Text == "Cash: " .. cash.Value end, 3)
	expect(label.Text).toBe("Cash: " .. cash.Value) -- reports the text actually shown
	for _, n in { "HatchButton", "RebirthButton" } do
		local b = hud:FindFirstChild(n, true)
		expect(b).toBeA("TextButton")
		expect(b.Visible).toBe(true)
		expect(b.AbsoluteSize.Y).toBeGreaterThanOrEqual(44)
	end
end)
