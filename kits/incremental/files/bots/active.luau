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

	-- Turn around when a leg ends or the character stalls (a closed gate wall):
	-- actions only accrue while moving, and speed raises WalkSpeed, so fixed-
	-- length legs would spend most of their time pressed against the wall.
	local outbound = true
	local legStarted = -math.huge
	local stalledSince = nil
	local lastBuy = 0
	while os.clock() < deadline do
		local hum = player.Character and player.Character:FindFirstChildOfClass("Humanoid")
		local root = hum and hum.RootPart
		if hum and root then
			local v = root.AssemblyLinearVelocity
			local moving = Vector3.new(v.X, 0, v.Z).Magnitude > 2
			stalledSince = (moving and nil) or stalledSince or os.clock()
			local stalled = stalledSince ~= nil and os.clock() - stalledSince > 0.4
			if os.clock() - legStarted > 6 or (stalled and os.clock() - legStarted > 0.6) then
				hum:MoveTo(outbound and far or near)
				outbound = not outbound
				legStarted = os.clock()
				stalledSince = nil
			end
		end
		if os.clock() - lastBuy >= 1 then
			lastBuy = os.clock()
			for _ = 1, 50 do
				local s = api:Invoke("getState", player)
				local ref = s and cheapestAffordable(s)
				if not ref or not api:Invoke("purchase", player, ref) then
					break
				end
			end
		end
		task.wait(0.1)
	end
end
