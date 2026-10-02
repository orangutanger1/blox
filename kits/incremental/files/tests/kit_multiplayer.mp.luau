-- @context multiplayer
-- @clients 2
-- Two players are independent: one player's purchase never touches the other's
-- state, and junk sent through the real client remote is rejected.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")
local Economy = require(ReplicatedStorage:WaitForChild("Kit"):WaitForChild("Economy"))
local Tunables = require(ReplicatedStorage:WaitForChild("Design"):WaitForChild("Tunables"))
local econ = Economy.new(Tunables)

local function api()
	return waitFor(function() return ServerStorage:FindFirstChild("KitApi") end, 10, "KitApi missing")
end
local function state(p)
	return waitFor(function() return api():Invoke("getState", p) end, 10, "no kit state for " .. p.Name)
end

test("each player has their own state", function()
	expect(#mp.players).toBe(2)
	expect(state(mp.players[1])).toExist()
	expect(state(mp.players[2])).toExist()
end)

test("a purchase by one player does not change the other's", function()
	local a, b = mp.players[1], mp.players[2]
	local sa = state(a)
	local ref
	for _, r in econ:itemRefs() do
		if econ:available(sa, r) then
			ref = r
			break
		end
	end
	expect(ref).toExist()
	local price, res = econ:cost(sa, ref)
	api():Invoke("grant", a, res, price)
	local before = state(b).owned[ref] or 0
	local ok, err = mp.client(a, "invoke", "ReplicatedStorage.Kit.Remotes.Purchase", ref)
	expect(err).toBeNil()
	expect(ok).toBe(true)
	expect(state(a).owned[ref]).toBe((sa.owned[ref] or 0) + 1)
	expect(state(b).owned[ref] or 0).toBe(before)
end)

test("junk input through the real remote is rejected", function()
	task.wait(0.3) -- purchase cooldown
	local ok, err = mp.client(mp.players[2], "invoke", "ReplicatedStorage.Kit.Remotes.Purchase", "generator:does-not-exist")
	expect(ok).toBe(false)
	expect(err).toBe("unknown item")
end)
