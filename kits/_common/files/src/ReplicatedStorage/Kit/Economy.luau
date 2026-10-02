-- Kit economy: the runtime twin of blox's design simulator (src/design/sim.ts).
-- Same rules, same numbers: rates, cost growth, upgrade mult/add, gates,
-- chance rolls, drains, offline accrual and rebirth. Pure logic — no Instances —
-- so specs run in the edit context. Numbers come from Design/Tunables (generated
-- from .blox/design.json); never hard-code them here.
--
-- State (JSON-able; it is also the saved data shape):
--   bal = {res = n}, owned = {["generator:x"] = n, ["upgrade:x"] = n, ["chance:x"] = n,
--   ["gate:x"] = n, rebirth = n}, open = {gateId = true}, chanceIncome = {res = n},
--   passes = {monetizationId = true}

local Economy = {}
Economy.__index = Economy

local EPS = 1e-9
local function ge(a: number, b: number): boolean
	return a >= b - EPS * math.max(1, math.abs(b))
end

local function parseRef(ref: string): (string, string, number?)
	local kind, id, n = string.match(ref, "^(%a+):([%w_%-]+):?(%d*)$")
	if not kind then
		return ref, ref, nil
	end
	return kind, id, (n ~= "" and tonumber(n) or nil)
end
Economy.parseRef = parseRef

local function sortedKeys(t)
	local keys = {}
	for k in t or {} do
		table.insert(keys, k)
	end
	table.sort(keys)
	return keys
end

function Economy.new(tunables)
	local self = setmetatable({}, Economy)
	self.T = tunables
	self.E = tunables.economy
	-- Purchasable items (generators, upgrades, chance, consume-gates, rebirth).
	local items = {}
	local function add(kind, id, def, cost, max, requires)
		items[kind == "rebirth" and "rebirth" or (kind .. ":" .. id)] = {
			kind = kind,
			id = id,
			def = def,
			cost = { res = cost.res, base = cost.base, growth = cost.growth or 1 },
			max = max or math.huge,
			requires = requires,
		}
	end
	for id, g in self.E.generators or {} do
		add("generator", id, g, g.cost, g.max, g.requires)
	end
	for id, u in self.E.upgrades or {} do
		add("upgrade", id, u, u.cost, u.max or 1, u.requires)
	end
	for id, c in self.E.chance or {} do
		add("chance", id, c, c.cost, c.max, c.requires)
	end
	for id, g in self.E.gates or {} do
		if g.needs.consume then
			add("gate", id, g, { res = g.needs.res, base = g.needs.amount, growth = 1 }, 1, g.requires)
		end
	end
	if self.E.rebirth then
		add("rebirth", "rebirth", self.E.rebirth, self.E.rebirth.needs, math.huge, nil)
	end
	self.items = items
	self.decay = {}
	for res in self.E.resources do
		self.decay[res] = 0
	end
	for _, d in self.E.drains or {} do
		self.decay[d.res] += d.fractionPerHour / 3600
	end
	return self
end

function Economy:newState()
	local s = { bal = {}, owned = {}, open = {}, chanceIncome = {}, passes = {} }
	for res, r in self.E.resources do
		s.bal[res] = r.start or 0
	end
	return s
end

function Economy:requiresMet(s, ref: string?): boolean
	if not ref then
		return true
	end
	local kind, id, n = parseRef(ref)
	if kind == "gate" then
		return s.open[id] == true
	elseif kind == "rebirth" then
		return (s.owned.rebirth or 0) >= tonumber(id)
	elseif kind == "action" then
		return true
	end
	return (s.owned[kind .. ":" .. id] or 0) >= (n or 1)
end

function Economy:count(s, ref: string): number
	return s.owned[ref] or 0
end

function Economy:cost(s, ref: string): (number, string)
	local it = self.items[ref]
	assert(it, "unknown item " .. tostring(ref))
	return it.cost.base * it.cost.growth ^ self:count(s, ref), it.cost.res
end

function Economy:available(s, ref: string): (boolean, string?)
	local it = self.items[ref]
	if not it then
		return false, "unknown item"
	end
	if not self:requiresMet(s, it.requires) then
		return false, "locked (needs " .. it.requires .. ")"
	end
	if self:count(s, ref) >= it.max then
		return false, "maxed"
	end
	if it.kind == "gate" and s.open[it.id] then
		return false, "already open"
	end
	return true, nil
end

-- Refs of everything purchasable except rebirth, cheapest base first.
function Economy:itemRefs(): { string }
	local refs = {}
	for ref, it in self.items do
		if it.kind ~= "rebirth" then
			table.insert(refs, ref)
		end
	end
	table.sort(refs, function(a, b)
		local ca, cb = self.items[a].cost.base, self.items[b].cost.base
		if ca ~= cb then
			return ca < cb
		end
		return a < b
	end)
	return refs
end

function Economy:rates(s, online: boolean): { [string]: number }
	local E = self.E
	local base = {}
	for res in E.resources do
		base[res] = 0
	end
	if online then
		for _, a in E.actions or {} do
			if self:requiresMet(s, a.requires) then
				for res, v in a.yields do
					base[res] += v * a.perSec
				end
			end
		end
	end
	for id, g in E.generators or {} do
		local n = s.owned["generator:" .. id] or 0
		if n > 0 then
			for res, v in g.produces do
				base[res] += v * n
			end
		end
	end
	for id, u in E.upgrades or {} do
		local n = s.owned["upgrade:" .. id] or 0
		if n > 0 and u.effect.add ~= nil then
			base[u.effect.target] += u.effect.add * n
		end
	end
	for res, v in s.chanceIncome do
		base[res] += v
	end
	local all, mult = 1, {}
	for id, u in E.upgrades or {} do
		local n = s.owned["upgrade:" .. id] or 0
		if n > 0 and u.effect.mult ~= nil then
			local f = u.effect.mult ^ n
			if u.effect.target == "*" then
				all *= f
			else
				mult[u.effect.target] = (mult[u.effect.target] or 1) * f
			end
		end
	end
	local rb = E.rebirth
	if rb then
		local f = rb.mult.per ^ (s.owned.rebirth or 0)
		if rb.mult.target == "*" then
			all *= f
		else
			mult[rb.mult.target] = (mult[rb.mult.target] or 1) * f
		end
	end
	local out = {}
	for res, v in base do
		out[res] = v * all * (mult[res] or 1)
	end
	return out
end

-- Closed-form advance: linear, or exponential approach to rate/decay under drains.
function Economy:advance(s, dt: number, rates)
	for res, b0 in s.bal do
		local k = self.decay[res] or 0
		local r = rates[res] or 0
		if k == 0 then
			s.bal[res] = b0 + r * dt
		else
			local eq = r / k
			s.bal[res] = eq + (b0 - eq) * math.exp(-k * dt)
		end
	end
end

-- Opens threshold gates that are now reached; returns newly opened ids (sorted).
function Economy:openGates(s): { string }
	local opened = {}
	for _, id in sortedKeys(self.E.gates) do
		local g = self.E.gates[id]
		if not g.needs.consume and not s.open[id] and self:requiresMet(s, g.requires) and ge(s.bal[g.needs.res] or 0, g.needs.amount) then
			s.open[id] = true
			table.insert(opened, id)
		end
	end
	return opened
end

function Economy:tick(s, dt: number, online: boolean): { string }
	self:advance(s, dt, self:rates(s, online))
	return self:openGates(s)
end

-- Time away: generator income × offline.fraction for up to offline.capSec, then
-- drains only. Mirrors the simulator's between-session accrual.
function Economy:offline(s, elapsed: number)
	if elapsed <= 0 then
		return
	end
	local off = self.E.offline
	local earn = 0
	if off then
		earn = math.min(elapsed, off.capSec)
		local r = self:rates(s, false)
		for res, v in r do
			r[res] = v * off.fraction
		end
		self:advance(s, earn, r)
	end
	if elapsed > earn then
		self:advance(s, elapsed - earn, {})
	end
	self:openGates(s)
end

local function applyGrants(s, grants)
	for g, v in grants do
		local kind, id = parseRef(g)
		if kind == "income" then
			s.chanceIncome[id] = (s.chanceIncome[id] or 0) + v
		else
			s.bal[id] = (s.bal[id] or 0) + v
		end
	end
end

-- Pass effects of type upgrade:<id> grant that upgrade at max (as the simulator does).
function Economy:applyPasses(s)
	for mid in s.passes do
		local m = self.T.monetization and self.T.monetization[mid]
		if m then
			local kind, id = parseRef(m.effect)
			local u = kind == "upgrade" and self.E.upgrades and self.E.upgrades[id]
			if u then
				s.owned["upgrade:" .. id] = u.max or 1
			end
		end
	end
end

function Economy:grantPass(s, monetizationId: string): (boolean, string?)
	if not (self.T.monetization and self.T.monetization[monetizationId]) then
		return false, "unknown monetization " .. monetizationId
	end
	s.passes[monetizationId] = true
	self:applyPasses(s)
	return true, nil
end

-- Returns ok, err, outcomeId (chance items).
function Economy:purchase(s, ref: string, rng: (() -> number)?): (boolean, string?, string?)
	local ok, why = self:available(s, ref)
	if not ok then
		return false, why, nil
	end
	local price, res = self:cost(s, ref)
	if not ge(s.bal[res] or 0, price) then
		return false, "not enough " .. res, nil
	end
	local it = self.items[ref]
	if it.kind == "rebirth" then
		return self:rebirth(s)
	end
	s.bal[res] -= price
	s.owned[ref] = self:count(s, ref) + 1
	local outcome = nil
	if it.kind == "gate" then
		s.open[it.id] = true
	elseif it.kind == "chance" then
		local ids, total = sortedKeys(it.def.outcomes), 0
		for _, oid in ids do
			total += it.def.outcomes[oid].weight
		end
		local x = (rng or math.random)() * total
		outcome = ids[#ids]
		for _, oid in ids do
			x -= it.def.outcomes[oid].weight
			if x < 0 then
				outcome = oid
				break
			end
		end
		applyGrants(s, it.def.outcomes[outcome].grants)
	end
	self:openGates(s)
	return true, nil, outcome
end

function Economy:canRebirth(s): boolean
	if not self.items.rebirth then
		return false
	end
	local price, res = self:cost(s, "rebirth")
	return ge(s.bal[res] or 0, price)
end

function Economy:rebirth(s): (boolean, string?, string?)
	local rb = self.E.rebirth
	if not rb then
		return false, "no rebirth in this design", nil
	end
	if not self:canRebirth(s) then
		return false, "not enough " .. rb.needs.res, nil
	end
	local price, res = self:cost(s, "rebirth")
	s.bal[res] -= price
	s.owned.rebirth = (s.owned.rebirth or 0) + 1
	local prefixes = { generators = "generator:", upgrades = "upgrade:", chance = "chance:", gates = "gate:" }
	for _, r in rb.resets or {} do
		local resDef = self.E.resources[r]
		if resDef then
			s.bal[r] = resDef.start or 0
		else
			local prefix = prefixes[r]
			for key in table.clone(s.owned) do
				if prefix and string.sub(key, 1, #prefix) == prefix then
					s.owned[key] = nil
				end
			end
			if r == "chance" then
				s.chanceIncome = {}
			elseif r == "gates" then
				s.open = {}
			end
		end
	end
	self:applyPasses(s)
	self:openGates(s)
	return true, nil, nil
end

return Economy
