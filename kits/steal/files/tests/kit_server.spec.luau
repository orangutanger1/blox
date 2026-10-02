-- @context server
-- Kit server glue: plots, pets on display, earning, locking and a steal+deliver
-- round trip through ServerStorage.KitApi. Generic over the current Tunables, so
-- retuning numbers keeps it green.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")
local Economy = require(ReplicatedStorage:WaitForChild("Kit"):WaitForChild("Economy"))
local Tunables = require(ReplicatedStorage:WaitForChild("Design"):WaitForChild("Tunables"))
local econ = Economy.new(Tunables)

local function api()
	return waitFor(function() return ServerStorage:FindFirstChild("KitApi") end, 10, "KitApi missing")
end
local function me()
	return waitFor(function()
		local p = Players:GetPlayers()[1]
		return p and api():Invoke("getState", p) and p
	end, 10, "no player with kit state")
end
local function cheapestPet()
	local best, cost
	for id, g in Tunables.economy.generators do
		if not cost or g.cost.base < cost then
			best, cost = id, g.cost.base
		end
	end
	return best, cost
end

test("the player gets a plot with their name on it", function()
	local p = me()
	local plot = api():Invoke("plot", p)
	expect(plot).toExist()
	expect(plot:GetAttribute("Owner")).toBe(p.UserId)
	expect(p:GetAttribute("PlotIndex")).toBe(plot:GetAttribute("PlotIndex"))
end)

test("buying a pet shows it on the plot and it earns", function()
	local p = me()
	local kind, price = cheapestPet()
	api():Invoke("grant", p, "cash", price * 2)
	local before = #api():Invoke("plot", p).Pets:GetChildren()
	local ok, err = api():Invoke("purchase", p, "generator:" .. kind)
	expect(err).toBeNil()
	expect(ok).toBe(true)
	expect(#api():Invoke("plot", p).Pets:GetChildren()).toBe(before + 1)
	local cash = api():Invoke("getState", p).bal.cash
	waitFor(function() return api():Invoke("getState", p).bal.cash > cash end, 5, "cash did not grow")
end)

test("lock: on, then refused again while active", function()
	local p = me()
	local ok = api():Invoke("lock", p)
	expect(ok).toBe(true)
	expect(p:GetAttribute("LockRemaining")).toBeGreaterThan(0)
	expect(select(2, api():Invoke("lock", p))).toBe("already locked")
end)

test("you cannot steal from your own base", function()
	local p = me()
	local kind = cheapestPet()
	expect(select(2, api():Invoke("steal", p, p, kind))).toBe("that is your own base")
end)

test("purchases respect the per-pet cap", function()
	local p = me()
	local s = api():Invoke("getState", p)
	local kind = cheapestPet()
	local max = Tunables.economy.generators[kind].max
	if not max then return end
	for _ = 1, max do
		api():Invoke("grant", p, "cash", econ:cost(s, "generator:" .. kind) + 1)
		api():Invoke("purchase", p, "generator:" .. kind)
		s = api():Invoke("getState", p)
	end
	expect(s.owned["generator:" .. kind]).toBe(max)
end)
