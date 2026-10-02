--!strict

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local packages = ReplicatedStorage:WaitForChild("Packages")
packages:WaitForChild("Trove")
ReplicatedStorage:WaitForChild("ReplicaShared")
ReplicatedStorage:WaitForChild("ReplicaClient")

for _, name in { "Registry", "Controllers", "Components" } do
	script.Parent:WaitForChild(name)
end

local Lifecycle = require(ReplicatedStorage:WaitForChild("Lifecycle"))
local controllers = require(script.Parent.Registry)
local runtime = Lifecycle.new(controllers)

script.Destroying:Connect(function()
	runtime:Destroy()
end)

runtime:Start()
script:SetAttribute("Ready", true)
