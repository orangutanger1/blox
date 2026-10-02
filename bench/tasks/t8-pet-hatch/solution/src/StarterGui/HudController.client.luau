local Players = game:GetService("Players")
local RS = game:GetService("ReplicatedStorage")
local player = Players.LocalPlayer

local gui = Instance.new("ScreenGui")
gui.Name = "HUD"
gui.ResetOnSpawn = false
gui.ScreenInsets = Enum.ScreenInsets.CoreUISafeInsets

local label = Instance.new("TextLabel")
label.Name = "CashLabel"
label.Size = UDim2.new(0.3, 0, 0.08, 0)
label.Position = UDim2.new(0.35, 0, 0.02, 0)
label.BackgroundTransparency = 0.3
label.TextScaled = true
label.Parent = gui

local function button(name: string, text: string, y: number): TextButton
	local b = Instance.new("TextButton")
	b.Name = name
	b.Text = text
	b.Size = UDim2.new(0.18, 0, 0.09, 0)
	b.Position = UDim2.new(0.02, 0, y, 0)
	b.TextScaled = true
	local min = Instance.new("UISizeConstraint")
	min.MinSize = Vector2.new(120, 48)
	min.Parent = b
	b.Parent = gui
	return b
end

local hatchButton = button("HatchButton", "Hatch Egg (50)", 0.35)
local rebirthButton = button("RebirthButton", "Rebirth (1000)", 0.47)

gui.Parent = player:WaitForChild("PlayerGui")

local cash = player:WaitForChild("leaderstats"):WaitForChild("Cash")
local function refresh() label.Text = "Cash: " .. cash.Value end
cash.Changed:Connect(refresh)
refresh()

hatchButton.Activated:Connect(function() RS:WaitForChild("HatchEgg"):InvokeServer() end)
rebirthButton.Activated:Connect(function() RS:WaitForChild("Rebirth"):InvokeServer() end)
