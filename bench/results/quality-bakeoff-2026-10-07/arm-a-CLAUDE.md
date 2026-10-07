# How we build Roblox games here (the article workflow)

You build with Claude Code, Roblox's official Studio MCP (`roblox-studio`) and robloxstudio-mcp
(`robloxstudio`: runtime eval, playtests, logs, screenshots, profilers). Follow every practice below. They come
from a write-up of how one developer ships Roblox games with Claude; they are the point of this setup.

## Project and the 4 checks (before any game code)
- Code lives in files in this directory, synced into Studio with Rojo (`rojo` 7.7 is on PATH; Studio has the
  Rojo plugin; `rojo serve` on WSL is reachable from Windows at localhost). Not in Studio.
  If live Rojo sync is impractical, `rojo build` an .rbxm/.rbxmx and load it into Studio through the MCP, but
  the files stay the source of truth: the place must be rebuildable from disk.
- An empty project must pass 4 checks before any game code is written, and they are re-run after every change:
  1. `rojo build` succeeds;
  2. tests: the pure rules are tested without Roblox (Lune is on PATH: `lune run ...`);
  3. `selene` lint (on PATH) is clean;
  4. `stylua --check` (on PATH) is clean.
  Put them in one script (e.g. `./check.sh`) and keep it green.

## The 4 rules
1. Code in files, not in Studio.
2. Every number (speeds, prices, sizes, colours, counts) lives in one config folder (e.g. `src/shared/Config/`).
3. Every client/server message goes through one remotes file.
4. Keep a written list of traps (`TRAPS.md`): every Roblox/tooling gotcha you hit, so it is never hit twice.
- Rules (damage, costs, upgrades, "what's next to buy") are plain functions over plain numbers with no
  Roblox objects, so they test under Lune without Studio.

## UI
- One spec makes three things: a preview image, the UI file, and the Studio build script. Write the spec
  (layout, sizes, colours, states) first; generate the preview (e.g. render it with Python/PIL or an HTML page
  screenshot) and look at it before building.
- Every panel and button gets the "depth stack": a blue-shifted drop shadow, a face gradient, a top lift
  (lighter top edge), and an even outline.
- A checker runs at 4 screen sizes (small phone up to 1080p) and must pass: thumb-size tap targets (≥ 44 px),
  nothing touching or overlapping, centred items within 1.5 px, no text too small, no stray boxes around
  buttons. Write it as a script you run (in Studio play via the MCP), fix everything it flags.
- Icons and images come from an AI image model, never emoji or text glyphs. Preferred: host an open model
  (e.g. Qwen-Image, FLUX.1-schnell) as a **batch job on Kaggle GPU** (`~/.local/bin/kaggle` CLI 2.2.4 — call
  it by full path; the miniforge `kaggle` first on PATH is too old; token in `~/.kaggle/access_token`):
  `kaggle kernels push` a notebook that writes PNGs, poll `kaggle kernels status`, then `kaggle kernels output`.
  Fallback: Flux schnell on Cloudflare Workers AI — read `oauth_token` from `~/.wrangler/config/default.toml`
  (never print it; `npx wrangler whoami` refreshes it), account id from
  `GET https://api.cloudflare.com/client/v4/accounts`, then
  `POST https://api.cloudflare.com/client/v4/accounts/<id>/ai/run/@cf/black-forest-labs/flux-1-schnell` with
  `{"prompt": "...", "steps": 4}` → base64 JPEG in `result.image`. Remove backgrounds for transparent PNGs.
  Upload through Open Cloud (key and creator id in the task's common rules).

## 3D assets
- Organic/complex props: generate with Hunyuan3D (batch job on Kaggle GPU), reduce to ~6k triangles in
  headless Blender (`blender -b -P script.py`), and bake the lost detail back in as a texture.
- Hard-edged props (crates, barns, guns) are built directly in Blender (or from parts) instead.
- Upload meshes/textures through Open Cloud.

## Maps
- Measure movement with raycasts and the real jump/speed numbers from config (WalkSpeed, jump height); label
  each number with its source and list your guesses.
- Run the 9 checks and fix what they find: floating platforms; tops you can't stand on; unreachable high
  ground; places a player can reach but shouldn't; pockets you can fall into and never climb out of;
  sightlines too open or too closed; parts stuck inside each other; uneven rings; ragdoll shortfalls.

## VFX/SFX (only if needed)
- Harvest free packs → classify → building blocks; judge an effect with "phase freeze" (freeze particles at
  start / middle / end and look at each).

## Studio
- The place for this arm is `BakeoffA.rbxl`. Use only it. robloxstudio-mcp: call `get_connected_instances`
  and pass the BakeoffA instance id. Official Studio MCP: `list_roblox_studios` and pick `BakeoffA.rbxl`.
