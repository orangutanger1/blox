import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { StudioBridge, McpServerConfig } from './types.js';

// In-process fake Studio bridge for tests/dev without a live Studio.
export function createMockStudioBridge(): StudioBridge {
  const server = createSdkMcpServer({
    name: 'roblox_studio',
    version: '0.0.0',
    tools: [
      tool(
        'search_game_tree',
        'Return the (fake) DataModel tree',
        { query: z.string().optional() },
        async () => ({
          content: [
            { type: 'text' as const, text: '[mock] Workspace, ReplicatedStorage, ServerScriptService' },
          ],
        }),
      ),
      tool(
        'inspect_instance',
        'Return (fake) instance details',
        { path: z.string() },
        async ({ path }) => ({
          content: [{ type: 'text' as const, text: `[mock] instance ${path}: {}` }],
        }),
      ),
    ],
  });
  return {
    mcpServers: (): Record<string, McpServerConfig> => ({
      roblox_studio: server as unknown as McpServerConfig,
    }),
    allowedTools: () => [
      'mcp__roblox_studio__search_game_tree',
      'mcp__roblox_studio__inspect_instance',
    ],
  };
}
