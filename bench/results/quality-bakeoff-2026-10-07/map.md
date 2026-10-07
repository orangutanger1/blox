# Task 1 — Map: Farm Town

Copy Zombie Attack's **Farm Town** map. References: `images/wiki/Farm*.PNG`, `images/wiki/Farm_Town.PNG`,
`images/sheets/v1_maps.png`, `wiki/Farm_Town_Map.wiki` (all under `~/blox-research/zombie-attack/`).

Must have: grass field, red barn with hay bales, crates, a tent, 2 enterable houses, a small gas station with a
red/white canopy, an asphalt road with kerbs, a brick perimeter wall, day lighting. Match ZA's look (simple,
blocky, readable Roblox style) and layout as closely as the references allow.

Requirements:
- Player spawn(s).
- 8 dog spawn markers at the map edges, and one boss spawn on open ground between the wall and the red house.
- An invisible boundary that keeps players inside.
- No walkable interiors under roofs except the 2 houses' ground floors (the tent may be entered too, per the wiki).
- Players: R15, WalkSpeed 16, JumpPower giving a 7.2 stud jump height. Everything a player should reach must be
  reachable on foot; dog spawns must be able to reach the player spawn on foot.

Contract (so the judging scripts can find things; names are exact):
- The map is a Model `Workspace.FarmTown`.
- `Workspace.FarmTown.DogSpawns` is a Folder of 8 BaseParts (anchored, invisible, non-colliding).
- `Workspace.FarmTown.BossSpawn` is a BasePart (anchored, invisible, non-colliding).
- Player spawn(s) are SpawnLocation(s) inside `Workspace.FarmTown`.
- Lighting is set by your work (in files), not left at defaults by accident.
