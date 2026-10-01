-- Stepping on the pressure plate opens the door for 3 seconds.
local Players = game:GetService("Players")

local door = workspace:WaitForChild("Door")
local plate = workspace:WaitForChild("PressurePlate")

local OPEN_TIME = 3
local opened = false

local function setOpen(open)
	door.CanCollide = not open
	door.Transparency = open and 0.5 or 0
end

plate.Touched:Connect(function(hit)
	if opened then return end
	if not Players:GetPlayerFromCharacter(hit.Parent) then return end
	opened = true
	setOpen(true)
	task.wait(OPEN_TIME)
	setOpen(false)
	opened = false
end)
