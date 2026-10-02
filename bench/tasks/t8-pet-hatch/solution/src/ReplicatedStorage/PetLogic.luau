local Config = require(script.Parent:WaitForChild("PetConfig"))

local PetLogic = {}

local total = 0
local incomeByName = {}
for _, r in Config.Rarities do
	total += r.Weight
	incomeByName[r.Name] = r.Income
end

function PetLogic.rollRarity(r: number): string
	local acc = 0
	for _, rarity in Config.Rarities do
		acc += rarity.Weight / total
		if r < acc then
			return rarity.Name
		end
	end
	return Config.Rarities[#Config.Rarities].Name
end

function PetLogic.incomePerSecond(petNames: { string }, rebirths: number): number
	local sum = 0
	for _, name in petNames do
		sum += incomeByName[name] or 0
	end
	return sum * Config.RebirthMultiplier ^ rebirths
end

return PetLogic
