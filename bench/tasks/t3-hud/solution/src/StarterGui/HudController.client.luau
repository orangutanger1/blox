local Players = game:GetService("Players")
local player = Players.LocalPlayer

local gui = Instance.new("ScreenGui")
gui.Name = "HUD"
gui.ResetOnSpawn = false

local label = Instance.new("TextLabel")
label.Name = "CoinsLabel"
label.AnchorPoint = Vector2.new(0, 0)
label.Position = UDim2.new(0, 16, 0, 16)
label.Size = UDim2.new(0, 200, 0, 40)
label.BackgroundColor3 = Color3.fromRGB(20, 20, 30)
label.BackgroundTransparency = 0.3
label.TextColor3 = Color3.fromRGB(255, 220, 80)
label.TextScaled = true
label.Font = Enum.Font.GothamBold
label.Text = "Coins: 0"
label.Parent = gui
gui.Parent = player:WaitForChild("PlayerGui")

local coins = player:WaitForChild("leaderstats"):WaitForChild("Coins")
local function refresh() label.Text = "Coins: " .. coins.Value end
coins.Changed:Connect(refresh)
refresh()
