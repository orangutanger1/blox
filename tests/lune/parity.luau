-- Evaluates kit Economy on JSON states: lune run parity.luau <projectDir> < states.json
-- stdin: [{bal, owned, open, chanceIncome}] → stdout: [{online, offline, costs, after}]
-- after = the state's balances after tick(state, 3600, true).
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local serde = require("@lune/serde")
local stdio = require("@lune/stdio")

local root = process.args[1]
local function load(rel)
	return luau.load(fs.readFile(root .. "/" .. rel), { debugName = rel })()
end
local Economy = load("src/ReplicatedStorage/Kit/Economy.luau")
local T = load("src/ReplicatedStorage/Design/Tunables.luau")
local e = Economy.new(T)

local out = {}
for _, st in serde.decode("json", stdio.readToEnd()) do
	local s = e:newState()
	for k, v in st.bal or {} do s.bal[k] = v end
	for k, v in st.owned or {} do s.owned[k] = v end
	for k, v in st.open or {} do s.open[k] = v end
	for k, v in st.chanceIncome or {} do s.chanceIncome[k] = v end
	local costs = {}
	for _, ref in e:itemRefs() do
		costs[ref] = (e:cost(s, ref))
	end
	if e.items.rebirth then costs.rebirth = (e:cost(s, "rebirth")) end
	local r1, r0 = e:rates(s, true), e:rates(s, false)
	e:tick(s, 3600, true)
	table.insert(out, { online = r1, offline = r0, costs = costs, after = s.bal })
end
print(serde.encode("json", out))
