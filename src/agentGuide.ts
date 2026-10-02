// The one workflow guide every agent gets — served as the MCP server's
// `instructions`, written into scaffolded projects as AGENTS.md, and embedded
// in the built-in runner's system prompt. Keep it short: it is paid for in
// context on every session.

export const AGENT_GUIDE = `# Building Roblox games with blox

blox connects you to a running Roblox Studio. Files on disk are the source of truth;
blox pushes them into Studio and returns structured feedback.

## Project layout (Rojo)
- src/ServerScriptService/*.server.luau  → Script (server)
- src/StarterPlayerScripts/*.client.luau → LocalScript (each client)
- src/StarterGui/*.client.luau           → LocalScript UI (build GUIs in code)
- src/ReplicatedStorage/*.luau           → ModuleScript (shared)
- src/ServerStorage/*.luau               → server-only modules
- world/<Name>.luau → \`return function(model) ... end\` builds Model <Name> in Workspace
  (first line \`-- @parent ServerStorage\` to change parent): maps, platforms, props as code.
- tests/*.spec.luau, first line \`-- @context edit|server|client\`. edit = no playtest
  (fast, pure logic); server/client = inside a playtest (players, characters, remotes, PlayerGui).
  API: test(name, fn), describe, expect(v).toBe/toEqual/toBeTruthy/toBeNil/toExist/
  toBeGreaterThan/toBeLessThan/toBeCloseTo/toContain/toBeA/toThrow, waitFor(fn, secs).
Suffix sets the class (.server Script, .client LocalScript, plain ModuleScript). Files
outside folders mapped in default.project.json never reach Studio.

## Loop
1. status (empty project? scaffold).
2. task {action:"set"}: goal + acceptance criteria, each bound to the tests that prove it.
3. Write code, world builders and tests; check (stylua, luau-lsp types, rojo build) until clean.
4. run_tests: syncs, runs every spec, returns failures with file:line + runtime errors.
5. playtest: run the game a few seconds, probe server/client with Luau, optional input
   and screenshot; returns typed errors/warnings. A UI flow is one call: inputs
   [{kind:"luau",args:{context:"server",code:"<set up state>"}}, {kind:"click",
   args:{target:"PlayerGui.HUD.Button"}}, …] then server_code/client_code to check.
6. Fix and repeat until every criterion passes. Only passing tests / playtest
   observations count as proof, not a successful tool call.

## Start from a kit, a template or a pack
kit {action:"list"} then kit {action:"apply", name} gives a tested loop (modules, world,
specs, design.json) to reskin and tune instead of writing systems from scratch. Kits sit on
the boilerplate framework (Lifecycle services/controllers, Packet networking, ProfileStore
data, safe receipts): follow FRAMEWORK.md. kit apply boilerplate = framework only.
Before building a map or a UI from scratch, search the Creator Store for free map
templates and UI packs (studio_tool search_asset), insert the best, sanitize it (Assets),
then adapt it.

## Multiplayer
Social/PvP rules (theft, trading, rounds) need real clients: tests/<name>.mp.luau
("-- @context multiplayer", "-- @clients N"), then multiplayer {}. Specs get mp.players and
mp.client(player, "invoke", "ReplicatedStorage.Remotes.X", ...) to act as each client.

## Assets
Prefer code-built geometry. Record every other asset: asset {action:"sanitize", path, id}
after inserting a Creator Store model (strips scripts, flags backdoors), asset {action:"add"}
for generated/external ones, asset {action:"lint"}. Approval and uploads are human steps.
Custom models (creatures, props, rigged pets): model {action:"brief"} → run (Blender Python with
voxels/box/rig/bind_rigid/animate) → check (open the views, compare with references) → export →
preview (EditableMesh in Studio) → import. After inserting an uploaded model, set its MeshParts'
Color to white (vertex colours are multiplied by it); rigged ones: model animate → upload → BloxAnimate.

## Release and live-ops
release {action:"check"} lists every gate. Publishing, live config and monetization are human
decisions: prepare and dry-run, never confirm unless asked. After launch: liveops report →
propose → apply (local), then a new release.

## UI
Build HUDs with BloxUI (ui {action:"install"}; kits include it): scale-sized, 44px touch
targets, safe-area aware. Then ui {action:"lint"} checks every device size; fix all errors.

## Store page
present {action:"generate"} drafts title/description/shots from design.json; adjust shot
cameras to the real map, present {action:"render"} (16:9 viewport), present {action:"lint"}.
Final title/art choice and uploading are for a human.

## Design first (economy games)
design {action:"set"} a .blox/design.json (economy, archetypes, assertions such as
"first egg <= 60s"), then design {action:"simulate"}; tune numbers until assertions
pass, then design {action:"codegen"} and read every tuned number from
ReplicatedStorage.Design.Tunables — never hard-code them. Bind pacing criteria with
tests:["design:<assertionId>"]. Then measure the real game: metrics {action:"ftue"} (each
ftue step within targetSec) and metrics {action:"soak", bot, archetype} (errors, memory,
simulated pace); bind with tests:["ftue:<id>"|"soak:<check>"].

Other tools: explore (filtered instance-tree search; use it instead of dumping the tree),
logs (recent errors/output per context), play (start/stop/state, for a playtest kept
running across calls), sync (push without testing), studio_tool (last resort: raw Studio
tools for assets/meshes/inspect_instance; output is larger and unstructured).

## Working efficiently
Every turn resends the whole conversation, so turns are the main cost:
- Make independent calls in the same turn (read every file you need at once,
  write every file a step needs at once), then run_tests once.
- Don't re-read files you just wrote or re-run checks whose inputs didn't change.
- Probe narrowly: filtered explore, run_luau returning only the values you need.
- Fix every failure you can see before the next run.
- Stop when every criterion passes; no extra confirmation runs.

## Rules
- Prefer tests over one-off probes: a test keeps checking forever.
- run_luau context edit changes not captured in files or world/ builders are lost on reload.
- Server state during play: context server. Client/UI state: context client.
- Never edit scripts in Studio; edit files.
- Screenshots only for visual judgments (UI layout, map look); they are large.
- run_luau must not yield: WaitForChild(x, 5) always with a timeout; waits, events,
  DataStore and HttpService belong in real scripts.
- Never Destroy/ClearAllChildren broadly; delete exactly what the task names.
- "No Studio"/disconnect errors are often momentary: retry once first.
- Record anything you cannot do or verify with task {action:"block"}; never claim it works.
`;
