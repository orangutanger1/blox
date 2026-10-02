local ReplicatedStorage = game:GetService("ReplicatedStorage")
local PetLogic = require(ReplicatedStorage.PetLogic)

local passed = 0
local failed = 0

local function expect(name, actual, expected)
	local ok = actual == expected
	if ok then
		passed = passed + 1
		print("[TEST PASS] " .. name .. " => " .. tostring(actual))
	else
		failed = failed + 1
		print("[TEST FAIL] " .. name .. " => expected " .. tostring(expected) .. " but got " .. tostring(actual))
	end
end

-- rollRarity boundary tests
expect("rollRarity(0.0)", PetLogic.rollRarity(0.0), "Common")
expect("rollRarity(0.69)", PetLogic.rollRarity(0.69), "Common")
expect("rollRarity(0.70)", PetLogic.rollRarity(0.70), "Rare")
expect("rollRarity(0.94)", PetLogic.rollRarity(0.94), "Rare")
expect("rollRarity(0.95)", PetLogic.rollRarity(0.95), "Legendary")
expect("rollRarity(0.99)", PetLogic.rollRarity(0.99), "Legendary")

-- incomePerSecond tests
expect("incomePerSecond({Common,Common,Rare}, 0)", PetLogic.incomePerSecond({"Common", "Common", "Rare"}, 0), 7)
expect("incomePerSecond({Legendary}, 2)", PetLogic.incomePerSecond({"Legendary"}, 2), 56.25)
expect("incomePerSecond({}, 0)", PetLogic.incomePerSecond({}, 0), 0)

-- Summary
print(string.format("=== TESTS COMPLETE: %d passed, %d failed ===", passed, failed))
if failed > 0 then
	print("!!! SOME TESTS FAILED !!!")
end