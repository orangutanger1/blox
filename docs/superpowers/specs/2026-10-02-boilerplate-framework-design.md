# Boilerplate framework base + `check` gate

## Why
The format kits saved player data with raw `DataStoreService:SetAsync`: no session
locking (two servers can overwrite each other's copy of a player) and no
receipt-safe purchase path. frrazer/roblox-game-boilerplate (author's permission)
solves both and adds a clean system structure, so it becomes the base every kit
sits on.

## What
- `kits/boilerplate`: the boilerplate remapped to blox's layout
  (`src/shared` → `src/ReplicatedStorage`, `src/server` → `src/ServerScriptService`,
  `src/client` → `src/StarterPlayerScripts`), Wally packages vendored (runtime files
  only, `@x.y.z` → `@x_y_z` because blox sync cannot create scripts beneath a name
  containing `.`), Replica vendored, `FRAMEWORK.md` = the boilerplate's agent
  conventions adapted to blox. `kit apply boilerplate` = framework only.
- `kit.json` gains `base` (files layered underneath; most specific wins: kit →
  `_common` → base) and `common` (default true).
- incremental + steal: `KitService` is a Lifecycle system registered in the server
  Registry (`KitMain.server.luau` removed). State lives in the profile
  (`Data.Kit = { state, savedAt }`), so ProfileStore autosaves it; `savedAt` is
  refreshed every tick for offline earnings. `_common` overrides `Registry.luau`
  and `PlayerData.luau` (adds the `Kit` slot).
- `check` tool / `blox check [--fix]`: StyLua (when the project has
  `.stylua.toml`), `rojo sourcemap`, `luau-lsp analyze` (Roblox type definitions
  cached a week under `~/.cache/blox`; vendored code ignored; diagnostics deduped
  and made relative), `rojo build`. Missing tools are skipped, not passed.
- Sync fix found live: a module script with children (`Packet/init.luau`) was
  handed to multi_edit while its children's parent lookup created a Folder at the
  same path. Descendants of a pending script are now deferred to the next pass;
  a non-script blocking a script's path is reported by name.
- Client Bootstrap waits for its PlayerScripts siblings (cloning races the script).

## Verified live (Studio, unpublished place → ProfileStore mock)
steal: tests 36/36, multiplayer 3/3, soak 2/2, FTUE 3/3 (first-rare 2m07s, was
2m06s); playtest shows both Bootstraps Ready, Replica initial data, Packet round
trip. incremental: tests 27/27, multiplayer 3/3. All three kits pass `check`.

## Not done
Kit remotes are still RemoteFunctions (not Packet); Robux products are not wired
to kit grants (Products.luau is empty; a human decision).
