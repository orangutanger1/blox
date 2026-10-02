// The one workflow guide every agent gets — served as the MCP server's
// `instructions`, written into scaffolded projects as AGENTS.md, and embedded
// in the built-in runner's system prompt. Keep it short: it is paid for in
// context on every session.

export const AGENT_GUIDE = `# Building Roblox games with blox

blox connects you to a running Roblox Studio. Files on disk are the source of
truth for code; blox pushes them into Studio and gives you structured feedback.

## Project layout (Rojo)
- src/ServerScriptService/*.server.luau  → Script (runs on server)
- src/StarterPlayerScripts/*.client.luau → LocalScript (runs on each client)
- src/StarterGui/*.client.luau           → LocalScript UI controllers (build GUIs in code)
- src/ReplicatedStorage/*.luau           → ModuleScript shared by server+client
- src/ServerStorage/*.luau               → server-only modules
- world/<Name>.luau → \`return function(model) ... end\` builds a Model named <Name> in
  Workspace (first line \`-- @parent ServerStorage\` to change parent). Use it for maps,
  platforms, props: geometry as code, rebuilt only when the file changes.
- tests/*.spec.luau → tests run inside Studio. First line \`-- @context edit|server|client\`.
  API: test(name, fn), describe, expect(v).toBe/toEqual/toBeTruthy/toBeNil/toExist/
  toBeGreaterThan/toBeLessThan/toBeCloseTo/toContain/toBeA/toThrow, waitFor(fn, secs).
  edit = no playtest (fast, pure logic); server/client = inside a running playtest
  (players, characters, RemoteEvents, PlayerGui).
A suffix decides the class: .server.luau Script, .client.luau LocalScript, .luau ModuleScript.
Files outside mapped folders never reach Studio — check default.project.json.

## Loop
1. status — what is attached, in sync, passing, and what the task needs. Empty
   project? scaffold creates the layout (non-destructive).
2. task {action:"set"} — write the goal and concrete acceptance criteria; bind each
   criterion to the tests that prove it.
3. Write code + world builders + tests on disk.
4. run_tests — syncs, runs every spec (regressions included), returns failures with
   file:line and runtime errors from the playtest.
5. playtest — run the game for a few seconds, probe server/client state with Luau,
   optionally drive input and take a screenshot; returns typed errors/warnings.
6. Fix and repeat until every criterion passes. A successful tool call is not proof:
   only passing tests / playtest observations are.

## Other tools
- explore — search the live instance tree (filter by instance_type/keywords/path, small
  max_depth). Use it to find what exists instead of dumping the tree with run_luau.
- logs — recent typed errors/warnings/output for edit, server or client.
- play — start/stop/state when you need a playtest left running across several calls
  (e.g. run_luau probes, then logs); playtest covers the common one-shot case.
- sync — push files without running tests (run_tests/playtest already sync).
- studio_tool — raw Studio MCP passthrough for what the tools above don't cover (assets,
  meshes, inspect_instance). Last resort: its output is unstructured and larger.

## Working efficiently
Every call costs time and context, so:
- Write all the files a step needs, then verify once: one run_tests after a batch of
  edits, not one per file.
- Don't re-read files you just wrote or re-run checks whose inputs didn't change.
- Probe narrowly: explore with filters, run_luau returning just the values you need,
  logs with a short since_seconds.
- Read failures fully and fix every one you can before the next run.
- Stop when every criterion passes; skip extra confirmation runs.

## Rules
- Prefer tests over one-off probes: a test keeps checking the feature forever.
- run_luau context "edit" is for inspecting/building in the edit DataModel; changes made
  there that are not in files or world/ builders are lost when the place reloads.
- Server state during play: context "server". Client/UI state: context "client".
- Do not edit scripts in Studio directly; edit files and sync.
- Screenshots are for visual work only (UI layout, look of a map), where existence
  checks can't judge the result. They are large; take few.
- run_luau must not yield (it has a short time budget): WaitForChild(x, 5) always with a
  timeout; waits, events, DataStore and HttpService belong in real scripts.
- Never Destroy/ClearAllChildren broadly: delete exactly what the task names, and inspect
  a container before clearing it.
- "No Studio"/disconnect errors are often momentary: retry once before calling Studio offline.
- Record anything you cannot do or verify with task {action:"block"} — do not claim it works.
`;
