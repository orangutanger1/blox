import type { StudioBridge, McpServerConfig } from './types.js';

// Built-in Roblox Studio MCP server (https://create.roblox.com/docs/studio/mcp).
// Transport is stdio. The launch command differs per OS; override via env.
// (The standalone Rust server `rbx-studio-mcp` is deprecated.)
function launcher(): { command: string; args: string[] } {
  const override = process.env.BLOX_STUDIO_MCP_CMD;
  if (override) {
    const args = (process.env.BLOX_STUDIO_MCP_ARGS ?? '').split(' ').filter(Boolean);
    return { command: override, args };
  }
  if (process.platform === 'darwin') {
    return { command: '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP', args: [] };
  }
  // Windows and WSL (linux) both reach the Windows batch launcher via cmd.exe.
  return { command: 'cmd.exe', args: ['/c', '%LOCALAPPDATA%\\Roblox\\mcp.bat'] };
}

// SP1b tool surface: read/search the game + run Luau + generate prototype assets.
// Out of scope: multi_edit (files are canonical via Rojo) and all tier-2/input/session tools.
const TOOLS = [
  'search_game_tree',
  'inspect_instance',
  'script_read',
  'script_search',
  'script_grep',
  'execute_luau',
  'generate_mesh',
  'generate_material',
  'generate_procedural_model',
  'insert_from_creator_store',
];

export function createStudioMcpBridge(): StudioBridge {
  const { command, args } = launcher();
  return {
    mcpServers: (): Record<string, McpServerConfig> => ({
      Roblox_Studio: { type: 'stdio', command, args },
    }),
    allowedTools: () => TOOLS.map((t) => `mcp__Roblox_Studio__${t}`),
  };
}
