-- @context server
-- Kit server glue: data, tick, gates, purchases, rebirth. Generic over the
-- current Tunables, so retuning numbers keeps it green.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")
local Tunables = require(ReplicatedStorage:WaitForChild("Design"):WaitForChild("Tunables"))

local function player()
	return waitFor(function()
		return Players:GetPlayers()[1]
	end, 10, "no player joined")
end
local function api()
	return waitFor(function()
		return ServerStorage:FindFirstChild("KitApi")
	end, 10, "KitApi missing: did the server Bootstrap start KitService?")
end
local function state(p)
	return waitFor(function()
		return api():Invoke("getState", p)
	end, 10, "no kit state for player")
end
local function lowestGate()
	local best
	for id, g in Tunables.economy.gates or {} do
		if not g.needs.consume and not g.claim and (not best or g.needs.amount < best.amount) then
			best = { id = id, res = g.needs.res, amount = g.needs.amount }
		end
	end
	return best
end

test("joining player gets state, leaderstats and remotes", function()
	local p = player()
	local s = state(p)
	for res, r in Tunables.economy.resources do
		expect(s.bal[res]).toBeGreaterThanOrEqual(0)
	end
	expect(waitFor(function()
		return p:FindFirstChild("leaderstats")
	end, 5, "no leaderstats")).toExist()
	local remotes = ReplicatedStorage.Kit:WaitForChild("Remotes", 5)
	expect(remotes:FindFirstChild("Purchase")).toBeA("RemoteFunction")
	expect(remotes:FindFirstChild("Rebirth")).toBeA("RemoteFunction")
	expect(type(p:GetAttribute("KitState"))).toBe("string")
end)

test("reaching a gate threshold opens it and unlocks what it gates", function()
	local p = player()
	local g = lowestGate()
	if not g then
		return
	end
	local s = state(p)
	expect(api():Invoke("grant", p, g.res, g.amount)).toBe(true)
	s = waitFor(function()
		local st = api():Invoke("getState", p)
		return st.open[g.id] and st
	end, 5, "gate " .. g.id .. " did not open")
	for id, gen in Tunables.economy.generators or {} do
		if gen.requires == "gate:" .. g.id then
			api():Invoke("grant", p, gen.cost.res, gen.cost.base)
			local ok, err = api():Invoke("purchase", p, "generator:" .. id)
			expect(ok).toBe(true)
			expect(err).toBeNil()
		end
	end
end)

test("rebirth spends the cost and increments the count", function()
	local rb = Tunables.economy.rebirth
	if not rb then
		return
	end
	local p = player()
	local before = state(p).owned.rebirth or 0
	local need = rb.needs.base * (rb.needs.growth or 1) ^ before
	api():Invoke("grant", p, rb.needs.res, need)
	local ok, err = api():Invoke("rebirth", p)
	expect(err).toBeNil()
	expect(ok).toBe(true)
	expect(state(p).owned.rebirth).toBe(before + 1)
end)

test("purchase remote rejects junk input", function()
	local p = player()
	local ok, err = api():Invoke("purchase", p, "generator:does-not-exist")
	expect(ok).toBe(false)
	expect(err).toBe("unknown item")
end)
