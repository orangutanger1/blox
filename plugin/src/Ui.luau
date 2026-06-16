-- Builds the dock widget UI and returns references. No logic lives here.
local Ui = {}

local function label(parent: Instance, name: string, order: number): TextLabel
	local l = Instance.new("TextLabel")
	l.Name = name
	l.LayoutOrder = order
	l.Size = UDim2.new(1, -8, 0, 18)
	l.BackgroundTransparency = 1
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.TextColor3 = Color3.fromRGB(204, 204, 204)
	l.TextSize = 14
	l.Font = Enum.Font.Code
	l.TextTruncate = Enum.TextTruncate.AtEnd
	l.Parent = parent
	return l
end

-- Like label() but a read-only multiline TextBox, so the text can be selected
-- and copied (Ctrl+C). Used for the gate/result prompt text.
local function selectableLabel(parent: Instance, name: string, order: number): TextBox
	local b = Instance.new("TextBox")
	b.Name = name
	b.LayoutOrder = order
	b.Size = UDim2.new(1, -8, 0, 18)
	b.BackgroundTransparency = 1
	b.TextXAlignment = Enum.TextXAlignment.Left
	b.TextYAlignment = Enum.TextYAlignment.Top
	b.TextColor3 = Color3.fromRGB(204, 204, 204)
	b.TextSize = 14
	b.Font = Enum.Font.Code
	b.MultiLine = true
	b.TextEditable = false
	b.ClearTextOnFocus = false
	b.TextWrapped = true
	b.Text = ""
	b.Parent = parent
	return b
end

-- Rounded corners on a frame/button/box.
local function corner(inst: Instance, radius: number)
	local c = Instance.new("UICorner")
	c.CornerRadius = UDim.new(0, radius)
	c.Parent = inst
end

-- Thin border to lift a card off the background.
local function stroke(inst: Instance, color: Color3)
	local s = Instance.new("UIStroke")
	s.Color = color
	s.Thickness = 1
	s.Transparency = 0.4
	s.Parent = inst
end

function Ui.build(widget: DockWidgetPluginGui)
	local root = Instance.new("Frame")
	root.Size = UDim2.fromScale(1, 1)
	root.BackgroundColor3 = Color3.fromRGB(28, 29, 33)
	root.Parent = widget

	local rootPad = Instance.new("UIPadding")
	rootPad.PaddingLeft = UDim.new(0, 8)
	rootPad.PaddingRight = UDim.new(0, 8)
	rootPad.PaddingTop = UDim.new(0, 8)
	rootPad.PaddingBottom = UDim.new(0, 8)
	rootPad.Parent = root

	local layout = Instance.new("UIListLayout")
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Padding = UDim.new(0, 6)
	layout.Parent = root

	local status = label(root, "Status", 1)
	status.Size = UDim2.new(1, -8, 0, 22)
	status.Text = "disconnected — run blox to start"
	status.TextSize = 15
	status.TextColor3 = Color3.fromRGB(255, 170, 0)

	-- Controls card: model picker + prompt + launch/cancel (protocol v4).
	local controls = Instance.new("Frame")
	controls.Name = "Controls"
	controls.LayoutOrder = 1.5
	controls.Size = UDim2.new(1, -8, 0, 100)
	controls.BackgroundColor3 = Color3.fromRGB(34, 38, 48)
	controls.Parent = root
	corner(controls, 6)
	stroke(controls, Color3.fromRGB(60, 66, 80))

	local modelButton = Instance.new("TextButton")
	modelButton.Name = "Model"
	modelButton.Text = "model: (loading…)"
	modelButton.Position = UDim2.fromOffset(6, 6)
	modelButton.Size = UDim2.new(1, -12, 0, 22)
	modelButton.BackgroundColor3 = Color3.fromRGB(48, 52, 64)
	modelButton.TextColor3 = Color3.fromRGB(220, 220, 220)
	modelButton.TextXAlignment = Enum.TextXAlignment.Left
	modelButton.Font = Enum.Font.Code
	modelButton.TextSize = 14
	modelButton.Parent = controls
	corner(modelButton, 4)
	local modelPad = Instance.new("UIPadding")
	modelPad.PaddingLeft = UDim.new(0, 6)
	modelPad.Parent = modelButton

	local promptBox = Instance.new("TextBox")
	promptBox.Name = "Prompt"
	promptBox.PlaceholderText = "what should blox build?"
	promptBox.Text = ""
	promptBox.Position = UDim2.fromOffset(6, 32)
	promptBox.Size = UDim2.new(1, -12, 0, 32)
	promptBox.TextWrapped = true
	promptBox.ClearTextOnFocus = false
	promptBox.BackgroundColor3 = Color3.fromRGB(24, 25, 29)
	promptBox.PlaceholderColor3 = Color3.fromRGB(130, 132, 138)
	promptBox.TextColor3 = Color3.fromRGB(225, 227, 231)
	promptBox.TextSize = 14
	promptBox.Font = Enum.Font.Code
	promptBox.TextXAlignment = Enum.TextXAlignment.Left
	promptBox.TextYAlignment = Enum.TextYAlignment.Top
	promptBox.Parent = controls
	corner(promptBox, 4)
	stroke(promptBox, Color3.fromRGB(60, 66, 80))
	local promptPad = Instance.new("UIPadding")
	promptPad.PaddingLeft = UDim.new(0, 6)
	promptPad.PaddingTop = UDim.new(0, 3)
	promptPad.Parent = promptBox

	local launchButton = Instance.new("TextButton")
	launchButton.Name = "Launch"
	launchButton.Text = "▶ Launch"
	launchButton.Position = UDim2.new(0, 6, 1, -30)
	launchButton.Size = UDim2.fromOffset(104, 26)
	launchButton.BackgroundColor3 = Color3.fromRGB(40, 130, 64)
	launchButton.TextColor3 = Color3.fromRGB(255, 255, 255)
	launchButton.Font = Enum.Font.GothamMedium
	launchButton.TextSize = 14
	launchButton.Parent = controls
	corner(launchButton, 5)

	local cancelButton = Instance.new("TextButton")
	cancelButton.Name = "Cancel"
	cancelButton.Text = "Cancel"
	cancelButton.Position = UDim2.new(0, 118, 1, -30)
	cancelButton.Size = UDim2.fromOffset(82, 26)
	cancelButton.BackgroundColor3 = Color3.fromRGB(70, 64, 44)
	cancelButton.TextColor3 = Color3.fromRGB(235, 230, 220)
	cancelButton.Font = Enum.Font.GothamMedium
	cancelButton.TextSize = 14
	cancelButton.Parent = controls
	corner(cancelButton, 5)

	-- Dropdown list: overlays the controls below the model button when open.
	-- High ZIndex so it renders over the prompt box; init.server.luau fills it
	-- with one button per model and toggles Visible.
	local modelList = Instance.new("ScrollingFrame")
	modelList.Name = "ModelList"
	modelList.Visible = false
	modelList.Position = UDim2.fromOffset(6, 30)
	modelList.Size = UDim2.new(1, -12, 0, 88)
	modelList.BackgroundColor3 = Color3.fromRGB(40, 44, 54)
	modelList.BorderSizePixel = 0
	modelList.CanvasSize = UDim2.new()
	modelList.AutomaticCanvasSize = Enum.AutomaticSize.Y
	modelList.ScrollBarThickness = 4
	modelList.ZIndex = 10
	modelList.Parent = controls
	corner(modelList, 4)
	stroke(modelList, Color3.fromRGB(70, 76, 92))
	local modelListLayout = Instance.new("UIListLayout")
	modelListLayout.SortOrder = Enum.SortOrder.LayoutOrder
	modelListLayout.Parent = modelList

	-- Image request card: hidden until an image_request arrives (P3).
	local imageGate = Instance.new("Frame")
	imageGate.Name = "ImageGate"
	imageGate.LayoutOrder = 2
	imageGate.Size = UDim2.new(1, -8, 0, 56)
	imageGate.BackgroundColor3 = Color3.fromRGB(30, 40, 60)
	imageGate.Visible = false
	imageGate.Parent = root
	corner(imageGate, 6)
	stroke(imageGate, Color3.fromRGB(60, 80, 110))

	local imageStatus = label(imageGate, "ImageStatus", 1)
	imageStatus.Position = UDim2.fromOffset(4, 4)
	imageStatus.Size = UDim2.new(1, -8, 0, 18)
	imageStatus.Text = "blox wants a reference image"

	local imageButton = Instance.new("TextButton")
	imageButton.Name = "PickImage"
	imageButton.Text = "Pick image"
	imageButton.Position = UDim2.new(0, 4, 1, -28)
	imageButton.Size = UDim2.fromOffset(120, 24)
	imageButton.BackgroundColor3 = Color3.fromRGB(40, 90, 140)
	imageButton.TextColor3 = Color3.fromRGB(255, 255, 255)
	imageButton.Font = Enum.Font.GothamMedium
	imageButton.TextSize = 14
	imageButton.Parent = imageGate
	corner(imageButton, 5)

	-- Gate card: hidden until a gate_request arrives.
	local gate = Instance.new("Frame")
	gate.Name = "Gate"
	gate.LayoutOrder = 3
	gate.Size = UDim2.new(1, -8, 0, 76)
	gate.BackgroundColor3 = Color3.fromRGB(60, 50, 20)
	gate.Visible = false
	gate.Parent = root
	corner(gate, 6)
	stroke(gate, Color3.fromRGB(110, 92, 40))

	local gateText = selectableLabel(gate, "GateText", 1)
	gateText.Position = UDim2.fromOffset(4, 4)
	gateText.Size = UDim2.new(1, -8, 0, 36)
	gateText.TextWrapped = true
	gateText.TextTruncate = Enum.TextTruncate.None

	local function button(name: string, x: number, color: Color3): TextButton
		local b = Instance.new("TextButton")
		b.Name = name
		b.Text = name
		b.Position = UDim2.new(0, x, 1, -30)
		b.Size = UDim2.fromOffset(80, 24)
		b.BackgroundColor3 = color
		b.TextColor3 = Color3.fromRGB(255, 255, 255)
		b.Font = Enum.Font.GothamMedium
		b.TextSize = 14
		b.Parent = gate
		corner(b, 5)
		return b
	end
	local allow = button("Allow", 4, Color3.fromRGB(40, 120, 40))
	local deny = button("Deny", 92, Color3.fromRGB(140, 40, 40))

	-- Diff list + log each render into ONE read-only multiline TextBox inside a
	-- scrolling frame, so a selection spans lines (highlight + Ctrl+C across many
	-- rows, not one row at a time). Long lines wrap instead of truncating.
	local function scroller(name: string, order: number, heightScale: number): TextBox
		local s = Instance.new("ScrollingFrame")
		s.Name = name
		s.LayoutOrder = order
		s.Size = UDim2.new(1, -8, heightScale, -8)
		s.CanvasSize = UDim2.new()
		s.AutomaticCanvasSize = Enum.AutomaticSize.Y
		s.BackgroundColor3 = Color3.fromRGB(22, 23, 26)
		s.BorderSizePixel = 0
		s.ScrollBarThickness = 6
		s.Parent = root
		corner(s, 5)
		local sp = Instance.new("UIPadding")
		sp.PaddingLeft = UDim.new(0, 6)
		sp.PaddingRight = UDim.new(0, 6)
		sp.PaddingTop = UDim.new(0, 4)
		sp.PaddingBottom = UDim.new(0, 4)
		sp.Parent = s
		local box = Instance.new("TextBox")
		box.Name = "Text"
		box.Size = UDim2.new(1, 0, 0, 0)
		box.AutomaticSize = Enum.AutomaticSize.Y
		box.BackgroundTransparency = 1
		box.MultiLine = true
		box.TextEditable = false
		box.ClearTextOnFocus = false
		box.TextWrapped = true
		box.TextXAlignment = Enum.TextXAlignment.Left
		box.TextYAlignment = Enum.TextYAlignment.Top
		box.TextColor3 = Color3.fromRGB(204, 204, 204)
		box.TextSize = 14
		box.Font = Enum.Font.Code
		box.Text = ""
		box.Parent = s
		return box
	end
	-- Result card: hidden until a result_gate_request arrives (P2 spec §5).
	local result = Instance.new("Frame")
	result.Name = "ResultGate"
	result.LayoutOrder = 4
	result.Size = UDim2.new(1, -8, 0, 210)
	result.BackgroundColor3 = Color3.fromRGB(30, 50, 60)
	result.Visible = false
	result.Parent = root
	corner(result, 6)
	stroke(result, Color3.fromRGB(55, 90, 110))

	local resultText = selectableLabel(result, "ResultText", 1)
	resultText.Position = UDim2.fromOffset(4, 4)
	resultText.Size = UDim2.new(1, -8, 0, 36)
	resultText.TextWrapped = true
	resultText.TextTruncate = Enum.TextTruncate.None

	local viewport = Instance.new("ViewportFrame")
	viewport.Name = "Preview"
	viewport.Position = UDim2.fromOffset(4, 44)
	viewport.Size = UDim2.new(1, -8, 0, 100)
	viewport.BackgroundColor3 = Color3.fromRGB(20, 20, 20)
	viewport.Parent = result
	corner(viewport, 5)

	local feedbackBox = Instance.new("TextBox")
	feedbackBox.Name = "Feedback"
	feedbackBox.PlaceholderText = "optional feedback for the agent (sent on Reject)"
	feedbackBox.Text = ""
	feedbackBox.Position = UDim2.new(0, 4, 1, -62)
	feedbackBox.Size = UDim2.new(1, -8, 0, 24)
	feedbackBox.BackgroundColor3 = Color3.fromRGB(24, 25, 29)
	feedbackBox.PlaceholderColor3 = Color3.fromRGB(130, 132, 138)
	feedbackBox.TextColor3 = Color3.fromRGB(225, 227, 231)
	feedbackBox.TextXAlignment = Enum.TextXAlignment.Left
	feedbackBox.ClearTextOnFocus = false
	feedbackBox.Parent = result
	corner(feedbackBox, 4)
	local fbPad = Instance.new("UIPadding")
	fbPad.PaddingLeft = UDim.new(0, 6)
	fbPad.Parent = feedbackBox

	local function resultButton(name: string, x: number, color: Color3): TextButton
		local b = Instance.new("TextButton")
		b.Name = name
		b.Text = name
		b.Position = UDim2.new(0, x, 1, -30)
		b.Size = UDim2.fromOffset(80, 24)
		b.BackgroundColor3 = color
		b.TextColor3 = Color3.fromRGB(255, 255, 255)
		b.Font = Enum.Font.GothamMedium
		b.TextSize = 14
		b.Parent = result
		corner(b, 5)
		return b
	end
	local approve = resultButton("Approve", 4, Color3.fromRGB(40, 120, 40))
	local reject = resultButton("Reject", 92, Color3.fromRGB(140, 40, 40))

	local diffs = scroller("Diffs", 5, 0.25)
	local log = scroller("Log", 6, 0.6)

	-- Append one line to a scroller's TextBox, capping history to the last
	-- MAX_LINES so the box never grows unbounded. Whole box stays one selectable
	-- block (highlight across lines).
	local MAX_LINES = 200
	local function appendLine(box: TextBox, text: string)
		local combined = if box.Text == "" then text else box.Text .. "\n" .. text
		local lines = string.split(combined, "\n")
		if #lines > MAX_LINES then
			combined = table.concat(lines, "\n", #lines - MAX_LINES + 1)
		end
		box.Text = combined
	end

	return {
		status = status,
		modelButton = modelButton,
		modelList = modelList,
		promptBox = promptBox,
		launchButton = launchButton,
		cancelButton = cancelButton,
		imageGate = imageGate,
		imageStatus = imageStatus,
		imageButton = imageButton,
		gate = gate,
		gateText = gateText,
		allowButton = allow,
		denyButton = deny,
		resultGate = result,
		resultText = resultText,
		preview = viewport,
		feedbackBox = feedbackBox,
		approveButton = approve,
		rejectButton = reject,
		diffs = diffs,
		log = log,
		addLine = appendLine,
	}
end

return Ui
