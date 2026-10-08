-- Lighting presets. "bright" (default): clear daylight, little haze, and a
-- colour-correction boost — the bake-off showed haze washes a map's colours
-- out far more than the part colours do. Call once from the world builder.
local Lighting = {}

local PRESETS = {
	bright = {
		ClockTime = 14,
		Brightness = 2.6,
		Ambient = Color3.fromRGB(96, 96, 108),
		OutdoorAmbient = Color3.fromRGB(150, 150, 160),
		EnvironmentDiffuseScale = 0.6,
		EnvironmentSpecularScale = 0.4,
		GlobalShadows = true,
		atmosphere = {
			Density = 0.22,
			Offset = 0,
			Haze = 0.15,
			Glare = 0,
			Color = Color3.fromRGB(200, 222, 245),
			Decay = Color3.fromRGB(110, 150, 200),
		},
		color = { Saturation = 0.16, Contrast = 0.06, Brightness = 0.02 },
	},
	soft = {
		ClockTime = 15.5,
		Brightness = 2.2,
		Ambient = Color3.fromRGB(100, 100, 110),
		OutdoorAmbient = Color3.fromRGB(150, 145, 150),
		EnvironmentDiffuseScale = 0.6,
		EnvironmentSpecularScale = 0.4,
		GlobalShadows = true,
		atmosphere = {
			Density = 0.28,
			Offset = 0,
			Haze = 0.3,
			Glare = 0.1,
			Color = Color3.fromRGB(215, 220, 235),
			Decay = Color3.fromRGB(120, 140, 170),
		},
		color = { Saturation = 0.1, Contrast = 0.04, Brightness = 0 },
	},
}

local function set(inst: Instance, props: { [string]: any })
	for k, v in props do
		if type(v) ~= "table" then
			pcall(function()
				(inst :: any)[k] = v
			end)
		end
	end
end

function Lighting.apply(name: string?)
	local p = assert(PRESETS[name or "bright"], "BloxMap.Lighting: no preset " .. tostring(name))
	local L = game:GetService("Lighting")
	set(L, p)
	local atm = L:FindFirstChildOfClass("Atmosphere") or Instance.new("Atmosphere")
	set(atm, p.atmosphere)
	atm.Parent = L
	local cc = L:FindFirstChild("BloxMapColor") or Instance.new("ColorCorrectionEffect")
	cc.Name = "BloxMapColor"
	set(cc, p.color)
	cc.Parent = L
end

Lighting.presets = PRESETS
return Lighting
