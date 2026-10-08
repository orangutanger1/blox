---
name: map-building
description: Build a play map with BloxMap (palette, bright lighting, houses, roads, boundary), then prove it with map check (walkability, leaks, triangles, saturation) and map shots after every building pass.
---
# Building a map

Young players pick bright, readable maps. The bake-off showed what loses:
hazy lighting (Atmosphere.Haze 0.8 halved the rendered saturation with the
same part colours), climbable roofs, players escaping over the boundary,
and covered spots nobody meant to be reachable.

## Loop

1. Scout first: scout {action:"search", need, kind:"map"}. A good free pack
   adapted beats a map built from scratch; keep going only if none fit.
2. map {action:"install"} → `src/ReplicatedStorage/BloxMap`.
3. Write the map as code in `world/<Map>.luau` under one root (default
   `Workspace.Map`; set `map.root` in blox.config.json otherwise):

   ```luau
   local Map = require(game.ReplicatedStorage.BloxMap)
   Map.Lighting.apply("bright")
   local B = Map.Build
   local root = B.folder(workspace, "Map")
   B.ground(root, { size = Vector2.new(320, 280) })
   B.boundary(root, { centre = Vector3.zero, size = Vector2.new(320, 280), height = 28 })
   B.road(root, Vector3.new(-150, 0, 0), Vector3.new(150, 0, 0), { width = 18 })
   B.house(root, "Farmhouse", CFrame.new(40, 0, -60), { L = 28, D = 20, H = 22, style = "cream", roof = "gable", roofStyle = "roofRed", enterable = true })
   B.marker(root, "BossSpawn", Vector3.new(120, 3, 100))
   ```

   Colours come from `Map.Palette` names (`grass`, `barnRed`, `cream`,
   `roofBlue`, `hay`…); pass a name as `style`. Keep neutrals (road, kerb,
   concrete, metal) for a minority of the area.
   Night maps: `Map.Lighting.apply("night")` plus a few shadowless lights
   (`B.canopy{lights=true}`, `B.lamp`) — never zero ambient. Overhead parts
   (roofs, canopies, lintels, upper storeys) carry the "Roof" tag; tag your
   own with `B.roof(part)` so enemy heightfield navigation sees the floor below.
4. Name enemy/NPC spawn groups in config: `"map": {"spawns": {"Dogs":
   "Workspace.Map.DogSpawns"}}`. Player spawns are the SpawnLocations, or
   marker parts named by `"playerSpawns": "PlayerSpawns"`. Several maps kept
   in ServerStorage: `"root": ["ServerStorage.Maps.Farm", …]` (checked and
   shot on a temporary Workspace copy; `--root` for one; shots need one).
5. map {action:"check"} after each building pass. Fix every failure:
   - spawns-reach / pockets: open a path or lower the step (jump height
     includes 0.9 studs of take-off; a 7-stud ledge is climbable).
   - leak: the boundary has a gap or something to jump from near it.
   - roofs (warn): reachable points high above the ground — raise eaves,
     move crates and fences away from walls, unless it's a platform on purpose.
   - covered (warn): reachable spots under a roof outside an enterable
     house. Tag real interiors "Interior" or block the gap.
   - overlap (warn): pieces crossing each other; make faces meet.
   - triangles: over budget → fewer small parts, CastShadow off on small
     decor (Build does this under 8 studs), fewer cylinders.
   - saturation (warn): `Map.Lighting.apply("bright")`, brighter palette names.
6. map {action:"shots"} → read the sheet: 4 corners, 2 eye-level, top, play.
   Compare with the reference images in the brief; rendered saturation
   should be about 0.5+. Fix what looks empty, flat or grey, then check again.
7. Bind the checks to the task: criteria with tests:["map:leak",
   "map:spawns-reach", "map:pockets", "map:triangles"]. release check has a
   `map` gate once blox.config.json has `map`.

## Don'ts

- Don't place props against walls or roofs: they become stairs onto them.
- Don't build cylinders for every pole and silo; Build's silo is an 8-sided prism.
- Don't fix colour by repainting parts when the cause is haze or missing colour correction.
