-- Soak bot: blox metrics soak --bot bots/active.luau --archetype bot
-- Runs on the server during the playtest. Buys the cheapest affordable pet or
-- upgrade every second (the simulator's "cheapest" policy, so `soak:pace` can
-- compare real milestones to the "bot" archetype) and wanders between its base
-- and the market so the character is not idle.
return function(player: Player, deadline: number)
	local ReplicatedStorage = game:GetService("ReplicatedStorage")
	local ServerStorage = game:GetService("ServerStorage")
	local Economy = require(ReplicatedStorage:WaitForChild("Kit"):WaitForChild("Economy"))
	local Tunables = require(ReplicatedStorage:WaitForChild("Design"):WaitForChild("Tunables"))
	local econ = Economy.new(Tunables)
	local api = ServerStorage:WaitForChild("KitApi", 10)
	if not api then
		error("bot: ServerStorage.KitApi missing (did the server Bootstrap start KitService?)")
	end

	local function cheapestAffordable(s)
		local best, bestCost = nil, math.huge
		local refs = econ:itemRefs()
		if econ.items.rebirth then
			table.insert(refs, "rebirth")
		end
		for _, ref in refs do
			if econ:available(s, ref) then
				local price, res = econ:cost(s, ref)
				if (s.bal[res] or 0) >= price and price < bestCost then
					best, bestCost = ref, price
				end
			end
		end
		return best
	end

	local home = true
	local legStarted = -math.huge
	while os.clock() < deadline do
		local hum = player.Character and player.Character:FindFirstChildOfClass("Humanoid")
		local plot = api:Invoke("plot", player)
		if hum and plot and os.clock() - legStarted > 8 then
			hum:MoveTo(home and Vector3.new(0, 3, 0) or plot.PrimaryPart.Position + Vector3.new(0, 3, 0))
			home = not home
			legStarted = os.clock()
		end
		for _ = 1, 50 do
			local s = api:Invoke("getState", player)
			local ref = s and cheapestAffordable(s)
			if not ref then
				break
			end
			local ok = ref == "rebirth" and api:Invoke("rebirth", player)
				or api:Invoke("purchase", player, ref)
			if not ok then
				break
			end
		end
		task.wait(1)
	end
end
