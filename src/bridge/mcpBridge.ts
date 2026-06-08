import type { StudioBridge, McpServerConfig, StudioLaunch } from './types.js';

// Built-in Roblox Studio MCP server (https://create.roblox.com/docs/studio/mcp).
// stdio transport; a per-OS launcher. The standalone Rust server is deprecated.
// On WSL/Windows the launched process is a *proxy* (StudioMCP.exe) that brokers to
// a running Studio; a Windows-side cwd avoids cmd.exe's "UNC paths not supported"
// warning when spawned from a \\wsl.localhost path.
export function studioLauncher(): StudioLaunch {
  const override = process.env.BLOX_STUDIO_MCP_CMD;
  if (override) {
    const args = (process.env.BLOX_STUDIO_MCP_ARGS ?? '').split(' ').filter(Boolean);
    return { command: override, args };
  }
  if (process.platform === 'darwin') {
    return { command: '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP', args: [] };
  }
  // Windows and WSL (linux) both reach the Windows batch launcher via cmd.exe.
  const cwd = process.env.BLOX_STUDIO_MCP_CWD ?? '/mnt/c';
  return { command: 'cmd.exe', args: ['/c', '%LOCALAPPDATA%\\Roblox\\mcp.bat'], cwd };
}

// SP1b tool surface: read/search the game + run Luau + generate prototype assets.
// SP1c-d additions: start_stop_play and get_console_output (tier-2 play-testing).
// SP2-a additions: character_navigation, user_keyboard_input, user_mouse_input (input simulation).
const TOOLS = [
  'search_game_tree',
  'inspect_instance',
  'script_read',
  'script_search',
  'script_grep',
  'execute_luau',
  'start_stop_play',
  'get_console_output',
  'character_navigation',
  'user_keyboard_input',
  'user_mouse_input',
  'generate_mesh',
  'generate_material',
  'generate_procedural_model',
  'insert_from_creator_store',
];

export function createStudioMcpBridge(): StudioBridge {
  const { command, args, cwd } = studioLauncher();
  return {
    mcpServers: (): Record<string, McpServerConfig> => ({
      Roblox_Studio: { type: 'stdio', command, args, ...(cwd ? { cwd } : {}) },
    }),
    allowedTools: () => TOOLS.map((t) => `mcp__Roblox_Studio__${t}`),
  };
}
