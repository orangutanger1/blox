-- Soak bot: blox metrics soak --bot bots/active.luau --archetype bot
-- Runs on the server during the playtest. Walks the track back and forth
-- (actions only accrue while moving) and buys the cheapest affordable item
-- until nothing is affordable, every second — the simulator's "cheapest"
-- policy, so `soak:pace` can compare real milestones to the "bot" archetype.
return function(player: Player, deadline: number)
	local ReplicatedStorage = game:GetService("ReplicatedStorage")
	local ServerStorage = game:GetService("ServerStorage")
	local Economy = require(ReplicatedStorage:WaitForChild("Kit"):WaitForChild("Economy"))
	local Tunables = require(ReplicatedStorage:WaitForChild("Design"):WaitForChild("Tunables"))
	local econ = Economy.new(Tunables)
	local api = ServerStorage:WaitForChild("KitApi", 10)
	if not api then
		error("bot: ServerStorage.KitApi missing (is KitMain.server.luau running?)")
	end
	local track = workspace:FindFirstChild("Track")
	local run = track and track:FindFirstChild("Run")
	local near, far
	if run and run:IsA("BasePart") then
		local half = run.Size.Z / 2 - 4
		near = run.Position + Vector3.new(0, 3, half)
		far = run.Position + Vector3.new(0, 3, -half)
	else
		near, far = Vector3.new(0, 3, 0), Vector3.new(0, 3, -200)
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

	local outbound = true
	local legStarted = 0
	while os.clock() < deadline do
		local hum = player.Character and player.Character:FindFirstChildOfClass("Humanoid")
		if hum and os.clock() - legStarted > 6 then
			hum:MoveTo(outbound and far or near)
			outbound = not outbound
			legStarted = os.clock()
		end
		for _ = 1, 50 do
			local s = api:Invoke("getState", player)
			local ref = s and cheapestAffordable(s)
			if not ref or not api:Invoke("purchase", player, ref) then
				break
			end
		end
		task.wait(1)
	end
end
