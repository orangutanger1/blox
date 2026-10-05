-- Gate grants + claim gates in kit Economy: lune run gates.luau <Economy.luau> <Tunables.luau>
-- Tunables has gates s1 (claim, jump>=10, grants wins 5) and s2 (auto, jump>=20, grants wins 50),
-- rebirth x2 resetting wins/jump/gates. Prints the steps as JSON.
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local serde = require("@lune/serde")

local function load(path)
	return luau.load(fs.readFile(path), { debugName = path })()
end
local Economy = load(process.args[1])
local e = Economy.new(load(process.args[2]))
local s = e:newState()
local out = {}
local function snap(label, ...)
	table.insert(out, { label = label, ret = { ... }, wins = s.bal.wins, s1 = s.open.s1 == true, s2 = s.open.s2 == true })
end
e:tick(s, 10, true)
snap("tick10")
snap("claimEarly", e:claimGate(s, "s2"))
snap("claim", e:claimGate(s, "s1"))
snap("claimAgain", e:claimGate(s, "s1"))
e:tick(s, 10, true)
snap("tick20")
s.bal.wins = 50
snap("rebirth", e:rebirth(s))
e:tick(s, 5, true)
snap("tick5")
snap("claimX2", e:claimGate(s, "s1"))
print(serde.encode("json", out))
