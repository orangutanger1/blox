local Players = game:GetService("Players")
local RS = game:GetService("ReplicatedStorage")

local Config = require(RS:WaitForChild("PetConfig"))
local PetLogic = require(RS:WaitForChild("PetLogic"))

local rng = Random.new()

local function petNames(player: Player): { string }
	local names = {}
	local pets = player:FindFirstChild("Pets")
	if pets then
		for _, v in pets:GetChildren() do
			if v:IsA("StringValue") then
				table.insert(names, v.Value)
			end
		end
	end
	return names
end

local function setup(player: Player)
	local ls = Instance.new("Folder")
	ls.Name = "leaderstats"
	local cash = Instance.new("IntValue")
	cash.Name = "Cash"
	cash.Value = Config.StartCash
	cash.Parent = ls
	local rebirths = Instance.new("IntValue")
	rebirths.Name = "Rebirths"
	rebirths.Parent = ls
	ls.Parent = player
	local pets = Instance.new("Folder")
	pets.Name = "Pets"
	pets.Parent = player
end

local function hatch(player: Player): string?
	local ls = player:FindFirstChild("leaderstats")
	local pets = player:FindFirstChild("Pets")
	if not ls or not pets then return nil end
	if #pets:GetChildren() >= Config.MaxPets or ls.Cash.Value < Config.EggCost then
		return nil
	end
	ls.Cash.Value -= Config.EggCost
	local rarity = PetLogic.rollRarity(rng:NextNumber())
	local pet = Instance.new("StringValue")
	pet.Name = "Pet"
	pet.Value = rarity
	pet.Parent = pets
	return rarity
end

local function rebirth(player: Player): boolean
	local ls = player:FindFirstChild("leaderstats")
	local pets = player:FindFirstChild("Pets")
	if not ls or not pets or ls.Cash.Value < Config.RebirthCost then
		return false
	end
	ls.Cash.Value = Config.StartCash
	pets:ClearAllChildren()
	ls.Rebirths.Value += 1
	return true
end

local hatchRemote = Instance.new("RemoteFunction")
hatchRemote.Name = "HatchEgg"
hatchRemote.OnServerInvoke = function(player) return hatch(player) end -- arguments ignored
hatchRemote.Parent = RS

local rebirthRemote = Instance.new("RemoteFunction")
rebirthRemote.Name = "Rebirth"
rebirthRemote.OnServerInvoke = function(player) return rebirth(player) end
rebirthRemote.Parent = RS

Players.PlayerAdded:Connect(setup)
for _, p in Players:GetPlayers() do
	if not p:FindFirstChild("leaderstats") then setup(p) end
end

-- Egg station next to the spawn.
local station = Instance.new("Part")
station.Name = "EggStation"
station.Anchored = true
station.Size = Vector3.new(6, 6, 6)
station.Shape = Enum.PartType.Ball
station.Color = Color3.fromRGB(255, 230, 170)
station.Position = Vector3.new(0, 3, -14)
local prompt = Instance.new("ProximityPrompt")
prompt.ActionText = "Hatch Egg"
prompt.ObjectText = Config.EggCost .. " Cash"
prompt.Parent = station
prompt.Triggered:Connect(hatch)
station.Parent = workspace

-- Passive income.
task.spawn(function()
	while true do
		task.wait(1)
		for _, player in Players:GetPlayers() do
			local ls = player:FindFirstChild("leaderstats")
			if ls then
				ls.Cash.Value += math.floor(PetLogic.incomePerSecond(petNames(player), ls.Rebirths.Value))
			end
		end
	end
end)
