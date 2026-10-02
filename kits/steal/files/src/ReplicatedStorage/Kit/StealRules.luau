-- Steal rules for the steal-tycoon kit: locks, carrying, delivery, failure.
-- Pure logic keyed by user id with an injected clock, so specs run in the edit
-- context and the server (KitService) only applies what these rules decide.
-- Numbers come from Design/Tunables.tunables (stealRange, carryMaxSec,
-- lockSec, lockCooldownSec, baseSlots); never hard-code them here.
--
-- A carried pet has already left its owner (KitService decrements the owner's
-- generator count on steal); delivery or failure decides who gets it back.

local StealRules = {}
StealRules.__index = StealRules

export type Carry = { thief: number, owner: number, kind: string, startedAt: number }

function StealRules.new(tunables, clock: (() -> number)?)
	local self = setmetatable({}, StealRules)
	self.T = tunables or {}
	self.now = clock or os.clock
	self.locks = {} -- [userId] = { untilT = n, readyAt = n }
	self.carries = {} -- [thiefId] = Carry
	return self
end

function StealRules:isLocked(owner: number): boolean
	local l = self.locks[owner]
	return l ~= nil and self.now() < l.untilT
end

function StealRules:lockRemaining(owner: number): number
	local l = self.locks[owner]
	return l and math.max(0, l.untilT - self.now()) or 0
end

function StealRules:cooldownRemaining(owner: number): number
	local l = self.locks[owner]
	return l and math.max(0, l.readyAt - self.now()) or 0
end

function StealRules:lock(owner: number): (boolean, string?)
	local l = self.locks[owner]
	local t = self.now()
	if l and t < l.readyAt then
		return false, l.untilT > t and "already locked" or "lock recharging"
	end
	local lockSec = self.T.lockSec or 45
	self.locks[owner] = { untilT = t + lockSec, readyAt = t + lockSec + (self.T.lockCooldownSec or 60) }
	return true, nil
end

function StealRules:carrying(thief: number): Carry?
	return self.carries[thief]
end

-- ctx: { ownerCount = n (owner's count of kind), distance = studs from thief to
-- owner's plot }. Returns ok, reason.
function StealRules:canSteal(thief: number, owner: number, kind: string, ctx): (boolean, string?)
	if thief == owner then
		return false, "that is your own base"
	end
	if self.carries[thief] then
		return false, "already carrying a pet"
	end
	if self:isLocked(owner) then
		return false, "base is locked"
	end
	if (ctx.ownerCount or 0) < 1 then
		return false, "no " .. kind .. " to steal"
	end
	if (ctx.distance or math.huge) > (self.T.stealRange or 30) then
		return false, "too far from that base"
	end
	return true, nil
end

function StealRules:startCarry(thief: number, owner: number, kind: string): Carry
	local c = { thief = thief, owner = owner, kind = kind, startedAt = self.now() }
	self.carries[thief] = c
	return c
end

-- Ends the carry. delivered = the thief keeps the pet; otherwise it goes back.
function StealRules:endCarry(thief: number): Carry?
	local c = self.carries[thief]
	self.carries[thief] = nil
	return c
end

function StealRules:expired(thief: number): boolean
	local c = self.carries[thief]
	return c ~= nil and self.now() - c.startedAt > (self.T.carryMaxSec or 45)
end

-- Can the thief take one more pet of `kind` home? counts = thief's owned
-- generator counts by kind; max = that kind's cap from the economy.
function StealRules:hasRoom(counts: { [string]: number }, kind: string, max: number?): (boolean, string?)
	local total = 0
	for _, n in counts do
		total += n
	end
	if total >= (self.T.baseSlots or math.huge) then
		return false, "base is full"
	end
	if max and (counts[kind] or 0) >= max then
		return false, "max " .. kind .. " pets"
	end
	return true, nil
end

-- A player who leaves takes nothing with them: drop their lock and carry state.
function StealRules:forget(userId: number): Carry?
	self.locks[userId] = nil
	return self:endCarry(userId)
end

return StealRules
