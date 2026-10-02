-- BloxUI theme tokens. Change colours/fonts here; components read them at build time.
return {
	font = Enum.Font.GothamBold,
	fontHeavy = Enum.Font.GothamBlack,
	text = Color3.fromRGB(255, 255, 255),
	textDim = Color3.fromRGB(200, 205, 220),
	panel = Color3.fromRGB(24, 26, 40),
	panelAlt = Color3.fromRGB(38, 41, 62),
	stroke = Color3.fromRGB(10, 10, 18),
	primary = Color3.fromRGB(46, 170, 80), -- buy / confirm
	accent = Color3.fromRGB(150, 70, 220), -- rebirth / special
	info = Color3.fromRGB(40, 140, 230),
	danger = Color3.fromRGB(215, 60, 60),
	disabled = Color3.fromRGB(90, 92, 105),
	radius = 12,
	minTouch = 44, -- px; mobile touch target floor (ui lint enforces it)
	maxText = 36,
	minText = 10,
}
