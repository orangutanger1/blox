local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local player = Players.LocalPlayer
local hud = script.Parent
local cashLabel = hud:WaitForChild("CashLabel")
local hatchButton = hud:WaitForChild("HatchButton")
local rebirthButton = hud:WaitForChild("RebirthButton")
local statusLabel = hud:WaitForChild("StatusLabel")

local HatchEgg = ReplicatedStorage:WaitForChild("HatchEgg")
local Rebirth = ReplicatedStorage:WaitForChild("Rebirth")

-- Hide status after a few seconds
local function showStatus(msg)
	statusLabel.Text = msg
	task.delay(3, function()
		if statusLabel.Text == msg then
			statusLabel.Text = ""
		end
	end)
end

-- Live update loop for cash and rebirths
local function updateLoop()
	while true do
		local leaderstats = player:FindFirstChild("leaderstats")
		if leaderstats then
			local cash = leaderstats:FindFirstChild("Cash")
			local rebirths = leaderstats:FindFirstChild("Rebirths")
			if cash then
				local rebirthText = ""
				if rebirths and rebirths.Value > 0 then
					rebirthText = " (Rebirths: " .. rebirths.Value .. ")"
				end
				cashLabel.Text = "Cash: " .. cash.Value .. rebirthText
			end

			-- Update rebirth button text based on affordability
			if cash then
				if cash.Value >= 1000 then
					rebirthButton.BackgroundColor3 = Color3.fromRGB(100, 220, 100)
				else
					rebirthButton.BackgroundColor3 = Color3.fromRGB(180, 60, 180)
				end
			end
		end
		task.wait(0.5)
	end
end

-- Hatch button
coroutine.wrap(function()
	updateLoop()
end)()

hatchButton.Activated:Connect(function()
	local result = HatchEgg:InvokeServer()
	if result then
		showStatus("Hatched a " .. result .. " pet!")
	else
		showStatus("Can't hatch: not enough cash or pets full!")
	end
end)

rebirthButton.Activated:Connect(function()
	local result = Rebirth:InvokeServer()
	if result then
		showStatus("Rebirth successful! All pets cleared, multiplier increased!")
	else
		showStatus("Need at least $1000 to rebirth!")
	end
end)