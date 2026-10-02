local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local PetConfig = require(ReplicatedStorage.PetConfig)
local PetLogic = require(ReplicatedStorage.PetLogic)

local HatchEgg = ReplicatedStorage:FindFirstChild("HatchEgg")
local Rebirth = ReplicatedStorage:FindFirstChild("Rebirth")

-- Helper: get pet names from a player's Pets folder
local function getPetNames(petsFolder)
	local names = {}
	for _, child in ipairs(petsFolder:GetChildren()) do
		if child:IsA("StringValue") then
			table.insert(names, child.Value)
		end
	end
	return names
end

-- Helper: set up a player's data
local function setupPlayer(player)
	-- leaderstats folder
	local leaderstats = Instance.new("Folder")
	leaderstats.Name = "leaderstats"
	leaderstats.Parent = player

	local cash = Instance.new("IntValue")
	cash.Name = "Cash"
	cash.Value = PetConfig.StartCash
	cash.Parent = leaderstats

	local rebirths = Instance.new("IntValue")
	rebirths.Name = "Rebirths"
	rebirths.Value = 0
	rebirths.Parent = leaderstats

	-- Pets folder under the player
	local pets = Instance.new("Folder")
	pets.Name = "Pets"
	pets.Parent = player
end

-- Helper: perform a hatch for a player (shared by RemoteFunction and ProximityPrompt)
local function doHatch(player)
	local leaderstats = player:FindFirstChild("leaderstats")
	if not leaderstats then return nil end

	local cash = leaderstats:FindFirstChild("Cash")
	local rebirths = leaderstats:FindFirstChild("Rebirths")
	if not cash or not rebirths then return nil end

	local pets = player:FindFirstChild("Pets")
	if not pets then return nil end

	-- Check conditions
	if #pets:GetChildren() >= PetConfig.MaxPets then
		return nil
	end
	if cash.Value < PetConfig.EggCost then
		return nil
	end

	-- Deduct cost
	cash.Value = cash.Value - PetConfig.EggCost

	-- Roll rarity with server-side randomness
	local r = math.random()
	local rarityName = PetLogic.rollRarity(r)

	-- Add pet as StringValue
	local petValue = Instance.new("StringValue")
	petValue.Name = "Pet_" .. tostring(tick())
	petValue.Value = rarityName
	petValue.Parent = pets

	return rarityName
end

-- HatchEgg RemoteFunction handler
HatchEgg.OnServerInvoke = function(player)
	-- Ignore any arguments; just use player
	return doHatch(player)
end

-- Rebirth RemoteFunction handler
Rebirth.OnServerInvoke = function(player)
	local leaderstats = player:FindFirstChild("leaderstats")
	if not leaderstats then return false end

	local cash = leaderstats:FindFirstChild("Cash")
	local rebirths = leaderstats:FindFirstChild("Rebirths")
	if not cash or not rebirths then return false end

	local pets = player:FindFirstChild("Pets")
	if not pets then return false end

	if cash.Value >= PetConfig.RebirthCost then
		cash.Value = PetConfig.StartCash
		-- Remove all pets
		for _, child in ipairs(pets:GetChildren()) do
			if child:IsA("StringValue") then
				child.Parent = nil
			end
		end
		rebirths.Value = rebirths.Value + 1
		return true
	end

	return false
end

-- ProximityPrompt on EggStation
local eggStation = workspace:FindFirstChild("EggStation")
if eggStation then
	local prompt = eggStation:FindFirstChildOfClass("ProximityPrompt")
	if prompt then
		prompt.Triggered:Connect(function(player)
			local result = doHatch(player)
			if result then
				print(player.Name .. " hatched a " .. result .. " pet!")
			end
		end)
	end
end

-- PlayerAdded for new players
Players.PlayerAdded:Connect(setupPlayer)

-- Handle players already in-game
for _, player in ipairs(Players:GetPlayers()) do
	setupPlayer(player)
end

-- Income loop: once per second
while true do
	task.wait(1)
	for _, player in ipairs(Players:GetPlayers()) do
		local leaderstats = player:FindFirstChild("leaderstats")
		if leaderstats then
			local cash = leaderstats:FindFirstChild("Cash")
			local rebirths = leaderstats:FindFirstChild("Rebirths")
			local pets = player:FindFirstChild("Pets")

			if cash and rebirths and pets then
				local petNames = getPetNames(pets)
				local income = math.floor(PetLogic.incomePerSecond(petNames, rebirths.Value))
				if income > 0 then
					cash.Value = cash.Value + income
				end
			end
		end
	end
end