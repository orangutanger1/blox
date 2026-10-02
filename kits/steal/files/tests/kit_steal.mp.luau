-- @context multiplayer
-- @clients 2
-- Stealing between two real players: the thief steals through the real client
-- remote and carries the pet home; a locked base refuses; the owner touching
-- the thief sends the pet back.
local ServerStorage = game:GetService("ServerStorage")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Tunables = require(ReplicatedStorage:WaitForChild("Design"):WaitForChild("Tunables"))

local function api()
	return waitFor(function() return ServerStorage:FindFirstChild("KitApi") end, 10, "KitApi missing")
end
local function plot(p)
	return waitFor(function() return api():Invoke("plot", p) end, 10, "no plot for " .. p.Name)
end
local function count(p, kind)
	return api():Invoke("getState", p).owned["generator:" .. kind] or 0
end
local function teleport(p, pos)
	p.Character:PivotTo(CFrame.new(pos + Vector3.new(0, 4, 0)))
	task.wait(0.2)
end
local kind, price
for id, g in Tunables.economy.generators do
	if not price or g.cost.base < price then
		kind, price = id, g.cost.base
	end
end
local function giveOwnerAPet(owner)
	api():Invoke("grant", owner, "cash", price * 3)
	local ok, err = api():Invoke("purchase", owner, "generator:" .. kind)
	expect(err).toBeNil()
	expect(ok).toBe(true)
end

test("steal through the real remote, carry home, deliver", function()
	local owner, thief = mp.players[1], mp.players[2]
	giveOwnerAPet(owner)
	local o0, t0 = count(owner, kind), count(thief, kind)
	teleport(thief, plot(owner).PrimaryPart.Position)
	teleport(owner, plot(thief).PrimaryPart.Position + Vector3.new(15, 0, 0)) -- out of tag range
	local ok, err = mp.client(thief, "invoke", "ReplicatedStorage.Kit.Remotes.Steal", owner.UserId, kind)
	expect(err).toBeNil()
	expect(ok).toBe(true)
	expect(count(owner, kind)).toBe(o0 - 1)
	expect(thief:GetAttribute("Carrying")).toBe(kind)
	teleport(thief, plot(thief).PrimaryPart.Position)
	api():Invoke("tick")
	expect(thief:GetAttribute("Carrying")).toBeNil()
	expect(count(thief, kind)).toBe(t0 + 1)
end)

test("a locked base refuses the remote", function()
	local owner, thief = mp.players[2], mp.players[1]
	giveOwnerAPet(owner)
	expect(api():Invoke("lock", owner)).toBe(true)
	teleport(thief, plot(owner).PrimaryPart.Position)
	task.wait(0.3) -- purchase cooldown
	local ok, err = mp.client(thief, "invoke", "ReplicatedStorage.Kit.Remotes.Steal", owner.UserId, kind)
	expect(ok).toBe(false)
	expect(err).toBe("base is locked")
end)

test("the owner tagging the thief sends the pet back", function()
	local owner, thief = mp.players[1], mp.players[2]
	giveOwnerAPet(owner)
	local o0 = count(owner, kind)
	teleport(thief, plot(owner).PrimaryPart.Position)
	teleport(owner, plot(thief).PrimaryPart.Position + Vector3.new(15, 0, 0))
	local ok = api():Invoke("steal", thief, owner, kind)
	expect(ok).toBe(true)
	expect(count(owner, kind)).toBe(o0 - 1)
	teleport(owner, thief.Character:GetPivot().Position)
	api():Invoke("tick")
	expect(thief:GetAttribute("Carrying")).toBeNil()
	expect(count(owner, kind)).toBe(o0)
end)
