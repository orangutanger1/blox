import type { BloxConfig } from '../config.js';
import { StudioSession } from '../studio/session.js';
import { AGENT_GUIDE } from '../agentGuide.js';
import { TOOLS, invokeTool, type ToolCtx, type ToolOutput } from '../tools/registry.js';

export interface McpContent {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

export function toCallToolResult(out: ToolOutput): { content: McpContent[]; isError?: boolean } {
  const content: McpContent[] = [{ type: 'text', text: out.text }];
  for (const img of out.images ?? []) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
  return { content, ...(out.isError ? { isError: true } : {}) };
}

export function studioSessionFor(config: BloxConfig): StudioSession {
  return new StudioSession({ match: process.env.BLOX_STUDIO || config.studio?.match });
}

// `blox mcp` — stdio MCP server exposing the blox toolset for one project.
// stdout belongs to the protocol: never console.log in here.
export async function serveMcp(config: BloxConfig): Promise<void> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const session = studioSessionFor(config);
  const ctx: ToolCtx = { session, projectPath: config.projectPath, config, agent: process.env.BLOX_AGENT_NAME || 'mcp' };
  const server = new McpServer({ name: 'blox', version: '0.1.0' }, { instructions: AGENT_GUIDE });
  for (const tool of TOOLS) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.shape }, (async (args: Record<string, unknown>) =>
      toCallToolResult(await invokeTool(tool, args ?? {}, ctx))) as never);
  }
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await session.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  transport.onclose = () => void shutdown();
  await server.connect(transport);
}
