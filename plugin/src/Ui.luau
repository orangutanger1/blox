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

function Ui.build(widget: DockWidgetPluginGui)
	local root = Instance.new("Frame")
	root.Size = UDim2.fromScale(1, 1)
	root.BackgroundColor3 = Color3.fromRGB(36, 36, 36)
	root.Parent = widget

	local layout = Instance.new("UIListLayout")
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Padding = UDim.new(0, 4)
	layout.Parent = root

	local status = label(root, "Status", 1)
	status.Text = "disconnected — run blox to start"
	status.TextColor3 = Color3.fromRGB(255, 170, 0)

	-- Image request card: hidden until an image_request arrives (P3).
	local imageGate = Instance.new("Frame")
	imageGate.Name = "ImageGate"
	imageGate.LayoutOrder = 2
	imageGate.Size = UDim2.new(1, -8, 0, 56)
	imageGate.BackgroundColor3 = Color3.fromRGB(30, 40, 60)
	imageGate.Visible = false
	imageGate.Parent = root

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
	imageButton.Parent = imageGate

	-- Gate card: hidden until a gate_request arrives.
	local gate = Instance.new("Frame")
	gate.Name = "Gate"
	gate.LayoutOrder = 3
	gate.Size = UDim2.new(1, -8, 0, 76)
	gate.BackgroundColor3 = Color3.fromRGB(60, 50, 20)
	gate.Visible = false
	gate.Parent = root

	local gateText = label(gate, "GateText", 1)
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
		b.Parent = gate
		return b
	end
	local allow = button("Allow", 4, Color3.fromRGB(40, 120, 40))
	local deny = button("Deny", 92, Color3.fromRGB(140, 40, 40))

	-- Diff list + log share a scrolling frame each.
	local function scroller(name: string, order: number, heightScale: number): ScrollingFrame
		local s = Instance.new("ScrollingFrame")
		s.Name = name
		s.LayoutOrder = order
		s.Size = UDim2.new(1, -8, heightScale, -8)
		s.CanvasSize = UDim2.new()
		s.AutomaticCanvasSize = Enum.AutomaticSize.Y
		s.BackgroundColor3 = Color3.fromRGB(28, 28, 28)
		s.BorderSizePixel = 0
		s.ScrollBarThickness = 6
		s.Parent = root
		local ll = Instance.new("UIListLayout")
		ll.SortOrder = Enum.SortOrder.LayoutOrder
		ll.Parent = s
		return s
	end
	-- Result card: hidden until a result_gate_request arrives (P2 spec §5).
	local result = Instance.new("Frame")
	result.Name = "ResultGate"
	result.LayoutOrder = 4
	result.Size = UDim2.new(1, -8, 0, 210)
	result.BackgroundColor3 = Color3.fromRGB(30, 50, 60)
	result.Visible = false
	result.Parent = root

	local resultText = label(result, "ResultText", 1)
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

	local feedbackBox = Instance.new("TextBox")
	feedbackBox.Name = "Feedback"
	feedbackBox.PlaceholderText = "optional feedback for the agent (sent on Reject)"
	feedbackBox.Text = ""
	feedbackBox.Position = UDim2.new(0, 4, 1, -62)
	feedbackBox.Size = UDim2.new(1, -8, 0, 24)
	feedbackBox.BackgroundColor3 = Color3.fromRGB(50, 50, 50)
	feedbackBox.TextColor3 = Color3.fromRGB(220, 220, 220)
	feedbackBox.TextXAlignment = Enum.TextXAlignment.Left
	feedbackBox.ClearTextOnFocus = false
	feedbackBox.Parent = result

	local function resultButton(name: string, x: number, color: Color3): TextButton
		local b = Instance.new("TextButton")
		b.Name = name
		b.Text = name
		b.Position = UDim2.new(0, x, 1, -30)
		b.Size = UDim2.fromOffset(80, 24)
		b.BackgroundColor3 = color
		b.TextColor3 = Color3.fromRGB(255, 255, 255)
		b.Parent = result
		return b
	end
	local approve = resultButton("Approve", 4, Color3.fromRGB(40, 120, 40))
	local reject = resultButton("Reject", 92, Color3.fromRGB(140, 40, 40))

	local diffs = scroller("Diffs", 5, 0.25)
	local log = scroller("Log", 6, 0.6)

	-- Log/diff lines are read-only TextBoxes (not TextLabels) so text can be
	-- selected and copied with Ctrl+C.
	local function line(parent: ScrollingFrame, text: string, order: number)
		local b = Instance.new("TextBox")
		b.Name = "Line" .. order
		b.LayoutOrder = order
		b.Size = UDim2.new(1, -8, 0, 18)
		b.BackgroundTransparency = 1
		b.TextXAlignment = Enum.TextXAlignment.Left
		b.TextColor3 = Color3.fromRGB(204, 204, 204)
		b.TextSize = 14
		b.Font = Enum.Font.Code
		b.TextTruncate = Enum.TextTruncate.AtEnd
		b.TextEditable = false
		b.ClearTextOnFocus = false
		b.Text = text
		b.Parent = parent
	end

	return {
		status = status,
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
		addLine = line,
	}
end

return Ui
