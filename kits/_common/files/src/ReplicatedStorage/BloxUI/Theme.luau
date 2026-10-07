-- BloxUI theme tokens. Change colours/fonts here; components read them at build time.
-- Styles are the depth-stack colours: a face gradient (top → bottom), an outline,
-- and how strong the light strip under the top edge is (lift 0..1). Pass a style
-- name (or a Color3, from which a style is derived) as a component's `color`.
local function rgb(r: number, g: number, b: number): Color3
	return Color3.fromRGB(r, g, b)
end
local function style(top: Color3, bottom: Color3, stroke: Color3, lift: number)
	return { top = top, bottom = bottom, stroke = stroke, lift = lift }
end

return {
	font = Enum.Font.FredokaOne,
	fontHeavy = Enum.Font.FredokaOne,
	text = rgb(255, 255, 255),
	textDim = rgb(225, 232, 240),
	textStroke = rgb(22, 26, 40), -- dark outline around white text
	-- flat colours (older code passes these as `color`; a style is derived from them)
	panel = rgb(40, 110, 220),
	panelAlt = rgb(30, 80, 170),
	stroke = rgb(16, 40, 100),
	primary = rgb(52, 176, 40), -- buy / confirm
	accent = rgb(132, 62, 220), -- rebirth / special
	info = rgb(34, 128, 226),
	warn = rgb(238, 178, 30),
	danger = rgb(196, 34, 34),
	disabled = rgb(112, 112, 110),
	styles = {
		primary = style(rgb(120, 232, 72), rgb(52, 176, 40), rgb(22, 96, 22), 0.6),
		info = style(rgb(92, 196, 255), rgb(34, 128, 226), rgb(16, 66, 140), 0.6),
		warn = style(rgb(255, 222, 96), rgb(232, 166, 26), rgb(136, 88, 8), 0.6),
		danger = style(rgb(244, 86, 74), rgb(196, 34, 34), rgb(110, 14, 18), 0.55),
		accent = style(rgb(196, 128, 255), rgb(132, 62, 220), rgb(68, 24, 128), 0.6),
		tab = style(rgb(104, 160, 255), rgb(60, 118, 226), rgb(22, 60, 140), 0.5),
		tabActive = style(rgb(255, 226, 92), rgb(238, 178, 30), rgb(140, 92, 10), 0.6),
		panel = style(rgb(74, 146, 255), rgb(40, 104, 222), rgb(16, 48, 120), 0.55),
		row = style(rgb(92, 160, 255), rgb(58, 124, 236), rgb(22, 62, 146), 0.5),
		slot = style(rgb(30, 60, 130), rgb(22, 44, 100), rgb(12, 28, 70), 0.25),
		dark = style(rgb(40, 52, 70), rgb(24, 32, 46), rgb(10, 14, 22), 0.25),
		disabled = style(rgb(150, 150, 146), rgb(112, 112, 110), rgb(64, 64, 64), 0.4),
		locked = style(rgb(92, 98, 104), rgb(66, 70, 76), rgb(38, 42, 46), 0.35),
	},
	depth = {
		shadow = rgb(14, 24, 64), -- blue-shifted drop shadow
		shadowTransparency = 0.45,
		shadowOffset = 4, -- px, straight down
		liftHeight = 3, -- px light strip just inside the top edge
		outline = 2.5, -- px even outline
		textStroke = 2, -- px outline around white text
		press = 0.94, -- scale while pressed
	},
	radius = 8, -- buttons, tiles, bars: square-ish, never pills
	panelRadius = 12, -- windows and dialogs
	minTouch = 44, -- px; mobile touch target floor (ui lint enforces it)
	maxText = 36,
	minText = 10,
}
