-- @context edit
-- Kit economy rules (same rules as `blox design simulate`). Uses a small inline
-- design so these specs keep passing when you retune Design/Tunables.
local Economy = require(game:GetService("ReplicatedStorage").Kit.Economy)

local function T(extra)
	local t = {
		monetization = { vip = { kind = "pass", effect = "upgrade:x2" } },
		economy = {
			resources = { cash = { start = 0, spendable = true }, speed = { start = 16, spendable = false } },
			actions = { step = { yields = { speed = 1, cash = 0.5 }, perSec = 2 } },
			gates = {
				wall1 = { needs = { res = "speed", amount = 100, consume = false } },
				vault = { needs = { res = "cash", amount = 50, consume = true } },
			},
			generators = { pet = { produces = { cash = 1 }, cost = { res = "cash", base = 10, growth = 2 }, max = 3, requires = "gate:wall1" } },
			upgrades = {
				shoes = { cost = { res = "cash", base = 5, growth = 1 }, effect = { target = "speed", mult = 1.5 }, max = 2 },
				x2 = { cost = { res = "cash", base = 1e9, growth = 1 }, effect = { target = "*", mult = 2 }, max = 1 },
			},
			chance = {
				egg = {
					cost = { res = "cash", base = 1, growth = 1 },
					outcomes = { common = { weight = 3, grants = { ["income:cash"] = 1 } }, rare = { weight = 1, grants = { ["res:cash"] = 100 } } },
				},
			},
			rebirth = { needs = { res = "cash", base = 1000, growth = 2 }, mult = { target = "*", per = 1.5 }, resets = { "cash", "speed", "generators", "upgrades", "gates" } },
			offline = { fraction = 0.5, capSec = 100 },
			drains = {},
		},
	}
	for k, v in extra or {} do
		t.economy[k] = v
	end
	return t
end

local function fresh(extra)
	local e = Economy.new(T(extra))
	return e, e:newState()
end

test("new state uses start balances", function()
	local _, s = fresh()
	expect(s.bal.cash).toBe(0)
	expect(s.bal.speed).toBe(16)
end)

test("online rates include actions; offline rates do not", function()
	local e, s = fresh()
	expect(e:rates(s, true).speed).toBe(2)
	expect(e:rates(s, true).cash).toBe(1)
	expect(e:rates(s, false).cash).toBe(0)
end)

test("threshold gates open on tick and unlock requires", function()
	local e, s = fresh()
	s.bal.cash = 100
	local ok, why = e:purchase(s, "generator:pet")
	expect(ok).toBe(false)
	expect(why).toContain("locked")
	local opened = e:tick(s, 42, true) -- 16 + 2*42 = 100
	expect(opened).toEqual({ "wall1" })
	expect((e:purchase(s, "generator:pet"))).toBe(true)
end)

test("cost grows by growth^owned and max is enforced", function()
	local e, s = fresh()
	s.open.wall1 = true
	s.bal.cash = 1000
	expect((e:cost(s, "generator:pet"))).toBe(10)
	e:purchase(s, "generator:pet")
	expect((e:cost(s, "generator:pet"))).toBe(20)
	e:purchase(s, "generator:pet")
	e:purchase(s, "generator:pet")
	expect(s.bal.cash).toBe(1000 - 70)
	local ok, why = e:purchase(s, "generator:pet")
	expect(ok).toBe(false)
	expect(why).toBe("maxed")
	expect(e:rates(s, false).cash).toBe(3)
end)

test("cannot buy what you cannot afford", function()
	local e, s = fresh()
	local ok, why = e:purchase(s, "upgrade:shoes")
	expect(ok).toBe(false)
	expect(why).toBe("not enough cash")
end)

test("upgrade multipliers compose; '*' applies to all", function()
	local e, s = fresh()
	s.bal.cash = 10
	e:purchase(s, "upgrade:shoes")
	e:purchase(s, "upgrade:shoes")
	expect(e:rates(s, true).speed).toBeCloseTo(2 * 1.5 * 1.5, 1e-9)
	s.owned["upgrade:x2"] = 1
	expect(e:rates(s, true).cash).toBeCloseTo(2, 1e-9)
end)

test("consume gates are bought, open and stay open", function()
	local e, s = fresh()
	s.bal.cash = 60
	expect((e:purchase(s, "gate:vault"))).toBe(true)
	expect(s.open.vault).toBe(true)
	expect(s.bal.cash).toBe(10)
	expect((e:purchase(s, "gate:vault"))).toBe(false)
end)

test("chance rolls use the injected rng", function()
	local e, s = fresh()
	s.bal.cash = 10
	local _, _, a = e:purchase(s, "chance:egg", function() return 0.1 end) -- ids sorted: common(3), rare(1)
	expect(a).toBe("common")
	expect(s.chanceIncome.cash).toBe(1)
	local _, _, b = e:purchase(s, "chance:egg", function() return 0.9 end)
	expect(b).toBe("rare")
	expect(s.bal.cash).toBe(10 - 2 + 100)
end)

test("drains decay balances in closed form", function()
	local e, s = fresh({ drains = { theft = { res = "cash", fractionPerHour = 0.5 } } })
	s.bal.cash = 1000
	e:advance(s, 3600, {})
	expect(s.bal.cash).toBeCloseTo(1000 * math.exp(-0.5), 1e-6)
end)

test("offline earns generator income x fraction up to the cap", function()
	local e, s = fresh()
	s.open.wall1 = true
	s.owned["generator:pet"] = 2
	e:offline(s, 1000)
	expect(s.bal.cash).toBeCloseTo(2 * 0.5 * 100, 1e-9)
end)

test("rebirth spends, resets listed state, multiplies income and keeps passes", function()
	local e, s = fresh()
	e:grantPass(s, "vip")
	expect(s.owned["upgrade:x2"]).toBe(1)
	s.open.wall1 = true
	s.owned["generator:pet"] = 2
	s.owned["upgrade:shoes"] = 1
	s.bal.cash = 1500
	s.bal.speed = 500
	expect(e:canRebirth(s)).toBe(true)
	expect((e:rebirth(s))).toBe(true)
	expect(s.owned.rebirth).toBe(1)
	expect(s.bal.cash).toBe(0)
	expect(s.bal.speed).toBe(16)
	expect(s.owned["generator:pet"]).toBeNil()
	expect(s.owned["upgrade:shoes"]).toBeNil()
	expect(s.open.wall1).toBeNil()
	expect(s.owned["upgrade:x2"]).toBe(1)
	expect(e:rates(s, true).cash).toBeCloseTo(1 * 2 * 1.5, 1e-9)
	expect((e:cost(s, "rebirth"))).toBe(2000)
end)

test("itemRefs lists purchasables cheapest first", function()
	local e = fresh()
	expect(e:itemRefs()).toEqual({ "chance:egg", "upgrade:shoes", "generator:pet", "gate:vault", "upgrade:x2" })
end)
