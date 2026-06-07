import type { StudioBridge, McpServerConfig } from './types.js';

// Real bridge → official Roblox Studio MCP server over stdio.
// The binary name/path is environment-specific; configure via env.
export function createStudioMcpBridge(): StudioBridge {
  const command = process.env.BLOX_STUDIO_MCP_CMD ?? 'rbx-studio-mcp';
  // Official server speaks MCP over stdio when launched with --stdio.
  const args = (process.env.BLOX_STUDIO_MCP_ARGS ?? '--stdio').split(' ').filter(Boolean);
  return {
    mcpServers: (): Record<string, McpServerConfig> => ({
      roblox_studio: { type: 'stdio', command, args },
    }),
    allowedTools: () => [
      'mcp__roblox_studio__search_game_tree',
      'mcp__roblox_studio__inspect_instance',
      'mcp__roblox_studio__script_read',
    ],
  };
}
