local PetConfig = require(game:GetService("ReplicatedStorage").PetConfig)

local PetLogic = {}

function PetLogic.rollRarity(r)
	local rarities = PetConfig.Rarities
	local total = 0
	for _, rarity in ipairs(rarities) do
		total = total + rarity.Weight
	end

	local cumulative = 0
	for _, rarity in ipairs(rarities) do
		cumulative = cumulative + rarity.Weight
		if r < (cumulative / total) then
			return rarity.Name
		end
	end

	-- Fallback: return last rarity (Legendary)
	return rarities[#rarities].Name
end

function PetLogic.incomePerSecond(petNames, rebirths)
	local rarityMap = {}
	for _, rarity in ipairs(PetConfig.Rarities) do
		rarityMap[rarity.Name] = rarity.Income
	end

	local sum = 0
	for _, name in ipairs(petNames) do
		local income = rarityMap[name]
		if income then
			sum = sum + income
		end
	end

	return sum * (PetConfig.RebirthMultiplier ^ rebirths)
end

return PetLogic