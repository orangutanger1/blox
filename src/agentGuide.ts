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
3. Write code, world builders and tests.
4. run_tests: syncs, runs every spec, returns failures with file:line + runtime errors.
5. playtest: run the game a few seconds, probe server/client with Luau, optional input
   and screenshot; returns typed errors/warnings.
6. Fix and repeat until every criterion passes. Only passing tests / playtest
   observations count as proof, not a successful tool call.

Other tools: explore (filtered instance-tree search; use it instead of dumping the tree),
logs (recent errors/output per context), play (start/stop/state, for a playtest kept
running across calls), sync (push without testing), studio_tool (last resort: raw Studio
tools for assets/meshes/inspect_instance; output is larger and unstructured).

## Working efficiently
Every call costs time and context:
- Write all files a step needs, then run_tests once, not once per file.
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
