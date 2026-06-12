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

	-- Gate card: hidden until a gate_request arrives.
	local gate = Instance.new("Frame")
	gate.Name = "Gate"
	gate.LayoutOrder = 2
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
	local diffs = scroller("Diffs", 3, 0.25)
	local log = scroller("Log", 4, 0.6)

	return {
		status = status,
		gate = gate,
		gateText = gateText,
		allowButton = allow,
		denyButton = deny,
		diffs = diffs,
		log = log,
		addLine = function(parent: ScrollingFrame, text: string, order: number)
			label(parent, "Line" .. order, order).Text = text
		end,
	}
end

return Ui
