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
- **Connection methods:**
  - **Quick connect** for supported clients (Claude Code, Claude Desktop, Cursor,
    VS Code).
  - **JSON configuration** files.
  - **CLI commands** (OS-specific).
- **Setup:** enable the server in Studio's **Assistant settings**, configure the
  client, then restart the client.
- **Multiple Studio instances:** `list_roblox_studios` and `set_active_studio`
  select which open Studio the tools target.

## Security

> "MCP clients can read and modify content in your open Roblox places. Make sure to
> only connect clients you trust."

No authentication — access control is purely trust-based. Treat as **local-only**;
never expose over a network.

## Tool surface

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
| `execute_luau` / `run_code` | Runs Luau in Studio; returns the result/printed output or an error. Can both make changes and retrieve information. |

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
