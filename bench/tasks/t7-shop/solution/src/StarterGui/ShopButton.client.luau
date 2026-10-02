local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local playerGui = Players.LocalPlayer:WaitForChild("PlayerGui")
local gui
repeat
	for _, c in playerGui:GetChildren() do if c.Name == "HUD" and c:IsA("ScreenGui") then gui = c end end
	if not gui then task.wait(0.1) end
until gui
local button = Instance.new("TextButton")
button.Name = "BuySpeedButton"
button.Position = UDim2.new(0, 16, 0, 64)
button.Size = UDim2.new(0, 200, 0, 36)
button.Text = "Buy speed (10)"
button.TextScaled = true
button.Parent = gui

button.Activated:Connect(function()
	ReplicatedStorage:WaitForChild("BuySpeed"):InvokeServer()
end)
