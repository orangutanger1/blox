-- Saturated, kid-friendly map colours (Roblox's young players like bright,
-- saturated worlds). Each entry is a colour plus a material. Neutrals (roads,
-- kerbs, metal, glass, concrete) stay grey on purpose so the colours pop.
-- Change or add entries per game; builders take a name or { color, material }.
local function c(r: number, g: number, b: number, material: Enum.Material)
	return { color = Color3.fromRGB(r, g, b), material = material }
end
local M = Enum.Material

local colors = {
	grass = c(76, 178, 58, M.Grass),
	grassDark = c(52, 140, 44, M.Grass),
	dirt = c(156, 102, 52, M.Ground),
	sand = c(236, 204, 120, M.Sand),
	water = c(48, 150, 230, M.Glass),
	road = c(56, 60, 70, M.Asphalt),
	kerb = c(214, 214, 208, M.Concrete),
	concrete = c(180, 180, 176, M.Concrete),
	brickRed = c(196, 72, 50, M.Brick),
	barnRed = c(206, 40, 40, M.WoodPlanks),
	cream = c(248, 222, 150, M.Plaster),
	yellow = c(250, 204, 56, M.SmoothPlastic),
	orange = c(242, 138, 46, M.SmoothPlastic),
	skyBlue = c(86, 170, 238, M.Plaster),
	mint = c(110, 214, 160, M.Plaster),
	pink = c(240, 120, 170, M.Plaster),
	purple = c(150, 90, 214, M.Plaster),
	white = c(242, 242, 238, M.Plaster),
	roofGrey = c(104, 112, 130, M.Slate),
	roofRed = c(190, 58, 46, M.Slate),
	roofBlue = c(58, 108, 204, M.Slate),
	roofGreen = c(56, 150, 80, M.Slate),
	wood = c(156, 98, 52, M.WoodPlanks),
	woodDark = c(104, 62, 32, M.Wood),
	hay = c(238, 196, 66, M.Grass),
	strap = c(176, 52, 46, M.Fabric),
	leaf = c(66, 176, 62, M.Grass),
	trunk = c(124, 80, 42, M.Wood),
	metal = c(186, 190, 196, M.Metal),
	glass = c(150, 212, 242, M.Glass),
	neonWarm = c(255, 236, 180, M.Neon),
}

local neutral = {
	road = true,
	kerb = true,
	concrete = true,
	white = true,
	roofGrey = true,
	metal = true,
	glass = true,
	neonWarm = true,
}

return { colors = colors, neutral = neutral }
