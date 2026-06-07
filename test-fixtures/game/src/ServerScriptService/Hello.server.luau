local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Greeter = require(ReplicatedStorage.Greeter)

print(Greeter.greet("world"))
