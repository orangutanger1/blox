-- BloxMap: map building blocks for world/ builders.
--   local Map = require(game.ReplicatedStorage.BloxMap)
--   Map.Lighting.apply("bright")
--   local B = Map.Build
--   B.ground(root, { size = Vector2.new(320, 280) })
--   B.boundary(root, { centre = Vector3.zero, size = Vector2.new(320, 280), height = 28 })
--   B.road(root, Vector3.new(-150, 0, 0), Vector3.new(150, 0, 0), { width = 18 })
--   B.house(root, "Farmhouse", CFrame.new(40, 0, -60), { L = 28, D = 20, H = 22, style = "cream", roof = "gable", roofStyle = "roofRed", enterable = true })
--   B.crate(root, Vector3.new(10, 0, 5)); B.bale(...); B.fence(root, a, b); B.tree(...); B.lamp(...); B.silo(...)
--   B.marker(root, "BossSpawn", pos)   (invisible spawn point)
-- Then `blox map check` and `blox map shots`.
return {
	Palette = require(script.Palette),
	Lighting = require(script.Lighting),
	Build = require(script.Build),
}
