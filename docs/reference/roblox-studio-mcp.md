# Reference: Roblox Studio MCP Server

> **Source:** <https://create.roblox.com/docs/studio/mcp>
> (also <https://github.com/Roblox/creator-docs/blob/main/content/en-us/studio/mcp.md>)
> **Captured:** 2026-06-06. This is a local snapshot for `blox` development —
> verify against the live page before relying on details, as Roblox's tooling
> changes frequently. Tool descriptions below are compiled from the docs page and
> the "Mesh Generation, New MCP Server Tools, Screenshot Tool, and More"
> announcement (<https://devforum.roblox.com/t/assistant-updates-mesh-generation-new-mcp-server-tools-screenshot-tool-and-more/4527258>).

## What it is

The Roblox Studio MCP server lets AI coding tools interact with a live Studio
session through the Model Context Protocol (MCP). Once connected, an MCP client can
explore the DataModel, read/write scripts, run Luau, generate assets, and playtest
the experience.

## Transport & connection

- **Transport:** `stdio` (standard input/output streams). The server runs as a
  **local process**.
- **Two-layer proxy (observed 2026-06-07).** The launched process
  (`%LOCALAPPDATA%\Roblox\mcp.bat` → `StudioMCP.exe`) is a **proxy / ws_server**,
  not Studio itself. An MCP client connects to the proxy; the proxy brokers to a
  running Studio that attaches over a local websocket once MCP-server mode is
  enabled in Assistant settings. **`initialize` + `tools/list` succeed even with
  no Studio attached** — a clean handshake does NOT imply a usable Studio. With no
  Studio attached, the server logs `No studio available for proxy <uuid>` and tool
  calls return a standard `CallToolResult` with `isError: true` and text
  `"Unable to find an active Studio instance…"`. (`blox doctor` probes both layers.)
- **Connection methods:**
  - **Quick connect** for supported clients (Claude Code, Claude Desktop, Cursor,
    VS Code).
  - **JSON configuration** files.
  - **CLI commands** (OS-specific).
- **Setup:** enable the server in Studio's **Assistant settings**, configure the
  client, then restart the client.
- **Multiple Studio instances:** `list_roblox_studios` and `set_active_studio`
  select which open Studio the tools target.

### File sync (Rojo) — separate channel from MCP (observed 2026-06-07)

Editing `.luau` files on disk reaches Studio via **`rojo serve` + the Rojo Studio
plugin (Connect)** — a *different* channel from the MCP tools. Key facts:

- **`rojo sourcemap` does NOT push files.** It only writes `sourcemap.json`
  metadata and exits. blox's PreToolUse sync hook runs `rojo sourcemap`, so it
  refreshes metadata but does **not** propagate edits — the propagation is the
  running `rojo serve` + connected plugin.
- **Setup:** run `rojo serve <project>` (e.g. `rojo serve
  test-fixtures/game/default.project.json --port 34872`); in Studio click the Rojo
  plugin toolbar button → **Connect** to `localhost:34872`.
- **WSL→Windows boundary:** the Windows Studio plugin reaches WSL's `rojo serve` on
  `localhost:34872` via WSL2 localhost-forwarding; fallback host is the WSL IP
  (`hostname -I`).
- **Verified propagation:** a WSL edit to `Greeter.luau` appeared in Studio —
  `execute_luau` reading `game.ReplicatedStorage.Greeter.Source` returned the edited
  text. `.Source` is readable in the Studio MCP context.
- **`blox doctor` sync check:** `GET <serveUrl>/api/rojo` returns
  `{ sessionId, serverVersion, protocolVersion, projectName, … }`; doctor reports it
  as "SERVE REACHABLE". (This confirms serve is up, not that a plugin is connected —
  the gated live-sync test is the end-to-end connected proof.) Override the URL with
  `BLOX_ROJO_SERVE_URL`.

## Security

> "MCP clients can read and modify content in your open Roblox places. Make sure to
> only connect clients you trust."

No authentication — access control is purely trust-based. Treat as **local-only**;
never expose over a network.

## Tool surface

### Observed live surface (2026-06-07)

The tables below are compiled from the docs and predate live testing. A live
`tools/list` against `RobloxStudio` v0.1.0 returned **26 tools** whose names differ
from the docs in places. Trust this list over the tables:

```
http_get, character_navigation, search_game_tree, script_search, skill,
search_creator_store, subagent, multi_edit, get_studio_state, generate_mesh,
screen_capture, get_console_output, script_grep, wait_job_finished,
generate_procedural_model, execute_luau, user_keyboard_input, user_mouse_input,
generate_material, script_read, start_stop_play, insert_from_creator_store,
store_image, inspect_instance, list_roblox_studios, set_active_studio
```

Name corrections vs the tables: console output is **`get_console_output`** (not
`console_output`); input is **`user_keyboard_input`** / **`user_mouse_input`** (not
`keyboard_input` / `mouse_input`); there is a single generic **`subagent`** (no
`explore_subagent` / `playtest_subagent`); Luau exec is **`execute_luau` only** (no
`run_code` / `run_script_in_play_mode`). Undocumented extras seen: `http_get`,
`skill`, `get_studio_state`, `wait_job_finished`, `store_image`,
`search_creator_store`. `execute_luau`'s argument is **`code`** (a Luau string);
results come back as a standard `CallToolResult`
(`{ content: [{ type: 'text', text }], isError }`).

### Script management
| Tool | Description |
|------|-------------|
| `script_read` | Reads scripts from the game using dot-notation paths; whole script or a line range. |
| `multi_edit` | Applies multiple edits to a script; creates the script if the target doesn't exist. |
| `script_search` | Searches for scripts by name using fuzzy matching. Returns up to 10 results. |
| `script_grep` | Searches for a string pattern across all scripts. Returns up to 50 matches. |

### Asset & content generation
| Tool | Description |
|------|-------------|
| `generate_mesh` | Creates a textured 3D mesh asset from a text prompt (same API as the in-Studio feature). |
| `generate_material` | Generates custom material/texture variants from a text description. |
| `generate_procedural_model` | Creates procedural models that adapt automatically. |
| `insert_from_creator_store` | Searches the Creator Store and inserts assets, plugins, and models. |

### Data model exploration
| Tool | Description |
|------|-------------|
| `search_game_tree` | Explores the instance hierarchy as a flat JSON array; supports filtering. |
| `inspect_instance` | Returns detailed info about an instance: properties, attributes, descendants. |
| `explore_subagent` | Investigates the place in parallel and returns a compact summary. |

### Luau execution
| Tool | Description |
|------|-------------|
| `execute_luau` | Runs Luau in Studio; returns the result/printed output or an error. Can both make changes and retrieve information. **Argument: `code` (string).** Result is a standard `CallToolResult`. (There is no `run_code`; the live server exposes only `execute_luau`.) |

### Playtesting
| Tool | Description |
|------|-------------|
| `start_stop_play` | Toggles playtesting (Play/Run) on or off. |
| `run_script_in_play_mode` | Runs a script in play mode, auto-stops after it finishes or times out; returns structured output (logs, errors, duration). |
| `console_output` / `get_console_output` | Retrieves console output/logs during gameplay. |
| `screen_capture` | Captures the Studio viewport in Play mode and returns the image data (for visual verification). |
| `playtest_subagent` | Spawns a test character and runs through gameplay scenarios in its own context. |

### Input simulation
| Tool | Description |
|------|-------------|
| `character_navigation` | Moves player characters to positions or instances. |
| `keyboard_input` | Simulates key presses, holds, and text input. |
| `mouse_input` | Simulates clicks, movement, and scrolling. |

### Session management
| Tool | Description |
|------|-------------|
| `list_roblox_studios` | Lists connected Studio instances (names, IDs, status). |
| `set_active_studio` | Designates the active Studio instance for tool targeting. |

## Known limits

- `script_search`: max 10 results.
- `script_grep`: max 50 matches.

## Related Studio APIs (not part of the MCP, but relevant to `blox`)

- **StudioTestService** — lets plugins programmatically launch/automate playtests,
  jump to a specific part of the game, and run code tests.
  (<https://devforum.roblox.com/t/introducing-studiotestservice/4116257>)
- **New Studio testing APIs** for testing/automation usable from plugins or build
  pipelines.
  (<https://devforum.roblox.com/t/new-studio-testing-apis-and-assistant-improvements/4657854>)

## How `blox` uses this

See `docs/superpowers/specs/2026-06-06-blox-design.md`. Summary:

- **Read/run/playtest/assets:** via these MCP tools.
- **Script editing:** `.luau` files on disk are canonical (Rojo one-way sync);
  `multi_edit` / `script_read` are a fallback/reader for scripts not in the Rojo
  project.
- **Context:** `search_game_tree` / `inspect_instance` / `explore_subagent` provide
  the live DataModel map.
