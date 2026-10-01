# AI-assisted Roblox development — landscape (researched 2026-09-30)

Purpose: ground blox's redesign in what exists today. "Verified" = observed by
us against a live Studio on 2026-09-30; "documented" = official docs/posts;
"claimed" = marketing or third-party write-ups not independently checked.

## Roblox Studio itself

### Built-in Studio MCP server (the integration point blox builds on)
- Built into Studio since Mar 2026 ("Assistant Updates: Studio Built-in MCP Server and
  Playtest Automation", 2026-03-05,
  <https://devforum.roblox.com/t/assistant-updates-studio-built-in-mcp-server-and-playtest-automation/4474643>).
  Tool parity with Assistant; works with Claude Code, Cursor, VS Code, Antigravity.
- **Aug 19 2026 breaking change**: every tool requires `studio_id`; `set_active_studio`
  removed; `list_roblox_studios` returns place ids
  (<https://devforum.roblox.com/t/studio-mcp-multi-agent-improvements-and-connected-ai-clients/4820583>).
  *Verified*: live catalog (26 tools) all require `studio_id`. The old blox doctor probe
  and every hardcoded call broke.
- **Verified live catalog 2026-09-30** (`StudioMCP.exe` from Studio version-76e1a02649ad4f35):
  `execute_luau(code, datamodel_type)`, `get_studio_state`, `start_stop_play(is_start)`,
  `get_console_output`, `screen_capture(capture_id, camera_position?, look_at_position?)`,
  `character_navigation`, `user_keyboard_input`, `user_mouse_input`, `search_game_tree`,
  `inspect_instance`, `script_read/search/grep`, `multi_edit`, `generate_mesh`,
  `generate_material`, `generate_procedural_model`, `wait_job_finished`, **`search_asset` /
  `insert_asset` (replaced `search_creator_store` / `insert_from_creator_store`)**,
  `store_image`, `upload_image`, `subagent`, `skill`, `http_get`, `list_roblox_studios`.
  `run_script_in_play_mode` (announced Feb 2026) is **not** in the current catalog.
- *Verified behaviors* that shaped the design:
  - The proxy answers `tools/list` instantly but Studio attaches over a websocket it
    retries every ~5 s → cold calls see "no studio".
  - `execute_luau` returns only `tostring()` of the **first** return value; `print`
    goes to the global output; syntax errors come back as a bare
    "Failed to parse command code".
  - During play, **both `Server` and `Client` datamodels are reachable** (old blox
    prompt wrongly said client-only); `Edit` is unavailable until play stops.
  - `loadstring` works in the Edit datamodel but not in Server/Client play datamodels.
  - `require()` in the Edit datamodel caches modules: after source changes a probe
    sees stale code unless modules are loaded fresh.
  - `LogService:GetLogHistory()` gives typed (`MessageType`) timestamped logs per
    datamodel — far better than `get_console_output`'s untyped blob.
  - `Script.Source` / `ScriptEditorService:UpdateSourceAsync` are writable from
    `execute_luau`; 400 KB payloads go through fine.
  - `screen_capture` now works in edit mode too (camera override supported).
  - Studio auto-update can leave `%LOCALAPPDATA%\Roblox\mcp.bat` (and the registry
    ContentFolder its fallback uses) pointing at a deleted version dir until the next
    Studio launch → "Connection closed" for every MCP client.
- Security model: local, unauthenticated, "only connect clients you trust" (docs:
  <https://create.roblox.com/docs/studio/mcp>).

### Roblox Assistant (first-party agent)
- Apr 2026: Planning Mode (editable plan before acting), playtesting agent beta,
  mesh generation ("Roblox Studio is Going Agentic",
  <https://about.roblox.com/newsroom/2026/04/roblox-studio-going-agentic>;
  TechCrunch <https://techcrunch.com/2026/04/16/robloxs-ai-assistant-gets-new-agentic-tools-to-plan-build-and-test-games/>).
- MCP playtest subagent beta (2026-04-09,
  <https://devforum.roblox.com/t/studio-beta-studio-assistant-mcp-playtest-agent/4566767>):
  returns Pass/Fail/Inconclusive reports. Roblox's own stated limits: **false passes**,
  50-turn cap, loop detection, daily cap, no real-time reflexes; community reports UI
  navigation and camera failures. Lesson: an LLM judging its own playtest is not a test.

### Testing/automation APIs
- `StudioTestService` (plugin security): `ExecutePlayModeAsync`, `ExecuteRunModeAsync`,
  `ExecuteMultiplayerTestAsync(numPlayers, args)`, `GetTestArgs`, `EndTest`
  (<https://create.roblox.com/docs/reference/engine/classes/StudioTestService>;
  bug: `GetTestArgs` sometimes nil — <https://devforum.roblox.com/t/gettestargs-doesnt-always-get-data-from-executeplaymodeasync/4709365>).
  Not reachable through `execute_luau` today (needs a plugin); candidate for multiplayer tests.
- Open Cloud **Luau Execution API**: run Luau headlessly against a published place
  version (≤5 min/task, ≤10 concurrent; demo pipeline limited to 2/universe)
  (<https://create.roblox.com/docs/cloud/reference/features/luau-execution>,
  <https://github.com/Roblox/place-ci-cd-demo>). Needs a published place + API key;
  no Studio, no player characters. Good future CI lane for edit-context specs.

## AI products

| Product | What it actually is | Studio link | Verification loop | Take-away |
|---|---|---|---|---|
| **Lemonade.gg** | Web app + Studio plugin generating Luau/UI from prompts; "Playtest Agent" beta claims autonomous QA (claimed); moved to Gemini in early 2026 (third-party wiki); credits/subscription | Plugin sync | Playtest Agent (claimed, unverified) | Polished prosumer UX; closed; no evidence of deterministic tests |
| **ZeroScript** (OSS) | Browser extension turns free chat UIs (DeepSeek, ChatGPT, Gemini…) into a Studio agent via a local Python bridge to the **built-in Studio MCP**; v1.5.x; persistent "project memory" saved in the place | Studio MCP | Agent-driven play control | Proves the Studio MCP is the de-facto substrate; parses tool calls out of chat text (fragile per its own README) |
| **Superbullet** | Fine-tuned Roblox LLM, 1,000+ system templates (TRF), project RAG (claimed) | Plugin | not documented | Templates + retrieval matter for "complete game" scale |
| **Roblox Assistant** | First-party agent, planning mode, playtest subagent | Native | LLM-judged playtests (false passes acknowledged) | Planning + playtesting is the accepted loop |
| Community MCPs (EL4CTEO/rbx-studio-mcp 29–35 tools, bgd4141221/robloxstudio-mcp, 6xvl 96+ tools) | Plugin + MCP servers: batched undoable edits (`ChangeHistoryService`), per-peer server/client eval, multiplayer playtests, profilers | Own plugin | Tools only | Batch + undo + per-peer eval are the useful ideas |
| **rodeo** (OSS CLI) | Run Luau in any Studio mode/DOM as a process with stdout/exit codes; `--reload-requires` | Own plugin | Scripted | Confirms the stale-`require` problem; process-style execution suits agents |

Sources: <https://lemonade.gg>, <https://nilo.io/articles/lemonade-ai-for-roblox> (2026-07-30),
<https://www.trustpilot.com/review/lemonade.gg>, <https://github.com/sebattfg/ZeroScript-Free>,
<https://dev.to/sebattfg/zeroscript-140-free-ai-agent-for-roblox-studio-now-connects-to-other-mcp-servers-blender-4i32>,
<https://superbullet.ai/>, <https://docs.superbulletstudios.com/about>,
<https://devforum.roblox.com/t/open-source-studio-mcp-%E2%80%94-safe-script-edits-real-playtest-input-screenshots-batched-undo/4823085> (2026-08-21),
<https://github.com/bgd4141221/robloxstudio-mcp>, <https://github.com/rodeo-rbx/rodeo>.

## What this means for blox
1. Everyone converges on the Studio MCP as the transport; the differentiator is what
   sits **above** it. Raw tools leave the agent to solve attach races, studio ids,
   stale requires, untyped logs, play-mode state and sync — and agents get these wrong
   (see the baseline: a legacy run spent 46 turns fighting Rojo and still reported success).
2. Nobody we found ships **deterministic, repo-resident tests executed inside the
   real engine** as the completion signal; the first-party answer (an LLM playtest
   subagent) admits false passes. blox's core bet: tests + typed runtime observation
   are the ground truth; screenshots and LLM judgment are supplements for visual work.
3. Agent choice is volatile (Gemini, DeepSeek, Claude, Codex…). The capability layer
   must be agent-agnostic: MCP + CLI over one implementation.
