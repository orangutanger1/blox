# Bake-off rules (same for every agent)

- You are building real work for "Dog Attack", a Roblox copy of Zombie Attack (Roblox 1240123653) with dogs
  instead of zombies. Quality is what is judged: how it looks, how it plays, how well it is built. A human
  judges screenshots blind; scripts also measure walkability, part/triangle counts, frame time, UI overlap,
  tap-target size, text size, script errors, and whether the work is rebuildable from files on disk.
- References (read them): `~/blox-research/zombie-attack/` — `RESEARCH.md`, `images/wiki/*`,
  `images/sheets/*`, `video/f_*_sheet*.jpg` (HUD frames), `wiki/*.wiki`.
- Work only in your own project directory and your own Studio place. The Studio place for this run is named in
  your task file. Never open, edit or save any other place (especially `DogAttack.rbxl`).
- The Roblox Studio window may be minimised; a minimised window gives blank screenshots. Restore it with
  PowerShell (`user32 ShowWindow(hwnd, 9)` on the RobloxStudioBeta process) if captures come back blank.
- Asset uploads (images, meshes) through Roblox Open Cloud are authorized, and so are asset approvals. Open
  Cloud key: `~/.config/blox/opencloud.env` (`ROBLOX_OPEN_CLOUD_KEY`, never print it); creator userId
  682176016. Never create, price or publish game passes, developer products or places.
- The user owns these inventory packs; you may insert and use them: 9492405836 (Ultimate Low Poly Asset Pack),
  6526415003 (Icey's Asset Pack), 6903894518 (Texture Pack V2), 6127206197 (Free Texture Set).
  Strip any scripts from inserted models.
- Do not run multiplayer (multi-client) tests: the user may be playing Roblox on this PC. Solo playtests are fine.
- Headless Blender is available in WSL (`blender` snap) if you want it.
- You don't need to save the place file; leave Studio open with your work in it. Everything you build must
  also be reproducible from your project files.
- Finish with a short report: what you built, how you checked it, known gaps.
