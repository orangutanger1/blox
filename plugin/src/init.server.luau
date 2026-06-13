-- blox dock panel: a thin window into a local blox CLI run (spec §3.2).
-- Poll + render only; all real logic lives CLI-side.
local HttpService = game:GetService("HttpService")
local Selection = game:GetService("Selection")
local TweenService = game:GetService("TweenService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local CollectionService = game:GetService("CollectionService")
local Ui = require(script.Ui)

local PROTOCOL = 2
local PORT = 35768 -- keep in sync with blox.config.json panel.port
local BASE = "http://127.0.0.1:" .. PORT .. "/api/v1"
local MAX_LINES = 200

local toolbar = plugin:CreateToolbar("blox")
local button = toolbar:CreateButton("blox panel", "Show the blox run panel", "")
local widgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 320, 480, 240, 320)
local widget = plugin:CreateDockWidgetPluginGui("BloxPanel", widgetInfo)
widget.Title = "blox"
button.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

local ui = Ui.build(widget)

local function request(method: string, path: string, body: { [string]: any }?): { [string]: any }?
	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url = BASE .. path,
			Method = method,
			Headers = { ["Content-Type"] = "application/json" },
			Body = if body then HttpService:JSONEncode(body) else nil,
		})
	end)
	if not ok then
		return nil -- server down, HttpService disabled, or request blocked
	end
	if not res.Success then
		return nil
	end
	local decoded
	ok, decoded = pcall(HttpService.JSONDecode, HttpService, res.Body)
	return if ok then decoded else nil
end

local logOrder = 0
local diffOrder = 0
local activeGateId: string? = nil
local activeResultGateId: string? = nil
local activeResultInstance: Instance? = nil

-- Find the generated instance. generate_mesh's "tag" is a CollectionService
-- tag on the inserted Model (live-probed: the instance itself is NAMED from
-- the prompt); wait_job_finished's resultName IS an instance name. Try the
-- tag registry first, then fall back to a name search under Workspace.
local function findByTag(tag: string?): Instance?
	if not tag then
		return nil
	end
	for _, inst in CollectionService:GetTagged(tag) do
		if inst:IsDescendantOf(workspace) then
			return inst
		end
	end
	return workspace:FindFirstChild(tag, true)
end

-- Clone into a WorldModel inside the ViewportFrame, camera fitted from the
-- clone's bounding box. Cleared and rebuilt per gate.
local function showPreview(viewport: ViewportFrame, instance: Instance?)
	viewport:ClearAllChildren()
	if not instance then
		return
	end
	local world = Instance.new("WorldModel")
	world.Parent = viewport
	local holder = Instance.new("Model")
	local clone = instance:Clone()
	clone.Parent = holder
	holder.Parent = world
	local cf, size = holder:GetBoundingBox()
	local camera = Instance.new("Camera")
	local dist = math.max(size.Magnitude, 1) * 1.5
	camera.CFrame = CFrame.lookAt(cf.Position + Vector3.new(dist, dist * 0.6, dist), cf.Position)
	camera.Parent = viewport
	viewport.CurrentCamera = camera
end

-- Select the real instance and tween the main camera to frame it.
local function frameInViewport(instance: Instance?)
	if not instance then
		return
	end
	Selection:Set({ instance })
	local cf: CFrame, size: Vector3
	if instance:IsA("Model") then
		cf, size = instance:GetBoundingBox()
	elseif instance:IsA("BasePart") then
		cf, size = instance.CFrame, instance.Size
	else
		return
	end
	local dist = math.max(size.Magnitude, 1) * 2
	local target = CFrame.lookAt(cf.Position + Vector3.new(dist, dist * 0.6, dist), cf.Position)
	local camera = workspace.CurrentCamera
	TweenService:Create(camera, TweenInfo.new(0.5, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { CFrame = target }):Play()
end

-- Reject disposition (P2 spec §2): stash, don't destroy. Runs BEFORE the
-- decision POST so the agent's "already set aside" message is true.
local function stashRejected(instance: Instance?)
	if not instance then
		return
	end
	local folder = ReplicatedStorage:FindFirstChild("_bloxRejected")
	if not folder then
		folder = Instance.new("Folder")
		folder.Name = "_bloxRejected"
		folder.Parent = ReplicatedStorage
	end
	instance.Parent = folder
	ChangeHistoryService:SetWaypoint("blox: stash rejected asset")
end

local function addLog(text: string)
	logOrder += 1
	if logOrder > MAX_LINES then
		local oldest = ui.log:FindFirstChild("Line" .. (logOrder - MAX_LINES))
		if oldest then
			oldest:Destroy()
		end
	end
	ui.addLine(ui.log, text, logOrder)
end

local function handleEvent(e: { [string]: any })
	if e.type == "run_started" then
		ui.status.Text = ("run %s — %s mode"):format(e.runId, e.mode)
		ui.status.TextColor3 = Color3.fromRGB(120, 200, 120)
		addLog("▶ " .. e.prompt)
	elseif e.type == "status" then
		ui.status.Text = ("running — turn %d"):format(e.turns)
	elseif e.type == "log" then
		addLog(e.text)
	elseif e.type == "file_diff" then
		diffOrder += 1
		ui.addLine(ui.diffs, ("%s  +%d −%d"):format(e.path, e.added, e.removed), diffOrder)
	elseif e.type == "gate_request" then
		activeGateId = e.gateId
		ui.gateText.Text = ("Approve %s?\n%s"):format(e.tool, e.inputSummary)
		ui.gate.Visible = true
	elseif e.type == "gate_resolved" then
		if e.gateId == activeGateId then
			ui.gate.Visible = false
			activeGateId = nil
		end
		addLog(("gate %s — %s (%s)"):format(e.gateId:sub(1, 8), e.decision, e.source))
	elseif e.type == "result_gate_request" then
		activeResultGateId = e.gateId
		activeResultInstance = findByTag(e.tag)
		local title = ("Keep this %s result?\n%s"):format(e.tool, e.inputSummary)
		if not activeResultInstance then
			title = title .. "\n(preview unavailable)"
		end
		ui.resultText.Text = title
		ui.feedbackBox.Text = ""
		showPreview(ui.preview, activeResultInstance)
		ui.resultGate.Visible = true
		frameInViewport(activeResultInstance)
	elseif e.type == "result_gate_resolved" then
		if e.gateId == activeResultGateId then
			ui.resultGate.Visible = false
			activeResultGateId = nil
			activeResultInstance = nil
		end
		addLog(("asset %s — %s (%s)"):format(e.gateId:sub(1, 8), e.decision, e.source))
	elseif e.type == "run_finished" then
		ui.status.Text = ("%s — %d turns, $%.4f"):format(e.status, e.turns, e.costUsd)
		ui.status.TextColor3 = if e.status == "success"
			then Color3.fromRGB(120, 200, 120)
			else Color3.fromRGB(220, 120, 120)
	end
end

local function decide(decision: string)
	if activeGateId then
		request("POST", "/gate/" .. activeGateId, { decision = decision })
		ui.gate.Visible = false
	end
end
ui.allowButton.MouseButton1Click:Connect(function()
	decide("allow")
end)
ui.denyButton.MouseButton1Click:Connect(function()
	decide("deny")
end)

local function decideResult(decision: string)
	if not activeResultGateId then
		return
	end
	local body: { [string]: any } = { decision = decision }
	if decision == "reject" then
		stashRejected(activeResultInstance)
		if ui.feedbackBox.Text ~= "" then
			body.feedback = ui.feedbackBox.Text
		end
	end
	request("POST", "/gate/" .. activeResultGateId, body)
	ui.resultGate.Visible = false
	activeResultGateId = nil
	activeResultInstance = nil
end
ui.approveButton.MouseButton1Click:Connect(function()
	decideResult("approve")
end)
ui.rejectButton.MouseButton1Click:Connect(function()
	decideResult("reject")
end)
ui.preview.InputBegan:Connect(function(io)
	if io.UserInputType == Enum.UserInputType.MouseButton1 then
		frameInViewport(activeResultInstance)
	end
end)

-- Poll loop. The server long-polls (~25s) so a healthy loop is mostly idle.
task.spawn(function()
	local cursor = 0
	local announced = false
	while true do
		if not widget.Enabled then
			task.wait(1)
			continue
		end
		if not announced then
			local info = request("GET", "/info")
			if info then
				announced = true
				if info.protocol ~= PROTOCOL then
					addLog("⚠ blox CLI speaks protocol " .. tostring(info.protocol) .. " — update this plugin")
				end
				ui.status.Text = "connected — " .. tostring(info.project)
				ui.status.TextColor3 = Color3.fromRGB(120, 200, 120)
			end
		end
		local data = request("GET", "/events?cursor=" .. cursor)
		if data then
			cursor = data.cursor
			for _, e in data.events do
				handleEvent(e)
			end
		else
			if announced then
				ui.status.Text = "disconnected — run blox to start"
				ui.status.TextColor3 = Color3.fromRGB(255, 170, 0)
			end
			announced = false
			task.wait(2)
		end
	end
end)
