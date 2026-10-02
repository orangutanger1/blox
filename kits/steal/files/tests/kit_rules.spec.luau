-- @context edit
-- Steal rules (pure): locks, carry limits, delivery room. Uses an inline clock
-- and tunables so these specs keep passing when you retune Design/Tunables.
local StealRules = require(game:GetService("ReplicatedStorage").Kit.StealRules)

local T = { stealRange = 30, carryMaxSec = 45, lockSec = 45, lockCooldownSec = 60, baseSlots = 5 }
local function fresh()
	local t = 0
	local r = StealRules.new(T, function()
		return t
	end)
	return r, function(dt)
		t += dt
	end
end
local near = { ownerCount = 1, distance = 10 }

test("a thief near a base with that pet can steal", function()
	local r = fresh()
	local ok, why = r:canSteal(1, 2, "rare", near)
	expect(ok).toBe(true)
	expect(why).toBeNil()
end)

test("you cannot steal from yourself, from afar, or what the owner lacks", function()
	local r = fresh()
	expect(select(2, r:canSteal(1, 1, "rare", near))).toBe("that is your own base")
	expect(select(2, r:canSteal(1, 2, "rare", { ownerCount = 1, distance = 31 }))).toBe("too far from that base")
	expect(select(2, r:canSteal(1, 2, "rare", { ownerCount = 0, distance = 1 }))).toBe("no rare to steal")
end)

test("one carry at a time", function()
	local r = fresh()
	r:startCarry(1, 2, "rare")
	expect(select(2, r:canSteal(1, 3, "common", near))).toBe("already carrying a pet")
	expect(r:carrying(1).owner).toBe(2)
	expect(r:endCarry(1).kind).toBe("rare")
	expect(r:carrying(1)).toBeNil()
end)

test("a locked base refuses, then unlocks after lockSec", function()
	local r, advance = fresh()
	expect(r:lock(2)).toBe(true)
	expect(select(2, r:canSteal(1, 2, "rare", near))).toBe("base is locked")
	expect(r:lockRemaining(2)).toBe(45)
	advance(45.1)
	expect(r:isLocked(2)).toBe(false)
	expect((r:canSteal(1, 2, "rare", near))).toBe(true)
end)

test("locking again waits for the cooldown", function()
	local r, advance = fresh()
	r:lock(2)
	expect(select(2, r:lock(2))).toBe("already locked")
	advance(50)
	expect(select(2, r:lock(2))).toBe("lock recharging")
	expect(r:cooldownRemaining(2)).toBe(55)
	advance(55)
	expect(r:lock(2)).toBe(true)
end)

test("a carry expires after carryMaxSec", function()
	local r, advance = fresh()
	r:startCarry(1, 2, "rare")
	advance(45)
	expect(r:expired(1)).toBe(false)
	advance(0.5)
	expect(r:expired(1)).toBe(true)
end)

test("room: total slots and per-kind caps", function()
	local r = fresh()
	expect(r:hasRoom({ common = 2, rare = 2 }, "rare", 8)).toBe(true)
	expect(select(2, r:hasRoom({ common = 3, rare = 2 }, "rare", 8))).toBe("base is full")
	expect(select(2, r:hasRoom({ rare = 3 }, "rare", 3))).toBe("max rare pets")
end)

test("forget drops lock and carry", function()
	local r = fresh()
	r:lock(1)
	r:startCarry(1, 2, "epic")
	expect(r:forget(1).kind).toBe("epic")
	expect(r:isLocked(1)).toBe(false)
	expect(r:carrying(1)).toBeNil()
end)
