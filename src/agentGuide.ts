// The one workflow guide every agent gets — served as the MCP server's
// `instructions`, written into scaffolded projects as AGENTS.md, and embedded
// in the built-in runner's system prompt. Keep it short: it is paid for in
// context on every session.

export const AGENT_GUIDE = `# Building Roblox games with blox

blox drives a running Roblox Studio. Files on disk are the source of truth; blox syncs them.

## Project layout (Rojo)
- src/ServerScriptService/*.server.luau Script · src/StarterPlayerScripts/*.client.luau
  LocalScript · src/StarterGui/*.client.luau LocalScript UI built in code · src/ReplicatedStorage/*.luau
  shared ModuleScript · src/ServerStorage/*.luau server-only modules. Suffix sets the class;
  files outside folders mapped in default.project.json never reach Studio.
- world/<Name>.luau → \`return function(model) ... end\` builds Model <Name> in Workspace
  (\`-- @parent ServerStorage\` first line to move it): maps, platforms, props as code.
- tests/*.spec.luau, first line \`-- @context edit|server|client\`: edit = no playtest (pure
  logic, fast); server/client = one playtest, in parallel. API: test(name, fn, secs?) (secs: longer
  window, e.g. waiting on the other context), describe, waitFor(fn, secs), expect(v).toBe/toEqual/toBeTruthy/toBeNil/toExist/toBeGreaterThan/toBeLessThan/
  toBeCloseTo(v,eps)/toContain/toBeA/toThrow.

## Loop
1. status (empty project? scaffold). 2. task {action:"set"}: goal + acceptance criteria,
each bound to the tests that prove it. 3. Write code, world builders, tests; check (stylua,
luau-lsp, rojo build) until clean. 4. run_tests: syncs, runs every spec, returns failures at
file:line + runtime errors. 5. playtest: runs the game, probes server/client Luau, optional
inputs + screenshot. A UI flow is one call: inputs [{kind:"luau",args:{context:"server",
code}}, {kind:"click",args:{target:"PlayerGui.HUD.Button"}}] then server_code/client_code to check.
6. Repeat until every criterion passes. Only passing tests/playtest results are proof, not a
successful tool call.

## Start from a kit, template or pack
No game picked yet? idea research → propose (cite snapshot games) → human picks from idea list → idea brief; read .blox/brief.json before design.
kit {action:"list"} / kit {action:"apply", name}: a tested loop (modules, world, specs,
design.json) to reskin, on the boilerplate framework (Lifecycle, Packet, ProfileStore, safe
receipts) — follow FRAMEWORK.md; kit apply boilerplate = framework only. Before building a map, UI
or big prop: scout {action:"search", need, kind} finds free packs (Store, DevForum, web);
try (quarantined, verdict) → adopt (scripts stripped, provenance
recorded) and adapt, or discard and build; try on a gear id records its mesh by id. Unsure of an API or pattern? skill {} lists know-how; load skill {name}.

## Multiplayer
PvP/trading/rounds need real clients: tests/<name>.mp.luau ("-- @context multiplayer",
"-- @clients N"), then multiplayer {}. Specs use mp.players and mp.client(player, "invoke",
"ReplicatedStorage.Remotes.X", ...).

## Assets, models, animation
Prefer code-built geometry; record every other asset: asset {action:"sanitize", path, id}
after inserting a Store model (strips scripts, flags backdoors), asset {action:"add"} for others,
asset {action:"lint"}. Approvals and uploads are human steps.
Custom models: model {action:"brief"} → run (Blender Python) → check (vs refs) → export → preview → import. UI icons (no emoji): a model per
icon → model icon → asset sheet → upload. After
inserting an uploaded model set its MeshParts' Color to white; rigged: model animate →
upload → BloxAnimate.
Characters (R15/R6): animate recipes → check (read the sheet) → build → human approves →
asset upload → animate wire {slot, asset, name} → verify (skill character-animation). NPCs/models: animate
npc or rig → declare → check {rig:<model path>} → build → human approves → asset upload → wire {model,
state} → verify.

## Ship
release {action:"check"} lists every gate; publishing, live config and monetization are
human decisions: prepare and dry-run, never confirm unless asked. After launch: liveops
report → propose → apply (local), then a new release.
UI pack? scout preview, clone its panels (skill ui-packs); else BloxUI (ui install,
44px targets). Then ui {action:"lint"} on all device sizes, fix every error.
Store page: present {action:"generate"} → fix shot cameras → present {action:"render"}
(16:9 viewport) → present {action:"lint"}; final title/art and upload are human.

## Design first (economy games)
design {action:"set"} .blox/design.json (economy, archetypes, assertions like "first egg
<= 60s") → design {action:"simulate"}, tune until assertions pass → design
{action:"codegen"}; read numbers from ReplicatedStorage.Design.Tunables, never hard-code.
Bind tests:["design:<assertionId>"]. Measure the real game: metrics {action:"ftue"} and
metrics {action:"soak", bot, archetype}; bind tests:["ftue:<id>"|"soak:<check>"].

Other tools: explore (filtered tree search, not a full dump), logs, play (start/stop/state;
keeps a playtest running), sync, run_luau, studio_tool (last resort, big output).

## Working efficiently
Turns cost most. Make independent calls in the same turn (read/write every file a step needs at once), then run_tests once. Don't
re-read files you just wrote or re-run unchanged checks. Probe narrowly. Fix every visible failure before the next run. Stop when every criterion passes; no extra confirmation runs.

## Rules
- Prefer tests over one-off probes: a test keeps checking forever.
- run_luau context edit changes not captured in files or world/ builders are lost on reload.
- Server state in play: context server; client/UI state: context client.
- Never edit scripts in Studio; edit files.
- Screenshots only for visual judgments (large).
- run_luau must not yield: WaitForChild(x, 5) with a timeout; waits, events, DataStore and
  HttpService belong in real scripts.
- Never Destroy/ClearAllChildren broadly; delete exactly what the task names.
- "No Studio"/disconnects are often momentary: retry once.
- Record anything you cannot do or verify with task {action:"block"}; never claim it works.
`;
