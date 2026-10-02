import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { StudioBridge, McpServerConfig } from './types.js';
import { TOOLS, invokeTool, type ToolCtx } from '../tools/registry.js';
import { toCallToolResult } from '../mcp/server.js';

// The built-in runner's bridge: the same blox toolset external agents get over
// `blox mcp`, served in-process. One implementation of every Roblox operation,
// whichever agent drives it.
export function createBloxToolsBridge(ctx: ToolCtx): StudioBridge {
  const server = createSdkMcpServer({
    name: 'blox',
    version: '0.1.0',
    tools: TOOLS.map((t) =>
      tool(t.name, t.description, t.shape, async (args) => toCallToolResult(await invokeTool(t, args as Record<string, unknown>, ctx)) as never, {
        // 13 small schemas: load them up front instead of making the model
        // spend turns on ToolSearch (observed in the legacy baseline).
        alwaysLoad: true,
      }),
    ),
  });
  return {
    kind: 'blox',
    mcpServers: (): Record<string, McpServerConfig> => ({ blox: server as unknown as McpServerConfig }),
    allowedTools: () => TOOLS.map((t) => `mcp__blox__${t.name}`),
  };
}
